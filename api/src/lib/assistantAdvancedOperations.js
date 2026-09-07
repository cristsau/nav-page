import { assertActiveAssistantTool, RETIRED_MAIL_TOOLS } from './mailboxRetirement.js'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { withTransaction, query } from '../db/index.js'
import { createEmailDraftInTransaction, getEmailDraftForUser, queueEmailDraft } from './emailDrafts.js'
import { decryptEmailPayload, encryptEmailPayload } from './emailCrypto.js'
import { normalizeUserMailPayload } from './emailUserMail.js'
import { mapBookmark, mapGroup } from './navigation.js'
import { mapNote, mapShare } from './notes.js'
import {
  mapWorkspaceDatabase,
  mapWorkspaceDatabaseProperty,
  mapWorkspaceDatabaseRow,
  assertWorkspaceDatabaseRelationTargets,
  normalizeWorkspaceDatabaseRowTitle,
  normalizeWorkspaceDatabaseRowValues,
  syncWorkspaceDatabaseRelations
} from './workspaceDatabases.js'
import { isUuid, stableJson } from './offlineMutations.js'
import { normalizeHttpUrl } from './urls.js'
import { AssistantToolOperationError } from './assistantToolOperations.js'

const PROPOSAL_TTL_MINUTES = 15
const UNDO_TTL_MINUTES = 10
const MAX_QUERY_LENGTH = 300
const MAX_RESULT_LIMIT = 20

function sensitiveOperationContext(userId, operationId) {
  return `assistant-operation:${uuid(userId, '用户 ID')}:${uuid(operationId, '操作 ID')}`
}

function redactSensitiveProposal(toolName, args, preview) {
  if (!['create_email_draft', 'send_email_draft'].includes(toolName)) {
    return { arguments: args, preview, sensitivePayload: null }
  }
  return {
    arguments: { sensitive: true },
    preview: { title: '邮件操作', sensitive: true },
    sensitivePayload: { arguments: args, preview }
  }
}

async function hydrateSensitiveOperation(row, userId, operationId) {
  if (!row?.sensitive_payload) return row
  const sensitive = await decryptEmailPayload(row.sensitive_payload, {
    context: sensitiveOperationContext(userId, operationId)
  })
  return { ...row, arguments: sensitive.arguments, preview: sensitive.preview }
}
const UUID_ARGUMENT_KEYS = Object.freeze({
  update_note: ['noteId'],
  delete_note: ['noteId'],
  update_bookmark: ['bookmarkId', 'groupId'],
  delete_bookmark: ['bookmarkId'],
  update_group: ['groupId'],
  delete_group: ['groupId'],
  create_note_share: ['noteId'],
  revoke_note_share: ['shareId'],
  create_email_draft: ['accountId'],
  send_email_draft: ['draftId'],
  create_database_row: ['databaseId'],
  update_database_row: ['databaseId', 'rowId'],
  archive_database_row: ['databaseId', 'rowId']
})

function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

const ID = { type: 'string', format: 'uuid' }
const TEXT = { type: 'string', maxLength: 200000 }
const TAGS = { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 24 }

export const ASSISTANT_ADVANCED_TOOL_DEFINITIONS = Object.freeze([
  { type: 'function', name: 'list_owned_notes', description: '按标题检索当前用户拥有的笔记候选。任何笔记修改、删除或分享前必须先调用。', strict: false, risk: 'read', parameters: objectSchema({ query: { type: 'string', maxLength: MAX_QUERY_LENGTH }, limit: { type: 'integer', minimum: 1, maximum: MAX_RESULT_LIMIT } }) },
  { type: 'function', name: 'list_owned_bookmarks', description: '按标题、网址或描述检索当前用户拥有的书签候选。任何书签修改或删除前必须先调用。', strict: false, risk: 'read', parameters: objectSchema({ query: { type: 'string', maxLength: MAX_QUERY_LENGTH }, limit: { type: 'integer', minimum: 1, maximum: MAX_RESULT_LIMIT } }) },
  { type: 'function', name: 'list_owned_shares', description: '列出当前用户拥有的笔记分享候选。撤销分享前必须先调用。', strict: false, risk: 'read', parameters: objectSchema({ noteId: ID, limit: { type: 'integer', minimum: 1, maximum: MAX_RESULT_LIMIT } }) },
  { type: 'function', name: 'list_email_accounts', description: '列出当前用户可用的邮件账户候选。创建邮件草稿前必须先调用。', strict: false, risk: 'read', parameters: objectSchema({}) },
  { type: 'function', name: 'list_email_drafts', description: '列出当前用户尚可发送的邮件草稿候选。发送草稿前必须先调用。', strict: false, risk: 'read', parameters: objectSchema({ limit: { type: 'integer', minimum: 1, maximum: MAX_RESULT_LIMIT } }) },
  { type: 'function', name: 'list_workspace_databases', description: '列出当前用户拥有的工作区数据库及其属性。数据库记录写入前必须先调用。', strict: false, risk: 'read', parameters: objectSchema({}) },
  { type: 'function', name: 'list_workspace_database_rows', description: '列出指定工作区数据库中当前用户拥有的记录候选。修改或归档记录前必须先调用。', strict: false, risk: 'read', parameters: objectSchema({ databaseId: ID, query: { type: 'string', maxLength: MAX_QUERY_LENGTH }, limit: { type: 'integer', minimum: 1, maximum: MAX_RESULT_LIMIT } }, ['databaseId']) },
  { type: 'function', name: 'update_note', description: '生成修改当前用户普通未加密笔记的确认预览；不会立即执行。', strict: false, risk: 'risky', parameters: objectSchema({ noteId: ID, title: { type: 'string', maxLength: 300 }, content: TEXT, tags: TAGS }, ['noteId']) },
  { type: 'function', name: 'delete_note', description: '生成永久删除当前用户笔记的确认预览；不会立即执行且删除不可撤销。', strict: false, risk: 'risky', parameters: objectSchema({ noteId: ID }, ['noteId']) },
  { type: 'function', name: 'update_bookmark', description: '生成修改当前用户书签的确认预览；不会立即执行。', strict: false, risk: 'risky', parameters: objectSchema({ bookmarkId: ID, groupId: ID, title: { type: 'string', maxLength: 300 }, url: { type: 'string', maxLength: 2048 }, description: { type: 'string', maxLength: 2000 }, tags: TAGS }, ['bookmarkId']) },
  { type: 'function', name: 'delete_bookmark', description: '生成删除当前用户书签的确认预览；不会立即执行。', strict: false, risk: 'risky', parameters: objectSchema({ bookmarkId: ID }, ['bookmarkId']) },
  { type: 'function', name: 'update_group', description: '生成修改当前用户导航分组的确认预览；不会立即执行。', strict: false, risk: 'risky', parameters: objectSchema({ groupId: ID, name: { type: 'string', maxLength: 80 }, icon: { type: 'string', maxLength: 32 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, ['groupId']) },
  { type: 'function', name: 'delete_group', description: '生成删除当前用户空导航分组的确认预览；不会级联删除书签。', strict: false, risk: 'risky', parameters: objectSchema({ groupId: ID }, ['groupId']) },
  { type: 'function', name: 'create_note_share', description: '生成创建公开笔记分享的确认预览；不会立即公开。', strict: false, risk: 'risky', parameters: objectSchema({ noteId: ID, expireAt: { type: ['string', 'null'] } }, ['noteId']) },
  { type: 'function', name: 'revoke_note_share', description: '生成撤销公开笔记分享的确认预览；不会立即撤销。', strict: false, risk: 'risky', parameters: objectSchema({ shareId: ID }, ['shareId']) },
  { type: 'function', name: 'create_email_draft', description: '生成保存邮件草稿的确认预览；只保存草稿，不发送。', strict: false, risk: 'risky', parameters: objectSchema({ accountId: ID, to: { type: 'array', items: { type: 'string' }, maxItems: 50 }, cc: { type: 'array', items: { type: 'string' }, maxItems: 50 }, bcc: { type: 'array', items: { type: 'string' }, maxItems: 50 }, subject: { type: 'string', maxLength: 240 }, text: { type: 'string', maxLength: 80000 } }, ['accountId', 'to', 'subject', 'text']) },
  { type: 'function', name: 'send_email_draft', description: '生成发送现有邮件草稿的确认预览；确认后进入发送队列。', strict: false, risk: 'risky', parameters: objectSchema({ draftId: ID, contentHash: { type: 'string', pattern: '^[0-9a-f]{64}$' } }, ['draftId', 'contentHash']) },
  { type: 'function', name: 'create_database_row', description: '生成在当前用户工作区数据库中新建记录的确认预览。values 的键必须来自数据库属性。', strict: false, risk: 'risky', parameters: objectSchema({ databaseId: ID, title: { type: 'string', maxLength: 500 }, values: { type: 'object' } }, ['databaseId', 'title']) },
  { type: 'function', name: 'update_database_row', description: '生成修改当前用户工作区数据库记录的确认预览。', strict: false, risk: 'risky', parameters: objectSchema({ databaseId: ID, rowId: ID, title: { type: 'string', maxLength: 500 }, values: { type: 'object' } }, ['databaseId', 'rowId']) },
  { type: 'function', name: 'archive_database_row', description: '生成归档当前用户工作区数据库记录的确认预览。', strict: false, risk: 'risky', parameters: objectSchema({ databaseId: ID, rowId: ID }, ['databaseId', 'rowId']) }
].filter((tool) => !RETIRED_MAIL_TOOLS.has(tool.name)))

const DEFINITION_BY_NAME = new Map(ASSISTANT_ADVANCED_TOOL_DEFINITIONS.map((item) => [item.name, item]))

function fail(message, code = 'assistant_advanced_operation_invalid', statusCode = 400, details = null) {
  throw new AssistantToolOperationError(message, { code, statusCode, details })
}

function text(value, label, max, { required = false } = {}) {
  const result = String(value ?? '').normalize('NFKC').trim()
  if (required && !result) fail(`${label}不能为空`, 'assistant_tool_argument_required')
  if ([...result].length > max) fail(`${label}过长`, 'assistant_tool_argument_too_long')
  return result
}

function uuid(value, label, { nullable = false } = {}) {
  if (nullable && (value === undefined || value === null || value === '')) return null
  const result = String(value || '').trim().toLowerCase()
  if (!isUuid(result)) fail(`${label}格式无效`, 'assistant_tool_uuid_invalid')
  return result
}

function exact(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('工具参数必须是对象')
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length) fail('工具参数包含不支持的字段', 'assistant_tool_arguments_unknown', 400, { fields: unknown })
}

function limit(value) {
  if (value === undefined || value === null || value === '') return 10
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_RESULT_LIMIT) fail('结果数量无效')
  return result
}

function tags(value) {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 24) fail('标签无效')
  return [...new Set(value.map((item) => text(item, '标签', 40, { required: true })))]
}

function timestamp(value, label, { nullable = true } = {}) {
  if (nullable && (value === undefined || value === null || value === '')) return null
  const parsed = new Date(String(value))
  if (Number.isNaN(parsed.getTime())) fail(`${label}无效`)
  return parsed.toISOString()
}

function normalizeArgs(toolName, value = {}) {
  assertActiveAssistantTool(toolName)
  switch (toolName) {
    case 'list_owned_notes':
    case 'list_owned_bookmarks': exact(value, ['query', 'limit']); return { query: text(value.query, '检索词', MAX_QUERY_LENGTH), limit: limit(value.limit) }
    case 'list_owned_shares': exact(value, ['noteId', 'limit']); return { noteId: uuid(value.noteId, '笔记 ID', { nullable: true }), limit: limit(value.limit) }
    case 'list_email_accounts':
    case 'list_workspace_databases': exact(value, []); return {}
    case 'list_email_drafts': exact(value, ['limit']); return { limit: limit(value.limit) }
    case 'list_workspace_database_rows': exact(value, ['databaseId', 'query', 'limit']); return { databaseId: uuid(value.databaseId, '数据库 ID'), query: text(value.query, '检索词', MAX_QUERY_LENGTH), limit: limit(value.limit) }
    case 'update_note': exact(value, ['noteId', 'title', 'content', 'tags']); return { noteId: uuid(value.noteId, '笔记 ID'), ...(value.title !== undefined ? { title: text(value.title, '标题', 300, { required: true }) } : {}), ...(value.content !== undefined ? { content: text(value.content, '正文', 200000) } : {}), ...(value.tags !== undefined ? { tags: tags(value.tags) } : {}) }
    case 'delete_note': exact(value, ['noteId']); return { noteId: uuid(value.noteId, '笔记 ID') }
    case 'update_bookmark': {
      exact(value, ['bookmarkId', 'groupId', 'title', 'url', 'description', 'tags'])
      const normalized = { bookmarkId: uuid(value.bookmarkId, '书签 ID') }
      if (value.groupId !== undefined) normalized.groupId = uuid(value.groupId, '分组 ID')
      if (value.title !== undefined) normalized.title = text(value.title, '标题', 300, { required: true })
      if (value.url !== undefined) {
        normalized.url = normalizeHttpUrl(value.url)
        if (!normalized.url) fail('网址无效')
      }
      if (value.description !== undefined) normalized.description = text(value.description, '描述', 2000)
      if (value.tags !== undefined) normalized.tags = tags(value.tags)
      return normalized
    }
    case 'delete_bookmark': exact(value, ['bookmarkId']); return { bookmarkId: uuid(value.bookmarkId, '书签 ID') }
    case 'update_group': {
      exact(value, ['groupId', 'name', 'icon', 'color'])
      const normalized = { groupId: uuid(value.groupId, '分组 ID') }
      if (value.name !== undefined) normalized.name = text(value.name, '分组名称', 80, { required: true })
      if (value.icon !== undefined) normalized.icon = text(value.icon, '图标', 32, { required: true })
      if (value.color !== undefined) {
        normalized.color = String(value.color).trim().toLowerCase()
        if (!/^#[0-9a-f]{6}$/.test(normalized.color)) fail('颜色无效')
      }
      return normalized
    }
    case 'delete_group': exact(value, ['groupId']); return { groupId: uuid(value.groupId, '分组 ID') }
    case 'create_note_share': exact(value, ['noteId', 'expireAt']); return { noteId: uuid(value.noteId, '笔记 ID'), expireAt: timestamp(value.expireAt, '过期时间') }
    case 'revoke_note_share': exact(value, ['shareId']); return { shareId: uuid(value.shareId, '分享 ID') }
    case 'create_email_draft': {
      exact(value, ['accountId', 'to', 'cc', 'bcc', 'subject', 'text'])
      return { accountId: uuid(value.accountId, '邮件账户 ID'), payload: normalizeUserMailPayload({ to: value.to, cc: value.cc, bcc: value.bcc, subject: value.subject, text: value.text }) }
    }
    case 'send_email_draft': {
      exact(value, ['draftId', 'contentHash'])
      const contentHash = String(value.contentHash || '').trim().toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(contentHash)) fail('草稿摘要无效')
      return { draftId: uuid(value.draftId, '草稿 ID'), contentHash }
    }
    case 'create_database_row': exact(value, ['databaseId', 'title', 'values']); return { databaseId: uuid(value.databaseId, '数据库 ID'), title: normalizeWorkspaceDatabaseRowTitle(value.title), values: value.values || {} }
    case 'update_database_row': exact(value, ['databaseId', 'rowId', 'title', 'values']); return { databaseId: uuid(value.databaseId, '数据库 ID'), rowId: uuid(value.rowId, '记录 ID'), ...(value.title !== undefined ? { title: normalizeWorkspaceDatabaseRowTitle(value.title) } : {}), ...(value.values !== undefined ? { values: value.values } : {}) }
    case 'archive_database_row': exact(value, ['databaseId', 'rowId']); return { databaseId: uuid(value.databaseId, '数据库 ID'), rowId: uuid(value.rowId, '记录 ID') }
    default: fail('不支持的助理高级工具', 'assistant_tool_not_found', 404)
  }
}

function like(value) { return `%${String(value || '').replace(/[\\%_]/g, (item) => `\\${item}`)}%` }

async function ownedRow(client, sql, params, message, code) {
  const result = await client.query(sql, params)
  if (!result.rows[0]) fail(message, code, 404)
  return result.rows[0]
}

async function databaseContext(client, userId, databaseId, { lock = false } = {}) {
  const database = await ownedRow(client, `SELECT * FROM workspace_databases WHERE id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`, [databaseId, userId], '工作区数据库不存在', 'assistant_database_not_found')
  const properties = (await client.query('SELECT * FROM workspace_database_properties WHERE database_id = $1 AND user_id = $2 ORDER BY display_order, created_at', [databaseId, userId])).rows.map(mapWorkspaceDatabaseProperty)
  return { database, properties }
}

export async function executeAssistantAdvancedReadTool({ userId, toolName, args = {}, queryFn = query }) {
  const normalized = normalizeArgs(toolName, args)
  if (toolName === 'list_owned_notes') {
    const rows = (await queryFn(`SELECT id,type,title,encrypted,updated_at FROM notes WHERE user_id=$1 AND ($2='' OR title ILIKE $3 ESCAPE '\\') ORDER BY updated_at DESC,id LIMIT $4`, [userId, normalized.query, like(normalized.query), normalized.limit])).rows
    return { notes: rows.map((row) => ({ id: row.id, type: row.type, title: row.title, encrypted: row.encrypted, updatedAt: row.updated_at })) }
  }
  if (toolName === 'list_owned_bookmarks') {
    const rows = (await queryFn(`SELECT b.*,g.name AS group_name FROM nav_bookmarks b JOIN nav_groups g ON g.id=b.group_id AND g.user_id=b.user_id WHERE b.user_id=$1 AND ($2='' OR b.title ILIKE $3 ESCAPE '\\' OR b.url ILIKE $3 ESCAPE '\\' OR b.description ILIKE $3 ESCAPE '\\') ORDER BY b.updated_at DESC,b.id LIMIT $4`, [userId, normalized.query, like(normalized.query), normalized.limit])).rows
    return { bookmarks: rows.map((row) => ({ ...mapBookmark(row), groupName: row.group_name })) }
  }
  if (toolName === 'list_owned_shares') {
    const rows = (await queryFn(`SELECT s.*,n.title AS note_title FROM note_shares s JOIN notes n ON n.id=s.note_id AND n.user_id=s.user_id WHERE s.user_id=$1 AND ($2::uuid IS NULL OR s.note_id=$2) ORDER BY s.created_at DESC LIMIT $3`, [userId, normalized.noteId, normalized.limit])).rows
    return { shares: rows.map((row) => ({ ...mapShare(row), noteTitle: row.note_title })) }
  }
  if (toolName === 'list_email_accounts') {
    const rows = (await queryFn(`SELECT id,source_key,label,enabled,updated_at FROM email_accounts WHERE user_id=$1 AND enabled=TRUE ORDER BY updated_at DESC,id LIMIT 20`, [userId])).rows
    return { accounts: rows.map((row) => ({ id: row.id, sourceKey: row.source_key, name: row.label })) }
  }
  if (toolName === 'list_email_drafts') {
    const rows = (await queryFn(`SELECT id,account_id,content_hash,expires_at,updated_at FROM email_drafts WHERE user_id=$1 AND status='draft' AND expires_at>NOW() ORDER BY updated_at DESC,id LIMIT $2`, [userId, normalized.limit])).rows
    const drafts = []
    for (const row of rows) {
      const draft = await getEmailDraftForUser(userId, row.id, { queryFn })
      if (!draft) continue
      drafts.push({
        id: draft.id,
        accountId: draft.accountId,
        contentHash: draft.contentHash,
        subject: draft.payload.subject,
        to: draft.payload.to,
        ccCount: draft.payload.cc.length,
        expiresAt: draft.expiresAt,
        updatedAt: draft.updatedAt
      })
    }
    return { drafts }
  }
  if (toolName === 'list_workspace_databases') {
    const rows = (await queryFn(`SELECT d.*,COUNT(r.id)::integer AS row_count FROM workspace_databases d LEFT JOIN workspace_database_rows r ON r.database_id=d.id AND r.user_id=d.user_id AND r.archived=FALSE WHERE d.user_id=$1 GROUP BY d.id ORDER BY d.updated_at DESC,d.id LIMIT 20`, [userId])).rows
    const databases = []
    for (const row of rows) {
      const properties = (await queryFn('SELECT * FROM workspace_database_properties WHERE database_id=$1 AND user_id=$2 ORDER BY display_order,created_at LIMIT 50', [row.id, userId])).rows.map(mapWorkspaceDatabaseProperty)
      databases.push({
        id: row.id,
        name: row.name,
        rowCount: Number(row.row_count || 0),
        properties: properties.map((property) => ({
          id: property.id,
          name: property.name,
          type: property.type,
          ...(property.type === 'relation' ? { targetDatabaseId: property.config.targetDatabaseId } : {}),
          ...(['select', 'multi_select', 'status'].includes(property.type)
            ? { options: (property.config.options || []).slice(0, 30).map(({ id, name }) => ({ id, name })) }
            : {})
        }))
      })
    }
    return { databases }
  }
  if (toolName === 'list_workspace_database_rows') {
    await queryFn('SELECT 1 FROM workspace_databases WHERE id=$1 AND user_id=$2', [normalized.databaseId, userId]).then((result) => { if (!result.rows[0]) fail('工作区数据库不存在', 'assistant_database_not_found', 404) })
    const rows = (await queryFn(`SELECT * FROM workspace_database_rows WHERE database_id=$1 AND user_id=$2 AND archived=FALSE AND ($3='' OR title ILIKE $4 ESCAPE '\\') ORDER BY updated_at DESC,id LIMIT $5`, [normalized.databaseId, userId, normalized.query, like(normalized.query), normalized.limit])).rows
    return { rows: rows.map(mapWorkspaceDatabaseRow) }
  }
  fail('不支持的助理读取工具', 'assistant_tool_not_found', 404)
}

function proposalHash(toolName, args) {
  return createHash('sha256').update(stableJson({ toolName, version: 1, args })).digest('hex')
}

function stateFingerprint(value) {
  return createHash('sha256').update(stableJson(value ?? null)).digest('hex')
}

async function operationPreconditionState(client, userId, toolName, args, { lock = false } = {}) {
  const lockRow = lock ? ' FOR UPDATE' : ''
  if (['update_note', 'delete_note', 'create_note_share'].includes(toolName)) {
    const result = await client.query(`SELECT * FROM notes WHERE id=$1 AND user_id=$2${lockRow}`, [args.noteId, userId])
    return result.rows[0] || null
  }
  if (['update_bookmark', 'delete_bookmark'].includes(toolName)) {
    const result = await client.query(`SELECT * FROM nav_bookmarks WHERE id=$1 AND user_id=$2${lockRow}`, [args.bookmarkId, userId])
    return result.rows[0] || null
  }
  if (['update_group', 'delete_group'].includes(toolName)) {
    const result = await client.query(`SELECT * FROM nav_groups WHERE id=$1 AND user_id=$2${lockRow}`, [args.groupId, userId])
    return result.rows[0] || null
  }
  if (toolName === 'revoke_note_share') {
    const result = await client.query(`SELECT * FROM note_shares WHERE id=$1 AND user_id=$2${lockRow}`, [args.shareId, userId])
    return result.rows[0] || null
  }
  if (toolName === 'create_email_draft') {
    const result = await client.query(`SELECT id,user_id,source_key,label,enabled,updated_at FROM email_accounts WHERE id=$1 AND user_id=$2${lock ? ' FOR UPDATE' : ''}`, [args.accountId, userId])
    return result.rows[0] || null
  }
  if (toolName === 'send_email_draft') {
    const result = await client.query(`SELECT id,user_id,account_id,content_hash,status,expires_at,updated_at FROM email_drafts WHERE id=$1 AND user_id=$2${lockRow}`, [args.draftId, userId])
    return result.rows[0] || null
  }
  if (toolName.includes('database_row')) {
    const { database, properties } = await databaseContext(client, userId, args.databaseId, { lock })
    let row = null
    if (args.rowId) {
      row = (await client.query(`SELECT * FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND user_id=$3${lockRow}`, [args.rowId, args.databaseId, userId])).rows[0] || null
    }
    return { database: { id: database.id, userId: database.user_id, name: database.name }, properties, row }
  }
  return null
}

async function assertAssistantOperationContextOwner(client, userId, conversationId, messageId) {
  if (conversationId) {
    const conversation = await client.query('SELECT 1 FROM assistant_conversations WHERE id=$1 AND user_id=$2', [conversationId, userId])
    if (!conversation.rowCount) fail('对话不属于当前用户', 'assistant_conversation_not_found', 404)
  }
  if (messageId) {
    const message = await client.query(
      `SELECT 1 FROM assistant_messages
       WHERE id=$1 AND user_id=$2 AND ($3::uuid IS NULL OR conversation_id=$3)`,
      [messageId, userId, conversationId || null]
    )
    if (!message.rowCount) fail('消息不属于当前用户对话', 'assistant_message_not_found', 404)
  }
}

function hrefFor(resourceType, resourceId) {
  if (resourceType === 'note') return `/whisper?note=${encodeURIComponent(resourceId)}`
  if (resourceType === 'bookmark' || resourceType === 'nav_group') return '/'
  if (resourceType === 'note_share') return `/whisper?note=${encodeURIComponent(resourceId)}`
  if (resourceType === 'email_draft') return `/mail?draft=${encodeURIComponent(resourceId)}`
  if (resourceType === 'workspace_database_row') return '/whisper?workspace=database'
  return null
}

export function assistantAdvancedOperationReceipt(row, payload = null, { replayed = false } = {}) {
  return {
    id: row.operation_id,
    operationId: row.operation_id,
    tool: row.tool_name,
    status: row.status,
    summary: row.result_summary || {},
    preview: payload?.preview || null,
    resourceType: row.resource_type || null,
    resourceId: row.resource_id || null,
    href: row.resource_id ? hrefFor(row.resource_type, row.resource_id) : null,
    createdAt: row.created_at,
    expiresAt: payload?.expires_at || null,
    undoSupported: Boolean(row.status === 'succeeded' && row.undo_until && new Date(row.undo_until).getTime() > Date.now()),
    undoUntil: row.undo_until || null,
    replayed
  }
}

async function prepareProposal(client, userId, toolName, args, candidateIds = [], preconditionState = null) {
  const label = toolName.replaceAll('_', ' ')
  if (toolName === 'update_note' || toolName === 'delete_note' || toolName === 'create_note_share') {
    const note = preconditionState
    if (!note) fail('笔记不存在', 'assistant_note_not_found', 404)
    if (toolName === 'update_note' && (note.encrypted || note.content_format !== 'plain')) fail('助理只能修改普通未加密文本笔记', 'assistant_note_not_editable', 409)
    if (toolName === 'create_note_share' && note.encrypted) fail('加密笔记不能公开分享', 'assistant_note_share_forbidden', 409)
    const changes = toolName === 'update_note'
      ? {
          ...(args.title !== undefined ? { title: args.title } : {}),
          ...(args.tags !== undefined ? { tags: args.tags } : {}),
          ...(args.content !== undefined ? { contentPreview: args.content.slice(0, 240) } : {})
        }
      : args
    return { preview: { title: label, target: note.title, changes, irreversible: toolName === 'delete_note', external: toolName === 'create_note_share' }, resourceType: toolName === 'create_note_share' ? 'note_share' : 'note', resourceId: note.id }
  }
  if (toolName === 'update_bookmark' || toolName === 'delete_bookmark') {
    const bookmark = preconditionState
    if (!bookmark) fail('书签不存在', 'assistant_bookmark_not_found', 404)
    if (args.groupId) await ownedRow(client, 'SELECT id FROM nav_groups WHERE id=$1 AND user_id=$2', [args.groupId, userId], '目标分组不存在', 'assistant_group_not_found')
    return { preview: { title: label, target: bookmark.title, changes: args, irreversible: toolName === 'delete_bookmark' }, resourceType: 'bookmark', resourceId: bookmark.id }
  }
  if (toolName === 'update_group' || toolName === 'delete_group') {
    const group = preconditionState
    if (!group) fail('分组不存在', 'assistant_group_not_found', 404)
    const bookmarkCount = Number((await client.query('SELECT COUNT(*)::integer AS count FROM nav_bookmarks WHERE group_id=$1 AND user_id=$2', [args.groupId, userId])).rows[0]?.count || 0)
    if (toolName === 'delete_group' && bookmarkCount > 0) fail('助理拒绝删除含书签的分组，请先移动书签', 'assistant_group_not_empty', 409)
    return { preview: { title: label, target: group.name, changes: args, irreversible: toolName === 'delete_group' }, resourceType: 'nav_group', resourceId: group.id }
  }
  if (toolName === 'revoke_note_share') {
    const share = await ownedRow(client, 'SELECT s.*,n.title AS note_title FROM note_shares s JOIN notes n ON n.id=s.note_id AND n.user_id=s.user_id WHERE s.id=$1 AND s.user_id=$2 FOR UPDATE OF s', [args.shareId, userId], '分享不存在', 'assistant_share_not_found')
    return { preview: { title: label, target: share.note_title, changes: { shareId: share.id }, external: true }, resourceType: 'note_share', resourceId: share.note_id }
  }
  if (toolName === 'create_email_draft') {
    const account = preconditionState
    if (!account?.enabled) fail('邮件账户不可用', 'assistant_email_account_not_found', 404)
    return { preview: { title: label, target: args.payload.subject, from: account.label || account.source_key, to: args.payload.to, external: false, changes: { subject: args.payload.subject, bodyPreview: args.payload.text.slice(0, 240) } }, resourceType: 'email_draft', resourceId: args.accountId }
  }
  if (toolName === 'send_email_draft') {
    const draft = await getEmailDraftForUser(userId, args.draftId, { queryFn: client.query.bind(client) })
    if (!draft || draft.status !== 'draft' || draft.contentHash !== args.contentHash) fail('邮件草稿已变化或不可发送，请重新读取候选', 'assistant_email_draft_changed', 409)
    return { preview: { title: label, target: draft.payload.subject, to: draft.payload.to, external: true, irreversible: true, changes: { bodyPreview: draft.payload.text.slice(0, 240) } }, resourceType: 'email_draft', resourceId: draft.id }
  }
  if (toolName.includes('database_row')) {
    const { database, properties, row: lockedRow } = preconditionState || {}
    if (!database) fail('工作区数据库不存在', 'assistant_database_not_found', 404)
    if (args.values !== undefined) args.values = normalizeWorkspaceDatabaseRowValues(args.values, properties)
    const row = args.rowId ? lockedRow : null
    if (args.rowId && !row) fail('数据库记录不存在', 'assistant_database_row_not_found', 404)
    const mergedValues = row && args.values !== undefined ? { ...(row.values || {}), ...args.values } : (args.values || {})
    const relations = await assertWorkspaceDatabaseRelationTargets(client, userId, row?.id || null, properties, mergedValues)
    const candidates = new Set(candidateIds.filter(isUuid).map((id) => id.toLowerCase()))
    if (relations.some((relation) => !candidates.has(relation.targetId))) {
      fail('关联记录 ID 未来自本轮当前用户候选，已拒绝执行', 'assistant_candidate_required', 409)
    }
    return { preview: { title: label, target: row?.title || args.title, database: database.name, changes: { ...(args.title !== undefined ? { title: args.title } : {}), valuePropertyIds: Object.keys(args.values || {}).slice(0, 50) }, irreversible: false }, resourceType: 'workspace_database_row', resourceId: row?.id || database.id }
  }
  fail('不支持的助理写入工具', 'assistant_tool_not_found', 404)
}

export async function proposeAssistantAdvancedOperation({ userId, operationId, conversationId, messageId, toolName, args, candidateIds = [], withTransactionFn = withTransaction }) {
  uuid(userId, '用户 ID'); uuid(operationId, '操作 ID')
  if (conversationId) uuid(conversationId, '对话 ID')
  if (messageId) uuid(messageId, '消息 ID')
  if (!DEFINITION_BY_NAME.has(toolName) || DEFINITION_BY_NAME.get(toolName).risk === 'read') fail('不是可确认的写入工具', 'assistant_tool_not_found', 404)
  const normalized = normalizeArgs(toolName, args)
  const requiredIds = (UUID_ARGUMENT_KEYS[toolName] || []).map((key) => normalized[key]).filter(Boolean)
  const candidates = new Set(candidateIds.filter(isUuid).map((id) => id.toLowerCase()))
  if (requiredIds.some((id) => !candidates.has(id))) fail('目标 ID 未来自本轮当前用户候选，已拒绝执行', 'assistant_candidate_required', 409)
  return withTransactionFn(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('domonav-assistant-operation-v2'),hashtext($1))`, [`${userId}:${operationId}`])
    await assertAssistantOperationContextOwner(client, userId, conversationId, messageId)
    const existing = await client.query('SELECT o.*,p.preview,p.sensitive_payload,p.expires_at FROM assistant_agent_operations o LEFT JOIN assistant_agent_operation_payloads p USING(user_id,operation_id) WHERE o.user_id=$1 AND o.operation_id=$2 FOR UPDATE OF o', [userId, operationId])
    const hash = proposalHash(toolName, normalized)
    if (existing.rows[0]) {
      const row = await hydrateSensitiveOperation(existing.rows[0], userId, operationId)
      if (row.tool_name !== toolName || row.arguments_hash !== hash) fail('操作 ID 已被其他参数使用', 'assistant_tool_operation_conflict', 409)
      return { receipt: assistantAdvancedOperationReceipt(row, row, { replayed: true }), result: null }
    }
    const confirmationState = await operationPreconditionState(client, userId, toolName, normalized, { lock: true })
    const prepared = await prepareProposal(client, userId, toolName, normalized, candidateIds, confirmationState)
    const confirmationFingerprint = stateFingerprint(confirmationState)
    const stored = redactSensitiveProposal(toolName, normalized, prepared.preview)
    const sensitivePayload = stored.sensitivePayload
      ? await encryptEmailPayload(stored.sensitivePayload, {
          context: sensitiveOperationContext(userId, operationId)
        })
      : null
    const publicTarget = ['create_email_draft', 'send_email_draft'].includes(toolName)
      ? '邮件操作'
      : prepared.preview.target
    const inserted = await client.query(`INSERT INTO assistant_agent_operations(user_id,operation_id,conversation_id,message_id,tool_name,tool_version,risk,authorization_mode,arguments_hash,status,result_summary) VALUES($1,$2,$3,$4,$5,1,'risky','confirmation',$6,'awaiting_confirmation',$7::jsonb) RETURNING *`, [userId, operationId, conversationId || null, messageId || null, toolName, hash, JSON.stringify({ action: toolName, target: publicTarget, pending: true })])
    const payload = await client.query(`INSERT INTO assistant_agent_operation_payloads(user_id,operation_id,arguments,preview,sensitive_payload,confirmation_fingerprint,expires_at) VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,NOW()+($7||' minutes')::interval) RETURNING *`, [userId, operationId, JSON.stringify(stored.arguments), JSON.stringify(stored.preview), sensitivePayload, confirmationFingerprint, String(PROPOSAL_TTL_MINUTES)])
    return { receipt: assistantAdvancedOperationReceipt(inserted.rows[0], { ...payload.rows[0], preview: prepared.preview }), result: { proposal: prepared.preview } }
  })
}

async function executeConfirmed(client, userId, toolName, args) {
  if (toolName === 'update_note') {
    const before = await ownedRow(client, `SELECT * FROM notes WHERE id=$1 AND user_id=$2 AND encrypted=FALSE AND content_format='plain' FOR UPDATE`, [args.noteId, userId], '笔记不存在或不可编辑', 'assistant_note_not_editable')
    const updated = await client.query(`UPDATE notes SET title=COALESCE($3,title),content=COALESCE($4,content),tags=COALESCE($5::jsonb,tags),revision=revision+1,updated_at=NOW() WHERE id=$1 AND user_id=$2 AND encrypted=FALSE AND content_format='plain' RETURNING *`, [args.noteId, userId, args.title ?? null, args.content ?? null, args.tags ? JSON.stringify(args.tags) : null])
    return { resourceType: 'note', resourceId: args.noteId, result: { note: mapNote(updated.rows[0]) }, before: { title: before.title, content: before.content, tags: before.tags }, after: updated.rows[0], undoable: true, summary: { action: toolName, target: before.title, updated: true } }
  }
  if (toolName === 'delete_note') {
    const before = await ownedRow(client, 'DELETE FROM notes WHERE id=$1 AND user_id=$2 RETURNING *', [args.noteId, userId], '笔记不存在', 'assistant_note_not_found')
    return { resourceType: 'note', resourceId: args.noteId, result: null, before: null, undoable: false, summary: { action: toolName, target: before.title, deleted: true } }
  }
  if (toolName === 'update_bookmark') {
    const before = await ownedRow(client, 'SELECT * FROM nav_bookmarks WHERE id=$1 AND user_id=$2 FOR UPDATE', [args.bookmarkId, userId], '书签不存在', 'assistant_bookmark_not_found')
    if (args.groupId) await ownedRow(client, 'SELECT id FROM nav_groups WHERE id=$1 AND user_id=$2 FOR KEY SHARE', [args.groupId, userId], '目标分组不存在', 'assistant_group_not_found')
    const updated = await client.query(`UPDATE nav_bookmarks SET group_id=COALESCE($3,group_id),title=COALESCE($4,title),url=COALESCE($5,url),description=COALESCE($6,description),tags=COALESCE($7::jsonb,tags),updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`, [args.bookmarkId, userId, args.groupId ?? null, args.title ?? null, args.url ?? null, args.description ?? null, args.tags ? JSON.stringify(args.tags) : null])
    return { resourceType: 'bookmark', resourceId: args.bookmarkId, result: { bookmark: mapBookmark(updated.rows[0]) }, before, after: updated.rows[0], undoable: true, summary: { action: toolName, target: before.title, updated: true } }
  }
  if (toolName === 'delete_bookmark') {
    const before = await ownedRow(client, 'DELETE FROM nav_bookmarks WHERE id=$1 AND user_id=$2 RETURNING *', [args.bookmarkId, userId], '书签不存在', 'assistant_bookmark_not_found')
    return { resourceType: 'bookmark', resourceId: args.bookmarkId, result: null, before, after: null, undoable: true, summary: { action: toolName, target: before.title, deleted: true } }
  }
  if (toolName === 'update_group') {
    const before = await ownedRow(client, 'SELECT * FROM nav_groups WHERE id=$1 AND user_id=$2 FOR UPDATE', [args.groupId, userId], '分组不存在', 'assistant_group_not_found')
    const updated = await client.query(`UPDATE nav_groups SET name=COALESCE($3,name),icon=COALESCE($4,icon),color=COALESCE($5,color),updated_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING *`, [args.groupId, userId, args.name ?? null, args.icon ?? null, args.color ?? null])
    return { resourceType: 'nav_group', resourceId: args.groupId, result: { group: mapGroup(updated.rows[0]) }, before, after: updated.rows[0], undoable: true, summary: { action: toolName, target: before.name, updated: true } }
  }
  if (toolName === 'delete_group') {
    const before = await ownedRow(client, `DELETE FROM nav_groups g WHERE g.id=$1 AND g.user_id=$2 AND NOT EXISTS(SELECT 1 FROM nav_bookmarks b WHERE b.group_id=g.id AND b.user_id=g.user_id) RETURNING g.*`, [args.groupId, userId], '分组不存在或不为空', 'assistant_group_not_empty')
    return { resourceType: 'nav_group', resourceId: args.groupId, result: null, before, after: null, undoable: true, summary: { action: toolName, target: before.name, deleted: true } }
  }
  if (toolName === 'create_note_share') {
    const note = await ownedRow(client, 'SELECT * FROM notes WHERE id=$1 AND user_id=$2 AND encrypted=FALSE', [args.noteId, userId], '笔记不存在或不能分享', 'assistant_note_share_forbidden')
    const code = randomBytes(18).toString('base64url')
    const row = (await client.query('INSERT INTO note_shares(user_id,note_id,code,expire_at) VALUES($1,$2,$3,$4) RETURNING *', [userId, args.noteId, code, args.expireAt])).rows[0]
    return { resourceType: 'note_share', resourceId: note.id, result: { share: mapShare(row) }, before: null, after: row, undoable: true, summary: { action: toolName, target: note.title, created: true } }
  }
  if (toolName === 'revoke_note_share') {
    const before = await ownedRow(client, 'DELETE FROM note_shares WHERE id=$1 AND user_id=$2 RETURNING *', [args.shareId, userId], '分享不存在', 'assistant_share_not_found')
    return { resourceType: 'note_share', resourceId: before.note_id, result: null, before, after: null, undoable: true, summary: { action: toolName, target: before.note_id, revoked: true } }
  }
  if (toolName === 'create_email_draft') {
    const draft = await createEmailDraftInTransaction({ userId, accountId: args.accountId, payload: args.payload }, { client })
    return { resourceType: 'email_draft', resourceId: draft.id, result: { draft }, before: null, after: draft, undoable: true, summary: { action: toolName, target: '邮件草稿', created: true } }
  }
  if (toolName === 'send_email_draft') {
    const draft = await queueEmailDraft(
      { userId, draftId: args.draftId, contentHash: args.contentHash, confirmed: true },
      { client }
    )
    return { resourceType: 'email_draft', resourceId: draft.id, result: { draft }, before: null, undoable: false, summary: { action: toolName, target: '邮件操作', queued: true, external: true } }
  }
  if (toolName === 'create_database_row') {
    const { properties } = await databaseContext(client, userId, args.databaseId, { lock: true })
    const values = normalizeWorkspaceDatabaseRowValues(args.values, properties)
    const relations = await assertWorkspaceDatabaseRelationTargets(client, userId, null, properties, values)
    const position = Number((await client.query('SELECT COALESCE(MAX(position),0)+1024 AS next FROM workspace_database_rows WHERE database_id=$1 AND user_id=$2 AND archived=FALSE', [args.databaseId, userId])).rows[0]?.next || 1024)
    const row = (await client.query('INSERT INTO workspace_database_rows(user_id,database_id,title,values,position) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING *', [userId, args.databaseId, args.title, JSON.stringify(values), position])).rows[0]
    await syncWorkspaceDatabaseRelations(client, userId, row.id, args.databaseId, relations)
    await client.query('UPDATE workspace_databases SET updated_at=NOW() WHERE id=$1 AND user_id=$2', [args.databaseId, userId])
    return { resourceType: 'workspace_database_row', resourceId: row.id, result: { row: mapWorkspaceDatabaseRow(row) }, before: null, after: row, undoable: true, summary: { action: toolName, target: row.title, created: true } }
  }
  if (toolName === 'update_database_row') {
    const { properties } = await databaseContext(client, userId, args.databaseId, { lock: true })
    const before = await ownedRow(client, 'SELECT * FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND user_id=$3 FOR UPDATE', [args.rowId, args.databaseId, userId], '数据库记录不存在', 'assistant_database_row_not_found')
    const values = normalizeWorkspaceDatabaseRowValues({ ...(before.values || {}), ...(args.values || {}) }, properties)
    const relations = await assertWorkspaceDatabaseRelationTargets(client, userId, before.id, properties, values)
    const row = (await client.query('UPDATE workspace_database_rows SET title=COALESCE($4,title),values=$5::jsonb,updated_at=NOW() WHERE id=$1 AND database_id=$2 AND user_id=$3 RETURNING *', [args.rowId, args.databaseId, userId, args.title ?? null, JSON.stringify(values)])).rows[0]
    await syncWorkspaceDatabaseRelations(client, userId, row.id, args.databaseId, relations)
    await client.query('UPDATE workspace_databases SET updated_at=NOW() WHERE id=$1 AND user_id=$2', [args.databaseId, userId])
    return { resourceType: 'workspace_database_row', resourceId: row.id, result: { row: mapWorkspaceDatabaseRow(row) }, before, after: row, undoable: true, summary: { action: toolName, target: before.title, updated: true } }
  }
  if (toolName === 'archive_database_row') {
    await databaseContext(client, userId, args.databaseId, { lock: true })
    const before = await ownedRow(client, 'SELECT * FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND user_id=$3 AND archived=FALSE FOR UPDATE', [args.rowId, args.databaseId, userId], '数据库记录不存在或已归档', 'assistant_database_row_not_found')
    const archived = (await client.query('UPDATE workspace_database_rows SET archived=TRUE,updated_at=NOW() WHERE id=$1 AND database_id=$2 AND user_id=$3 RETURNING *', [args.rowId, args.databaseId, userId])).rows[0]
    await client.query('UPDATE workspace_databases SET updated_at=NOW() WHERE id=$1 AND user_id=$2', [args.databaseId, userId])
    return { resourceType: 'workspace_database_row', resourceId: before.id, result: { row: mapWorkspaceDatabaseRow(archived) }, before, after: archived, undoable: true, summary: { action: toolName, target: before.title, archived: true } }
  }
  fail('不支持的助理写入工具', 'assistant_tool_not_found', 404)
}

async function restoreBefore(client, userId, row, payload) {
  const before = payload.before_snapshot
  const current = await currentUndoState(client, userId, row)
  if (!payload.after_fingerprint || stateFingerprint(current) !== payload.after_fingerprint) {
    fail('资源在操作后已发生变化，不能安全撤销', 'assistant_operation_resource_changed', 409)
  }
  let restored = null
  if (row.tool_name === 'create_note_share') restored = await client.query('DELETE FROM note_shares WHERE note_id=$1 AND user_id=$2 AND id=$3', [row.resource_id, userId, row.result_summary.shareId || null])
  else if (row.tool_name === 'create_email_draft') restored = await client.query(`DELETE FROM email_drafts WHERE id=$1 AND user_id=$2 AND status='draft'`, [row.resource_id, userId])
  else if (row.tool_name === 'create_database_row') restored = await client.query('DELETE FROM workspace_database_rows WHERE id=$1 AND user_id=$2', [row.resource_id, userId])
  else if (!before) fail('此操作没有安全撤销快照', 'assistant_operation_undo_unsupported', 409)
  else if (row.tool_name === 'update_note') restored = await client.query('UPDATE notes SET title=$3,content=$4,tags=$5::jsonb,revision=revision+1,updated_at=NOW() WHERE id=$1 AND user_id=$2', [row.resource_id, userId, before.title, before.content, JSON.stringify(before.tags || [])])
  else if (row.tool_name === 'update_bookmark') restored = await client.query(`UPDATE nav_bookmarks SET group_id=$3,title=$4,url=$5,favicon=$6,description=$7,tags=$8::jsonb,display_order=$9,updated_at=NOW() WHERE id=$1 AND user_id=$2`, [row.resource_id, userId, before.group_id, before.title, before.url, before.favicon, before.description, JSON.stringify(before.tags || []), before.display_order])
  else if (row.tool_name === 'delete_bookmark') restored = await client.query(`INSERT INTO nav_bookmarks(id,user_id,group_id,title,url,favicon,description,tags,display_order,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,NOW())`, [before.id, userId, before.group_id, before.title, before.url, before.favicon, before.description, JSON.stringify(before.tags || []), before.display_order, before.created_at])
  else if (row.tool_name === 'update_group') restored = await client.query('UPDATE nav_groups SET name=$3,icon=$4,color=$5,collapsed=$6,display_order=$7,updated_at=NOW() WHERE id=$1 AND user_id=$2', [row.resource_id, userId, before.name, before.icon, before.color, before.collapsed, before.display_order])
  else if (row.tool_name === 'delete_group') restored = await client.query('INSERT INTO nav_groups(id,user_id,name,icon,color,display_order,collapsed,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())', [before.id, userId, before.name, before.icon, before.color, before.display_order, before.collapsed, before.created_at])
  else if (row.tool_name === 'revoke_note_share') restored = await client.query('INSERT INTO note_shares(id,user_id,note_id,code,expire_at,view_count,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)', [before.id, userId, before.note_id, before.code, before.expire_at, before.view_count, before.created_at])
  else if (row.tool_name === 'update_database_row' || row.tool_name === 'archive_database_row') {
    restored = await client.query('UPDATE workspace_database_rows SET title=$3,values=$4::jsonb,position=$5,archived=$6,updated_at=NOW() WHERE id=$1 AND user_id=$2', [row.resource_id, userId, before.title, JSON.stringify(before.values || {}), before.position, before.archived])
    const { properties } = await databaseContext(client, userId, before.database_id)
    const relations = await assertWorkspaceDatabaseRelationTargets(client, userId, before.id, properties, before.values || {})
    await syncWorkspaceDatabaseRelations(client, userId, before.id, before.database_id, relations)
  }
  else fail('此操作不支持安全撤销', 'assistant_operation_undo_unsupported', 409)
  if (restored?.rowCount !== 1) fail('资源在操作后已发生变化，不能安全撤销', 'assistant_operation_resource_changed', 409)
  if (['create_database_row', 'update_database_row', 'archive_database_row'].includes(row.tool_name)) {
    const databaseId = row.arguments?.databaseId || before?.database_id
    await client.query('UPDATE workspace_databases SET updated_at=NOW() WHERE id=$1 AND user_id=$2', [databaseId, userId])
  }
}

async function currentUndoState(client, userId, row) {
  let result
  if (row.tool_name === 'update_note') result = await client.query('SELECT * FROM notes WHERE id=$1 AND user_id=$2 FOR UPDATE', [row.resource_id, userId])
  else if (row.tool_name === 'update_bookmark' || row.tool_name === 'delete_bookmark') result = await client.query('SELECT * FROM nav_bookmarks WHERE id=$1 AND user_id=$2 FOR UPDATE', [row.resource_id, userId])
  else if (row.tool_name === 'update_group' || row.tool_name === 'delete_group') result = await client.query('SELECT * FROM nav_groups WHERE id=$1 AND user_id=$2 FOR UPDATE', [row.resource_id, userId])
  else if (row.tool_name === 'create_note_share') result = await client.query('SELECT * FROM note_shares WHERE id=$1 AND user_id=$2 FOR UPDATE', [row.result_summary.shareId || null, userId])
  else if (row.tool_name === 'revoke_note_share') result = await client.query('SELECT * FROM note_shares WHERE id=$1 AND user_id=$2 FOR UPDATE', [row.before_snapshot?.id || null, userId])
  else if (row.tool_name === 'create_email_draft') {
    await client.query('SELECT 1 FROM email_drafts WHERE id=$1 AND user_id=$2 FOR UPDATE', [row.resource_id, userId])
    return getEmailDraftForUser(userId, row.resource_id, { queryFn: client.query.bind(client) })
  }
  else if (['create_database_row', 'update_database_row', 'archive_database_row'].includes(row.tool_name)) {
    const databaseId = row.arguments?.databaseId || row.before_snapshot?.database_id
    await ownedRow(client, 'SELECT id FROM workspace_databases WHERE id=$1 AND user_id=$2 FOR UPDATE', [databaseId, userId], '工作区数据库不存在', 'assistant_database_not_found')
    result = await client.query('SELECT * FROM workspace_database_rows WHERE id=$1 AND database_id=$2 AND user_id=$3 FOR UPDATE', [row.resource_id, databaseId, userId])
  }
  else fail('此操作不支持安全撤销', 'assistant_operation_undo_unsupported', 409)
  return result.rows[0] || null
}

export async function confirmAssistantAdvancedOperation({ userId, operationId, withTransactionFn = withTransaction, executeConfirmedFn = executeConfirmed, now = () => Date.now() }) {
  const outcome = await withTransactionFn(async (client) => {
    const selected = await client.query(`SELECT o.*,p.arguments,p.preview,p.sensitive_payload,p.before_snapshot,p.confirmation_fingerprint,p.expires_at FROM assistant_agent_operations o JOIN assistant_agent_operation_payloads p USING(user_id,operation_id) WHERE o.user_id=$1 AND o.operation_id=$2 FOR UPDATE OF o,p`, [userId, operationId])
    assertActiveAssistantTool(selected.rows[0]?.tool_name)
    const row = await hydrateSensitiveOperation(selected.rows[0], userId, operationId)
    if (!row) fail('待确认操作不存在', 'assistant_operation_not_found', 404)
    if (row.status === 'succeeded' || row.status === 'undone') return { receipt: assistantAdvancedOperationReceipt(row, row, { replayed: true }), result: null }
    if (row.status !== 'awaiting_confirmation') fail('操作当前不能确认', 'assistant_operation_state_conflict', 409)
    if (new Date(row.expires_at).getTime() <= now()) {
      const cancelled = await client.query(`UPDATE assistant_agent_operations SET status='cancelled',error_code='assistant_operation_expired',completed_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND operation_id=$2 RETURNING *`, [userId, operationId])
      return { expired: true, receipt: assistantAdvancedOperationReceipt(cancelled.rows[0], row) }
    }
    const currentPrecondition = await operationPreconditionState(client, userId, row.tool_name, row.arguments, { lock: true })
    if (!row.confirmation_fingerprint || stateFingerprint(currentPrecondition) !== row.confirmation_fingerprint) {
      fail('资源在预览后已发生变化，请重新生成确认预览', 'assistant_operation_resource_changed', 409)
    }
    await client.query(`UPDATE assistant_agent_operations SET status='running',confirmed_at=NOW(),started_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND operation_id=$2`, [userId, operationId])
    const execution = await executeConfirmedFn(client, userId, row.tool_name, row.arguments)
    const summary = { ...execution.summary }
    if (row.tool_name === 'create_note_share') summary.shareId = execution.result.share.id
    const updated = await client.query(`UPDATE assistant_agent_operations SET status='succeeded',response_status=200,resource_type=$3,resource_id=$4,result_summary=$5::jsonb,error_code=NULL,completed_at=NOW(),undo_until=CASE WHEN $6 THEN NOW()+($7||' minutes')::interval ELSE NULL END,updated_at=NOW() WHERE user_id=$1 AND operation_id=$2 RETURNING *`, [userId, operationId, execution.resourceType, execution.resourceId, JSON.stringify(summary), execution.undoable, String(UNDO_TTL_MINUTES)])
    await client.query('UPDATE assistant_agent_operation_payloads SET before_snapshot=$3::jsonb,after_fingerprint=$4,updated_at=NOW() WHERE user_id=$1 AND operation_id=$2', [userId, operationId, execution.before ? JSON.stringify(execution.before) : null, execution.undoable ? stateFingerprint(execution.after) : null])
    return { receipt: assistantAdvancedOperationReceipt(updated.rows[0], row), result: execution.result }
  })
  if (outcome?.expired) fail('确认预览已过期，请重新生成', 'assistant_operation_expired', 409, { receipt: outcome.receipt })
  return outcome
}

export async function cancelAssistantAdvancedOperation({ userId, operationId, withTransactionFn = withTransaction }) {
  return withTransactionFn(async (client) => {
    const selected = await client.query(`SELECT o.*,p.preview,p.sensitive_payload,p.expires_at FROM assistant_agent_operations o JOIN assistant_agent_operation_payloads p USING(user_id,operation_id) WHERE o.user_id=$1 AND o.operation_id=$2 FOR UPDATE OF o,p`, [userId, operationId])
    const existing = await hydrateSensitiveOperation(selected.rows[0], userId, operationId)
    if (!existing) fail('待确认操作不存在', 'assistant_operation_not_found', 404)
    if (existing.status === 'cancelled') return { receipt: assistantAdvancedOperationReceipt(existing, existing, { replayed: true }) }
    if (existing.status !== 'awaiting_confirmation') fail('待确认操作不存在或状态已变化', 'assistant_operation_state_conflict', 409)
    const updated = await client.query(`UPDATE assistant_agent_operations SET status='cancelled',error_code=NULL,completed_at=NOW(),updated_at=NOW() WHERE user_id=$1 AND operation_id=$2 AND status='awaiting_confirmation' RETURNING *`, [userId, operationId])
    return { receipt: assistantAdvancedOperationReceipt(updated.rows[0], existing) }
  })
}

export async function undoAssistantAdvancedOperation({ userId, operationId, withTransactionFn = withTransaction, restoreBeforeFn = restoreBefore, now = () => Date.now() }) {
  return withTransactionFn(async (client) => {
    const selected = await client.query(`SELECT o.*,p.arguments,p.before_snapshot,p.after_fingerprint,p.preview,p.expires_at FROM assistant_agent_operations o JOIN assistant_agent_operation_payloads p USING(user_id,operation_id) WHERE o.user_id=$1 AND o.operation_id=$2 FOR UPDATE OF o,p`, [userId, operationId])
    const row = selected.rows[0]
    if (!row) fail('操作不存在', 'assistant_operation_not_found', 404)
    if (row.status === 'undone') return { receipt: assistantAdvancedOperationReceipt(row, row, { replayed: true }) }
    if (row.status !== 'succeeded' || !row.undo_until || new Date(row.undo_until).getTime() <= now()) fail('撤销窗口已关闭或此操作不可撤销', 'assistant_operation_undo_unavailable', 409)
    await restoreBeforeFn(client, userId, row, row)
    const updated = await client.query(`UPDATE assistant_agent_operations SET status='undone',completed_at=NOW(),undo_until=NULL,updated_at=NOW() WHERE user_id=$1 AND operation_id=$2 RETURNING *`, [userId, operationId])
    return { receipt: assistantAdvancedOperationReceipt(updated.rows[0], row) }
  })
}

export function isAssistantAdvancedTool(toolName) { return DEFINITION_BY_NAME.has(String(toolName || '')) }
export function assistantAdvancedToolRisk(toolName) { return DEFINITION_BY_NAME.get(String(toolName || ''))?.risk || null }
export function normalizeAssistantAdvancedArguments(toolName, args) { return normalizeArgs(toolName, args) }
export async function hydrateAssistantAdvancedOperationReceipt(row) {
  const hydrated = await hydrateSensitiveOperation(row, row.user_id, row.operation_id)
  return assistantAdvancedOperationReceipt(hydrated, hydrated)
}
