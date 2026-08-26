import { createHash } from 'node:crypto'
import { isUuid, stableJson } from './offlineMutations.js'

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{2,79}$/
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_.-]{1,63}$/
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/
const OPERATION_RISKS = new Set(['write', 'risky'])
const AUTHORIZATION_MODES = new Set(['explicit_command', 'confirmation'])
const UNDO_WINDOW_MINUTES = 10

export class AssistantToolOperationError extends Error {
  constructor(message, {
    code = 'assistant_tool_operation_error',
    statusCode = 400,
    details = null
  } = {}) {
    super(message)
    this.name = 'AssistantToolOperationError'
    this.code = code
    this.statusCode = statusCode
    this.details = details
  }
}

function normalizeText(value) {
  return String(value ?? '').trim()
}

function normalizeErrorCode(error) {
  const candidate = normalizeText(error?.code).toLowerCase()
  if (ERROR_CODE_PATTERN.test(candidate)) return candidate
  return 'assistant_tool_execution_failed'
}

function normalizeBooleanSummary(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {}
  return {
    created: Boolean(source.created),
    deduplicated: Boolean(source.deduplicated)
  }
}

function validateOperationInput({
  userId,
  operationId,
  conversationId,
  messageId,
  toolName,
  toolVersion,
  risk,
  authorizationMode
}) {
  if (!isUuid(userId)) {
    throw new AssistantToolOperationError('Authenticated user id is invalid', {
      code: 'assistant_tool_user_invalid',
      statusCode: 401
    })
  }
  if (!isUuid(operationId)) {
    throw new AssistantToolOperationError('A valid operation id is required', {
      code: 'assistant_tool_operation_id_invalid'
    })
  }
  if (conversationId && !isUuid(conversationId)) {
    throw new AssistantToolOperationError('Conversation id is invalid', {
      code: 'assistant_tool_conversation_invalid'
    })
  }
  if (messageId && !isUuid(messageId)) {
    throw new AssistantToolOperationError('Message id is invalid', {
      code: 'assistant_tool_message_invalid'
    })
  }
  if (!TOOL_NAME_PATTERN.test(toolName)) {
    throw new AssistantToolOperationError('Tool name is invalid', {
      code: 'assistant_tool_name_invalid'
    })
  }
  if (!Number.isSafeInteger(toolVersion) || toolVersion < 1 || toolVersion > 32767) {
    throw new AssistantToolOperationError('Tool version is invalid', {
      code: 'assistant_tool_version_invalid'
    })
  }
  if (!OPERATION_RISKS.has(risk)) {
    throw new AssistantToolOperationError('Only write tools create operation receipts', {
      code: 'assistant_tool_risk_invalid'
    })
  }
  if (!AUTHORIZATION_MODES.has(authorizationMode)) {
    throw new AssistantToolOperationError('Tool authorization mode is invalid', {
      code: 'assistant_tool_authorization_invalid'
    })
  }
}

async function requireOwnedConversationAndMessage(client, {
  userId,
  conversationId,
  messageId
}) {
  if (conversationId) {
    const conversation = await client.query(
      `SELECT 1 FROM assistant_conversations WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [conversationId, userId]
    )
    if (!conversation.rows.length) {
      throw new AssistantToolOperationError('Conversation was not found', {
        code: 'assistant_tool_conversation_not_found',
        statusCode: 404
      })
    }
  }

  if (messageId) {
    const message = await client.query(
      `
        SELECT 1
        FROM assistant_messages
        WHERE id = $1
          AND user_id = $2
          AND ($3::uuid IS NULL OR conversation_id = $3)
        LIMIT 1
      `,
      [messageId, userId, conversationId || null]
    )
    if (!message.rows.length) {
      throw new AssistantToolOperationError('Assistant message was not found', {
        code: 'assistant_tool_message_not_found',
        statusCode: 404
      })
    }
  }
}

function operationConflict(message, code) {
  return new AssistantToolOperationError(message, { code, statusCode: 409 })
}

function operationRecordToReceipt(record, {
  replayed = false,
  href = null
} = {}) {
  const summary = normalizeBooleanSummary(record?.result_summary)
  const undoUntil = record?.undo_until || null
  return {
    id: record.operation_id,
    operationId: record.operation_id,
    tool: record.tool_name,
    status: record.status,
    summary,
    resourceType: record.resource_type || null,
    resourceId: record.resource_id || null,
    href: href || null,
    createdAt: record.created_at,
    undoSupported: Boolean(undoUntil && record.status === 'succeeded'),
    undoUntil,
    replayed: Boolean(replayed)
  }
}

export function hashAssistantToolArguments(toolName, toolVersion, args) {
  return createHash('sha256')
    .update(stableJson({ toolName, toolVersion, args: args || {} }))
    .digest('hex')
}

export async function executeAssistantToolOperation({
  userId,
  operationId,
  conversationId = null,
  messageId = null,
  toolName,
  toolVersion = 1,
  risk = 'write',
  authorizationMode,
  args,
  execute,
  rehydrate,
  buildHref,
  withTransactionFn = null
}) {
  validateOperationInput({
    userId,
    operationId,
    conversationId,
    messageId,
    toolName,
    toolVersion,
    risk,
    authorizationMode
  })
  if (typeof execute !== 'function') {
    throw new TypeError('execute must be a function')
  }

  const argumentsHash = hashAssistantToolArguments(toolName, toolVersion, args)
  let executionError = null
  let freshResult = null
  const transactionRunner = withTransactionFn
    || (await import('../db/index.js')).withTransaction

  const operation = await transactionRunner(async (client) => {
    await requireOwnedConversationAndMessage(client, {
      userId,
      conversationId,
      messageId
    })
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('domonav-assistant-operation-v1'), hashtext($1))`,
      [`${userId}:${operationId}`]
    )

    const existing = await client.query(
      `
        SELECT *
        FROM assistant_agent_operations
        WHERE user_id = $1 AND operation_id = $2
        FOR UPDATE
      `,
      [userId, operationId]
    )
    if (existing.rows.length) {
      const record = existing.rows[0]
      if (
        record.tool_name !== toolName
        || Number(record.tool_version) !== toolVersion
        || record.arguments_hash !== argumentsHash
      ) {
        throw operationConflict(
          'Operation id was already used with different tool arguments',
          'assistant_tool_operation_conflict'
        )
      }
      if (record.status === 'succeeded' || record.status === 'undone') {
        return { record, replayed: true }
      }
      throw operationConflict(
        'This assistant operation has already completed without a reusable result',
        'assistant_tool_operation_not_replayable'
      )
    }

    await client.query(
      `
        INSERT INTO assistant_agent_operations (
          user_id, operation_id, conversation_id, message_id,
          tool_name, tool_version, risk, authorization_mode,
          arguments_hash, status, started_at, confirmed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8::varchar(24), $9,
          'running', NOW(), CASE WHEN $8::varchar(24) = 'confirmation'::varchar(24) THEN NOW() ELSE NULL END
        )
      `,
      [
        userId,
        operationId,
        conversationId || null,
        messageId || null,
        toolName,
        toolVersion,
        risk,
        authorizationMode,
        argumentsHash
      ]
    )

    await client.query('SAVEPOINT assistant_tool_execution')
    try {
      const executed = await execute(client)
      const resourceType = normalizeText(executed?.resourceType).toLowerCase()
      const resourceId = normalizeText(executed?.resourceId).toLowerCase()
      if (!RESOURCE_TYPE_PATTERN.test(resourceType) || !isUuid(resourceId)) {
        throw new AssistantToolOperationError('Write tool did not return a valid resource', {
          code: 'assistant_tool_resource_invalid',
          statusCode: 500
        })
      }
      const summary = normalizeBooleanSummary({
        created: executed?.created,
        deduplicated: executed?.deduplicated
      })
      const undoable = Boolean(executed?.undoable && summary.created)
      freshResult = executed?.result ?? null
      const updated = await client.query(
        `
          UPDATE assistant_agent_operations
          SET status = 'succeeded',
              response_status = $3,
              resource_type = $4,
              resource_id = $5,
              result_summary = $6::jsonb,
              error_code = NULL,
              completed_at = NOW(),
              undo_until = CASE
                WHEN $7 THEN NOW() + ($8 || ' minutes')::interval
                ELSE NULL
              END,
              updated_at = NOW()
          WHERE user_id = $1 AND operation_id = $2
          RETURNING *
        `,
        [
          userId,
          operationId,
          Number(executed?.responseStatus || (summary.created ? 201 : 200)),
          resourceType,
          resourceId,
          JSON.stringify(summary),
          undoable,
          String(UNDO_WINDOW_MINUTES)
        ]
      )
      await client.query('RELEASE SAVEPOINT assistant_tool_execution')
      return { record: updated.rows[0], replayed: false }
    } catch (error) {
      executionError = error
      await client.query('ROLLBACK TO SAVEPOINT assistant_tool_execution')
      await client.query('RELEASE SAVEPOINT assistant_tool_execution')
      const errorCode = normalizeErrorCode(error)
      const responseStatus = Number(error?.statusCode || 500)
      const failed = await client.query(
        `
          UPDATE assistant_agent_operations
          SET status = 'failed',
              response_status = $3,
              error_code = $4,
              completed_at = NOW(),
              updated_at = NOW()
          WHERE user_id = $1 AND operation_id = $2
          RETURNING *
        `,
        [
          userId,
          operationId,
          Math.min(599, Math.max(400, responseStatus)),
          errorCode
        ]
      )
      return { record: failed.rows[0], replayed: false, failed: true }
    }
  })

  if (operation.failed) throw executionError

  let result = freshResult
  if (operation.replayed && typeof rehydrate === 'function') {
    result = await rehydrate({
      userId,
      resourceType: operation.record.resource_type,
      resourceId: operation.record.resource_id
    })
  }
  const href = typeof buildHref === 'function'
    ? buildHref(operation.record.resource_type, operation.record.resource_id)
    : null

  return {
    result,
    receipt: operationRecordToReceipt(operation.record, {
      replayed: operation.replayed,
      href
    })
  }
}
