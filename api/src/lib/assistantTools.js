import { searchWorkspaceHybridForUser } from './hybridWorkspaceSearch.js'
import { mapBookmark, mapGroup } from './navigation.js'
import { acquireNavigationTransactionLock } from './navigationTransactions.js'
import { mapNote } from './notes.js'
import { normalizeHttpUrl } from './urls.js'
import {
  AssistantToolOperationError,
  executeAssistantToolOperation
} from './assistantToolOperations.js'
import { isUuid } from './offlineMutations.js'
import { isExplicitAssistantCreateCommand } from './assistantAuthorization.js'
import {
  ASSISTANT_ADVANCED_TOOL_DEFINITIONS,
  executeAssistantAdvancedReadTool,
  isAssistantAdvancedTool,
  normalizeAssistantAdvancedArguments,
  proposeAssistantAdvancedOperation
} from './assistantAdvancedOperations.js'

export { isExplicitAssistantCreateCommand } from './assistantAuthorization.js'

const MAX_TITLE_LENGTH = 300
const MAX_CONTENT_LENGTH = 200_000
const MAX_DESCRIPTION_LENGTH = 2_000
const MAX_GROUP_NAME_LENGTH = 80
const MAX_QUERY_LENGTH = 300
const MAX_TAGS = 24
const MAX_TAG_LENGTH = 40
const MAX_SEARCH_LIMIT = 20
const MAX_REMIND_BEFORE_MINUTES = 43_200
const WRITE_TOOL_NAMES = new Set([
  'create_diary',
  'create_memo',
  'create_bookmark',
  'create_group'
])

function objectSchema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false
  }
}

const TAGS_SCHEMA = {
  type: 'array',
  items: { type: 'string', minLength: 1, maxLength: MAX_TAG_LENGTH },
  maxItems: MAX_TAGS
}

const CORE_ASSISTANT_TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'get_current_datetime',
    description: '读取指定 IANA 时区的当前日期、时间和星期。涉及今天、明天或日期判断时先调用。',
    strict: false,
    risk: 'read',
    parameters: objectSchema({
      timeZone: { type: 'string', minLength: 1, maxLength: 80 }
    })
  },
  {
    type: 'function',
    name: 'search_workspace',
    description: '在当前用户自己的导航和未加密笔记中进行本地混合检索。',
    strict: false,
    risk: 'read',
    parameters: objectSchema({
      query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
      types: {
        type: 'array',
        items: { type: 'string', enum: ['bookmark', 'note', 'memo', 'diary'] },
        maxItems: 4
      },
      limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT }
    }, ['query'])
  },
  {
    type: 'function',
    name: 'list_navigation_groups',
    description: '列出当前用户自己的导航分组，可附带书签数量。',
    strict: false,
    risk: 'read',
    parameters: objectSchema({
      includeCounts: { type: 'boolean' }
    })
  },
  {
    type: 'function',
    name: 'search_bookmarks',
    description: '按标题、网址、描述或标签搜索当前用户自己的导航书签。',
    strict: false,
    risk: 'read',
    parameters: objectSchema({
      query: { type: 'string', minLength: 1, maxLength: MAX_QUERY_LENGTH },
      groupId: { type: 'string', format: 'uuid' },
      limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT }
    }, ['query'])
  },
  {
    type: 'function',
    name: 'create_diary',
    description: '为当前用户创建一篇私有日记。只有用户在当前消息中明确要求创建、记录或保存日记时才能执行。',
    strict: false,
    risk: 'write',
    parameters: objectSchema({
      title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_LENGTH },
      content: { type: 'string', maxLength: MAX_CONTENT_LENGTH },
      entryDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      mood: { type: 'string', maxLength: 40 },
      tags: TAGS_SCHEMA
    }, ['title', 'content', 'entryDate'])
  },
  {
    type: 'function',
    name: 'create_memo',
    description: '为当前用户创建一条私有备忘录，可包含到期时间和提前提醒。只有明确创建命令才能执行。',
    strict: false,
    risk: 'write',
    parameters: objectSchema({
      title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_LENGTH },
      content: { type: 'string', maxLength: MAX_CONTENT_LENGTH },
      dueAt: { type: ['string', 'null'] },
      remindBeforeMinutes: {
        type: 'integer',
        minimum: 0,
        maximum: MAX_REMIND_BEFORE_MINUTES
      },
      tags: TAGS_SCHEMA
    }, ['title', 'content'])
  },
  {
    type: 'function',
    name: 'create_bookmark',
    description: '在当前用户拥有的导航分组中创建私有书签，并始终按分组和网址去重。只有明确收藏或保存命令才能执行。',
    strict: false,
    risk: 'write',
    parameters: objectSchema({
      groupId: { type: 'string', format: 'uuid' },
      title: { type: 'string', minLength: 1, maxLength: MAX_TITLE_LENGTH },
      url: { type: 'string', minLength: 1, maxLength: 2_048 },
      description: { type: 'string', maxLength: MAX_DESCRIPTION_LENGTH },
      tags: TAGS_SCHEMA
    }, ['groupId', 'title', 'url'])
  },
  {
    type: 'function',
    name: 'create_group',
    description: '为当前用户创建一个导航分组。只有明确新建分组命令才能执行。',
    strict: false,
    risk: 'write',
    parameters: objectSchema({
      name: { type: 'string', minLength: 1, maxLength: MAX_GROUP_NAME_LENGTH },
      icon: { type: 'string', minLength: 1, maxLength: 32 },
      color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }
    }, ['name'])
  }
]

export const ASSISTANT_TOOL_DEFINITIONS = Object.freeze([
  ...CORE_ASSISTANT_TOOL_DEFINITIONS,
  ...ASSISTANT_ADVANCED_TOOL_DEFINITIONS
])

const TOOL_DEFINITION_BY_NAME = new Map(
  ASSISTANT_TOOL_DEFINITIONS.map((definition) => [definition.name, definition])
)

function fail(message, code, statusCode = 400, details = null) {
  throw new AssistantToolOperationError(message, { code, statusCode, details })
}

function normalizeText(value, {
  label,
  required = false,
  maxLength
}) {
  const text = String(value ?? '').trim()
  if (required && !text) fail(`${label}不能为空`, 'assistant_tool_argument_required')
  if ([...text].length > maxLength) {
    fail(`${label}不能超过 ${maxLength} 个字符`, 'assistant_tool_argument_too_long')
  }
  return text
}

function assertExactObject(value, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('工具参数必须是对象', 'assistant_tool_arguments_invalid')
  }
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key))
  if (unknown.length) {
    fail('工具参数包含不支持的字段', 'assistant_tool_arguments_unknown', 400, {
      fields: unknown.slice(0, 10)
    })
  }
}

function normalizeInteger(value, {
  label,
  fallback,
  min,
  max
}) {
  if (value === undefined || value === null || value === '') return fallback
  const integer = Number(value)
  if (!Number.isSafeInteger(integer) || integer < min || integer > max) {
    fail(`${label}必须是 ${min} 到 ${max} 之间的整数`, 'assistant_tool_argument_invalid')
  }
  return integer
}

function normalizeTags(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) fail('标签必须是数组', 'assistant_tool_tags_invalid')
  const tags = [...new Set(value.map((tag) => normalizeText(tag, {
    label: '标签',
    required: true,
    maxLength: MAX_TAG_LENGTH
  })))]
  if (tags.length > MAX_TAGS) {
    fail(`标签不能超过 ${MAX_TAGS} 个`, 'assistant_tool_tags_invalid')
  }
  return tags
}

function normalizeDateOnly(value) {
  const input = normalizeText(value, {
    label: '日记日期',
    required: true,
    maxLength: 10
  })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    fail('日记日期必须使用 YYYY-MM-DD', 'assistant_tool_date_invalid')
  }
  const date = new Date(`${input}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== input) {
    fail('日记日期无效', 'assistant_tool_date_invalid')
  }
  return input
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return null
  const input = normalizeText(value, {
    label: '到期时间',
    required: true,
    maxLength: 64
  })
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(input)) {
    fail('到期时间必须包含时区', 'assistant_tool_timestamp_invalid')
  }
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    fail('到期时间无效', 'assistant_tool_timestamp_invalid')
  }
  return date.toISOString()
}

function normalizeTimeZone(value) {
  const timeZone = normalizeText(value || 'Asia/Shanghai', {
    label: '时区',
    required: true,
    maxLength: 80
  })
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone }).format(new Date())
  } catch {
    fail('时区必须是有效的 IANA 时区', 'assistant_tool_timezone_invalid')
  }
  return timeZone
}

function normalizeUuid(value, label) {
  const id = String(value || '').trim().toLowerCase()
  if (!isUuid(id)) fail(`${label}格式无效`, 'assistant_tool_uuid_invalid')
  return id
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`)
}

function normalizeTypeFilters(value) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 4) {
    fail('检索类型无效', 'assistant_tool_search_types_invalid')
  }
  const allowed = new Set(['bookmark', 'note', 'memo', 'diary'])
  const types = [...new Set(value.map((item) => String(item || '').trim().toLowerCase()))]
  if (types.some((type) => !allowed.has(type))) {
    fail('检索类型无效', 'assistant_tool_search_types_invalid')
  }
  return types
}

function validateToolArguments(toolName, args) {
  if (isAssistantAdvancedTool(toolName)) {
    return normalizeAssistantAdvancedArguments(toolName, args)
  }
  switch (toolName) {
    case 'get_current_datetime': {
      assertExactObject(args, ['timeZone'])
      return { timeZone: normalizeTimeZone(args.timeZone) }
    }
    case 'search_workspace': {
      assertExactObject(args, ['query', 'types', 'limit'])
      return {
        query: normalizeText(args.query, {
          label: '检索词', required: true, maxLength: MAX_QUERY_LENGTH
        }),
        types: normalizeTypeFilters(args.types),
        limit: normalizeInteger(args.limit, {
          label: '结果数量', fallback: 8, min: 1, max: MAX_SEARCH_LIMIT
        })
      }
    }
    case 'list_navigation_groups': {
      assertExactObject(args, ['includeCounts'])
      if (args.includeCounts !== undefined && typeof args.includeCounts !== 'boolean') {
        fail('includeCounts 必须是布尔值', 'assistant_tool_argument_invalid')
      }
      return { includeCounts: args.includeCounts !== false }
    }
    case 'search_bookmarks': {
      assertExactObject(args, ['query', 'groupId', 'limit'])
      return {
        query: normalizeText(args.query, {
          label: '检索词', required: true, maxLength: MAX_QUERY_LENGTH
        }),
        groupId: args.groupId ? normalizeUuid(args.groupId, '分组 ID') : null,
        limit: normalizeInteger(args.limit, {
          label: '结果数量', fallback: 8, min: 1, max: MAX_SEARCH_LIMIT
        })
      }
    }
    case 'create_diary': {
      assertExactObject(args, ['title', 'content', 'entryDate', 'mood', 'tags'])
      return {
        title: normalizeText(args.title, {
          label: '标题', required: true, maxLength: MAX_TITLE_LENGTH
        }),
        content: normalizeText(args.content, {
          label: '正文', required: false, maxLength: MAX_CONTENT_LENGTH
        }),
        entryDate: normalizeDateOnly(args.entryDate),
        mood: normalizeText(args.mood, {
          label: '心情', required: false, maxLength: 40
        }),
        tags: normalizeTags(args.tags)
      }
    }
    case 'create_memo': {
      assertExactObject(args, ['title', 'content', 'dueAt', 'remindBeforeMinutes', 'tags'])
      const dueAt = normalizeTimestamp(args.dueAt)
      return {
        title: normalizeText(args.title, {
          label: '标题', required: true, maxLength: MAX_TITLE_LENGTH
        }),
        content: normalizeText(args.content, {
          label: '正文', required: false, maxLength: MAX_CONTENT_LENGTH
        }),
        dueAt,
        remindBeforeMinutes: dueAt
          ? normalizeInteger(args.remindBeforeMinutes, {
              label: '提前提醒分钟', fallback: 0, min: 0, max: MAX_REMIND_BEFORE_MINUTES
            })
          : 0,
        tags: normalizeTags(args.tags)
      }
    }
    case 'create_bookmark': {
      assertExactObject(args, ['groupId', 'title', 'url', 'description', 'tags', 'deduplicate'])
      const url = normalizeHttpUrl(args.url)
      if (!url) fail('书签网址必须是有效的 HTTP 或 HTTPS 地址', 'assistant_tool_url_invalid')
      return {
        groupId: normalizeUuid(args.groupId, '分组 ID'),
        title: normalizeText(args.title, {
          label: '标题', required: true, maxLength: MAX_TITLE_LENGTH
        }),
        url,
        description: normalizeText(args.description, {
          label: '描述', required: false, maxLength: MAX_DESCRIPTION_LENGTH
        }),
        tags: normalizeTags(args.tags),
        // Agent-created bookmarks are always idempotent. The model is not
        // allowed to opt out of duplicate protection.
        deduplicate: true
      }
    }
    case 'create_group': {
      assertExactObject(args, ['name', 'icon', 'color'])
      const color = normalizeText(args.color || '#3b82f6', {
        label: '颜色', required: true, maxLength: 7
      })
      if (!/^#[0-9a-f]{6}$/i.test(color)) {
        fail('颜色必须是 #RRGGBB', 'assistant_tool_color_invalid')
      }
      return {
        name: normalizeText(args.name, {
          label: '分组名称', required: true, maxLength: MAX_GROUP_NAME_LENGTH
        }),
        icon: normalizeText(args.icon || 'D', {
          label: '分组图标', required: true, maxLength: 32
        }),
        color: color.toLowerCase()
      }
    }
    default:
      fail('不支持的助理工具', 'assistant_tool_not_found', 404)
  }
}

export function collectAllowedAssistantBookmarkUrls(commandText, sourceUrls = []) {
  const allowed = new Set()
  const add = (value) => {
    const normalized = normalizeHttpUrl(value)
    if (normalized) allowed.add(normalized)
  }

  for (const source of sourceUrls) add(typeof source === 'string' ? source : source?.url)

  const command = String(commandText || '')
  for (const match of command.matchAll(/https?:\/\/[^\s<>"'`，。！？；）\]]+/giu)) {
    add(match[0])
  }
  // Also accept a domain/path that the user typed explicitly, for example
  // "保存 linux.do/t/123". Email-domain fragments are excluded by the
  // negative lookbehind.
  for (const match of command.matchAll(/(?<![@\p{L}\p{N}_-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/[^\s<>"'`，。！？；）\]]*)?)/giu)) {
    add(match[1])
  }
  return allowed
}

export function isAssistantBookmarkUrlAllowed(candidate, commandText, sourceUrls = []) {
  const normalized = normalizeHttpUrl(candidate)
  return Boolean(normalized && collectAllowedAssistantBookmarkUrls(commandText, sourceUrls).has(normalized))
}

export function assertAssistantToolCallAllowed(toolName, allowedToolNames, selectedWriteTool = '') {
  const definition = TOOL_DEFINITION_BY_NAME.get(String(toolName || ''))
  const allowed = allowedToolNames instanceof Set
    ? allowedToolNames
    : new Set(Array.isArray(allowedToolNames) ? allowedToolNames : [])
  if (!definition || !allowed.has(definition.name)) {
    fail('模型返回了本轮未授权的工具调用', 'assistant_tool_not_allowed', 403)
  }
  if (definition.risk !== 'read'
    && selectedWriteTool !== '*'
    && definition.name !== selectedWriteTool) {
    fail('模型返回了本轮未授权的写入操作', 'assistant_write_tool_not_allowed', 403)
  }
  return definition
}

function toolHref(resourceType, resourceId) {
  if (resourceType === 'note') return `/whisper?note=${encodeURIComponent(resourceId)}`
  if (resourceType === 'bookmark' || resourceType === 'nav_group') return '/'
  return null
}

async function executeGetCurrentDatetime(args, { now = () => new Date() } = {}) {
  const instant = now()
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: args.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'long'
  }).formatToParts(instant).map(({ type, value }) => [type, value]))
  return {
    timeZone: args.timeZone,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    weekday: parts.weekday,
    instant: instant.toISOString()
  }
}

async function executeSearchWorkspace(args, userId, {
  poolInstance,
  queryFn,
  logger
}) {
  const search = await searchWorkspaceHybridForUser({
    userId,
    search: args.query,
    limit: args.limit,
    poolInstance,
    queryFn,
    logger
  })
  const results = search.results.filter((item) => {
    if (!args.types.length) return true
    if (item.kind === 'bookmark') return args.types.includes('bookmark')
    if (item.kind !== 'note') return false
    if (args.types.includes('note')) return true
    if (args.types.includes('diary') && item.kindLabel === '日记') return true
    return args.types.includes('memo') && item.kindLabel === '备忘录'
  })
  return {
    query: search.query,
    mode: search.searchMode,
    total: results.length,
    results
  }
}

async function executeListGroups(args, userId, queryFn) {
  const { rows } = await queryFn(
    `
      SELECT g.*, COUNT(b.id)::integer AS bookmark_count
      FROM nav_groups AS g
      LEFT JOIN nav_bookmarks AS b
        ON b.group_id = g.id AND b.user_id = g.user_id
      WHERE g.user_id = $1
      GROUP BY g.id
      ORDER BY g.display_order ASC, g.created_at ASC
    `,
    [userId]
  )
  return {
    groups: rows.map((row) => ({
      ...mapGroup(row),
      bookmarkCount: args.includeCounts ? Number(row.bookmark_count || 0) : undefined
    }))
  }
}

async function executeSearchBookmarks(args, userId, queryFn) {
  const search = `%${escapeLike(args.query)}%`
  const { rows } = await queryFn(
    `
      SELECT *
      FROM nav_bookmarks
      WHERE user_id = $1
        AND ($2::uuid IS NULL OR group_id = $2)
        AND (
          title ILIKE $3 ESCAPE '\\'
          OR url ILIKE $3 ESCAPE '\\'
          OR description ILIKE $3 ESCAPE '\\'
          OR tags::text ILIKE $3 ESCAPE '\\'
        )
      ORDER BY updated_at DESC, id ASC
      LIMIT $4
    `,
    [userId, args.groupId, search, args.limit]
  )
  return { query: args.query, bookmarks: rows.map(mapBookmark) }
}

async function insertNote(client, userId, type, args) {
  const { rows } = await client.query(
    `
      INSERT INTO notes (
        user_id, type, title, content, content_format, content_json,
        content_json_encrypted, encrypted, password_hash, pinned, tags,
        attachments, entry_date, mood, due_at, remind_before_minutes, completed
      ) VALUES (
        $1, $2, $3, $4, 'plain', NULL, NULL, FALSE, '', FALSE, $5::jsonb,
        '[]'::jsonb, $6, $7, $8, $9, FALSE
      )
      RETURNING *
    `,
    [
      userId,
      type,
      args.title,
      args.content,
      JSON.stringify(args.tags),
      type === 'diary' ? args.entryDate : null,
      type === 'diary' ? args.mood : '',
      type === 'memo' ? args.dueAt : null,
      type === 'memo' ? args.remindBeforeMinutes : 0
    ]
  )
  return {
    result: { note: mapNote(rows[0]) },
    resourceType: 'note',
    resourceId: rows[0].id,
    created: true,
    deduplicated: false,
    undoable: false,
    responseStatus: 201
  }
}

async function insertGroup(client, userId, args) {
  await acquireNavigationTransactionLock(client, userId)
  const order = await client.query(
    `SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM nav_groups WHERE user_id = $1`,
    [userId]
  )
  const { rows } = await client.query(
    `
      INSERT INTO nav_groups (user_id, name, icon, color, display_order)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `,
    [userId, args.name, args.icon, args.color, Number(order.rows[0]?.next_order || 0)]
  )
  return {
    result: { group: mapGroup(rows[0]) },
    resourceType: 'nav_group',
    resourceId: rows[0].id,
    created: true,
    deduplicated: false,
    undoable: false,
    responseStatus: 201
  }
}

async function insertBookmark(client, userId, args) {
  await acquireNavigationTransactionLock(client, userId)
  const group = await client.query(
    `SELECT id FROM nav_groups WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [args.groupId, userId]
  )
  if (!group.rows.length) {
    fail('导航分组不存在', 'assistant_tool_group_not_found', 404)
  }
  if (args.deduplicate) {
    const existing = await client.query(
      `
        SELECT * FROM nav_bookmarks
        WHERE user_id = $1 AND group_id = $2 AND LOWER(url) = LOWER($3)
        LIMIT 1
      `,
      [userId, args.groupId, args.url]
    )
    if (existing.rows.length) {
      return {
        result: { bookmark: mapBookmark(existing.rows[0]), created: false },
        resourceType: 'bookmark',
        resourceId: existing.rows[0].id,
        created: false,
        deduplicated: true,
        undoable: false,
        responseStatus: 200
      }
    }
  }
  const order = await client.query(
    `
      SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order
      FROM nav_bookmarks
      WHERE user_id = $1 AND group_id = $2
    `,
    [userId, args.groupId]
  )
  const { rows } = await client.query(
    `
      INSERT INTO nav_bookmarks (
        user_id, group_id, title, url, favicon, description, tags, display_order
      ) VALUES ($1, $2, $3, $4, '', $5, $6::jsonb, $7)
      RETURNING *
    `,
    [
      userId,
      args.groupId,
      args.title,
      args.url,
      args.description,
      JSON.stringify(args.tags),
      Number(order.rows[0]?.next_order || 0)
    ]
  )
  return {
    result: { bookmark: mapBookmark(rows[0]), created: true },
    resourceType: 'bookmark',
    resourceId: rows[0].id,
    created: true,
    deduplicated: false,
    undoable: false,
    responseStatus: 201
  }
}

async function rehydrateResource(queryFn, userId, resourceType, resourceId) {
  if (resourceType === 'note') {
    const { rows } = await queryFn(
      `SELECT * FROM notes WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [resourceId, userId]
    )
    return rows.length ? { note: mapNote(rows[0]) } : null
  }
  if (resourceType === 'nav_group') {
    const { rows } = await queryFn(
      `SELECT * FROM nav_groups WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [resourceId, userId]
    )
    return rows.length ? { group: mapGroup(rows[0]) } : null
  }
  if (resourceType === 'bookmark') {
    const { rows } = await queryFn(
      `SELECT * FROM nav_bookmarks WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [resourceId, userId]
    )
    return rows.length ? { bookmark: mapBookmark(rows[0]) } : null
  }
  return null
}

export function listAssistantToolDefinitions({ includeWrite = true } = {}) {
  return ASSISTANT_TOOL_DEFINITIONS
    .filter((definition) => includeWrite || definition.risk === 'read')
    .map(({ risk: _risk, ...definition }) => definition)
}

export async function executeAssistantTool({
  user,
  toolName,
  args = {},
  commandText = '',
  operationId = null,
  conversationId = null,
  messageId = null,
  confirmed = false,
  logger = null,
  now,
  poolInstance = null,
  queryFn = null,
  candidateIds = [],
  operationRunner = executeAssistantToolOperation
}) {
  const definition = TOOL_DEFINITION_BY_NAME.get(String(toolName || '').trim())
  if (!definition) fail('不支持的助理工具', 'assistant_tool_not_found', 404)
  const userId = normalizeUuid(user?.id, '当前用户 ID')
  const normalizedArgs = validateToolArguments(definition.name, args)
  let resolvedPool = poolInstance
  let resolvedQuery = queryFn
  const requiresQuery = definition.risk === 'read'
    && definition.name !== 'get_current_datetime'
  const requiresPool = definition.name === 'search_workspace'
  if ((requiresQuery && !resolvedQuery) || (requiresPool && !resolvedPool)) {
    const db = await import('../db/index.js')
    resolvedPool ||= db.pool
    resolvedQuery ||= db.query
  }

  if (definition.risk === 'read') {
    let result
    if (definition.name === 'get_current_datetime') {
      result = await executeGetCurrentDatetime(normalizedArgs, { now })
    } else if (definition.name === 'search_workspace') {
      result = await executeSearchWorkspace(normalizedArgs, userId, {
        poolInstance: resolvedPool,
        queryFn: resolvedQuery,
        logger
      })
    } else if (definition.name === 'list_navigation_groups') {
      result = await executeListGroups(normalizedArgs, userId, resolvedQuery)
    } else if (definition.name === 'search_bookmarks') {
      result = await executeSearchBookmarks(normalizedArgs, userId, resolvedQuery)
    } else if (isAssistantAdvancedTool(definition.name)) {
      result = await executeAssistantAdvancedReadTool({
        userId,
        toolName: definition.name,
        args: normalizedArgs,
        queryFn: resolvedQuery
      })
    }
    return { result, receipt: null }
  }

  if (isAssistantAdvancedTool(definition.name)) {
    return proposeAssistantAdvancedOperation({
      userId,
      operationId,
      conversationId,
      messageId,
      toolName: definition.name,
      args: normalizedArgs,
      candidateIds
    })
  }

  const explicit = isExplicitAssistantCreateCommand(commandText, definition.name)
  if (!confirmed && !explicit) {
    fail('这项操作需要用户在当前消息中明确要求创建，或先确认操作预览',
      'assistant_tool_confirmation_required', 409, { requiresConfirmation: true })
  }

  return operationRunner({
    userId,
    operationId,
    conversationId,
    messageId,
    toolName: definition.name,
    toolVersion: 1,
    risk: definition.risk,
    authorizationMode: confirmed ? 'confirmation' : 'explicit_command',
    args: normalizedArgs,
    execute: async (client) => {
      if (definition.name === 'create_diary') {
        return insertNote(client, userId, 'diary', normalizedArgs)
      }
      if (definition.name === 'create_memo') {
        return insertNote(client, userId, 'memo', normalizedArgs)
      }
      if (definition.name === 'create_bookmark') {
        return insertBookmark(client, userId, normalizedArgs)
      }
      if (definition.name === 'create_group') {
        return insertGroup(client, userId, normalizedArgs)
      }
      fail('不支持的写入工具', 'assistant_tool_not_found', 404)
    },
    rehydrate: async ({ resourceType, resourceId }) => {
      if (!resolvedQuery) resolvedQuery = (await import('../db/index.js')).query
      return rehydrateResource(resolvedQuery, userId, resourceType, resourceId)
    },
    buildHref: toolHref
  })
}
