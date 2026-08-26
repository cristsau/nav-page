import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSISTANT_TOOL_DEFINITIONS,
  assertAssistantToolCallAllowed,
  collectAllowedAssistantBookmarkUrls,
  executeAssistantTool,
  isAssistantBookmarkUrlAllowed,
  isExplicitAssistantCreateCommand,
  listAssistantToolDefinitions
} from '../src/lib/assistantTools.js'
import { selectAssistantBookmarkGroup } from '../src/lib/assistantAuthorization.js'

const USER_ID = '00000000-0000-4000-8000-000000000001'
const OPERATION_ID = '00000000-0000-4000-8000-000000000002'
const GROUP_ID = '00000000-0000-4000-8000-000000000003'

test('assistant registry exposes bounded read/write tools without strict provider schemas', () => {
  assert.deepEqual(
    ASSISTANT_TOOL_DEFINITIONS.map(({ name, risk }) => [name, risk]),
    [
      ['get_current_datetime', 'read'],
      ['search_workspace', 'read'],
      ['list_navigation_groups', 'read'],
      ['search_bookmarks', 'read'],
      ['create_diary', 'write'],
      ['create_memo', 'write'],
      ['create_bookmark', 'write'],
      ['create_group', 'write']
    ]
  )

  const providerTools = listAssistantToolDefinitions()
  assert.equal(providerTools.length, ASSISTANT_TOOL_DEFINITIONS.length)
  assert.equal(providerTools.every((tool) => tool.strict === false), true)
  assert.equal(providerTools.some((tool) => Object.hasOwn(tool, 'risk')), false)
  assert.equal(listAssistantToolDefinitions({ includeWrite: false }).length, 4)
  const bookmarkTool = providerTools.find((tool) => tool.name === 'create_bookmark')
  assert.equal(Object.hasOwn(bookmarkTool.parameters.properties, 'deduplicate'), false)
})

test('bookmark writes only accept an explicit user URL or a verified web source URL', () => {
  const command = '请保存 https://example.com/docs 和 linux.do/t/123，不要读取 mail@example.net'
  const allowed = collectAllowedAssistantBookmarkUrls(command, [
    { url: 'https://openai.com/research/' }
  ])
  assert.equal(allowed.has('https://example.com/docs'), true)
  assert.equal(allowed.has('https://linux.do/t/123'), true)
  assert.equal(allowed.has('https://openai.com/research/'), true)
  assert.equal(allowed.has('https://example.net/'), false)
  assert.equal(isAssistantBookmarkUrlAllowed('https://openai.com/research/', command, [
    { url: 'https://openai.com/research/' }
  ]), true)
  assert.equal(isAssistantBookmarkUrlAllowed('https://attacker.invalid/', command, [
    { url: 'https://openai.com/research/' }
  ]), false)
})

test('provider calls cannot escape the exact per-request tool allowlist', () => {
  const allowed = new Set(['get_current_datetime', 'create_diary'])
  assert.equal(
    assertAssistantToolCallAllowed('get_current_datetime', allowed, 'create_diary').risk,
    'read'
  )
  assert.equal(
    assertAssistantToolCallAllowed('create_diary', allowed, 'create_diary').risk,
    'write'
  )
  assert.throws(
    () => assertAssistantToolCallAllowed('search_workspace', allowed, 'create_diary'),
    (error) => error.code === 'assistant_tool_not_allowed'
  )
  assert.throws(
    () => assertAssistantToolCallAllowed('create_bookmark', new Set(['create_bookmark']), 'create_diary'),
    (error) => error.code === 'assistant_write_tool_not_allowed'
  )
})

test('an explicitly named existing group is honored and an unknown group is never guessed', () => {
  const groups = [
    { id: GROUP_ID, name: '工作' },
    { id: '00000000-0000-4000-8000-000000000004', name: 'AI 资料' }
  ]
  const selected = selectAssistantBookmarkGroup(groups, '查 OpenAI 并保存到工作分组')
  assert.equal(selected.explicitlyRequested, true)
  assert.equal(selected.group?.id, GROUP_ID)

  const unknown = selectAssistantBookmarkGroup(groups, '查 OpenAI 并保存到不存在分组')
  assert.equal(unknown.explicitlyRequested, true)
  assert.equal(unknown.group, null)

  const unspecified = selectAssistantBookmarkGroup(groups, '查 OpenAI 并保存到导航页')
  assert.equal(unspecified.explicitlyRequested, false)
  assert.equal(unspecified.group, null)
})

test('get_current_datetime is deterministic, user-bound and returns no receipt', async () => {
  const output = await executeAssistantTool({
    user: { id: USER_ID },
    toolName: 'get_current_datetime',
    args: { timeZone: 'Asia/Shanghai' },
    now: () => new Date('2026-08-26T01:02:03.000Z')
  })

  assert.deepEqual(output, {
    result: {
      timeZone: 'Asia/Shanghai',
      date: '2026-08-26',
      time: '09:02:03',
      weekday: 'Wednesday',
      instant: '2026-08-26T01:02:03.000Z'
    },
    receipt: null
  })
})

test('read tools derive ownership from the authenticated user', async () => {
  const calls = []
  const queryFn = async (sql, values) => {
    calls.push({ sql, values })
    return { rows: [] }
  }

  const output = await executeAssistantTool({
    user: { id: USER_ID },
    toolName: 'list_navigation_groups',
    args: { includeCounts: true },
    queryFn
  })

  assert.deepEqual(output, { result: { groups: [] }, receipt: null })
  assert.deepEqual(calls[0].values, [USER_ID])
  assert.match(calls[0].sql, /WHERE g\.user_id = \$1/)
})

test('create tools require an explicit current command or confirmation', async () => {
  await assert.rejects(
    executeAssistantTool({
      user: { id: USER_ID },
      toolName: 'create_diary',
      args: {
        title: '今天',
        content: '完成测试',
        entryDate: '2026-08-26'
      },
      commandText: '请告诉我今天发生了什么',
      operationId: OPERATION_ID
    }),
    (error) => error.code === 'assistant_tool_confirmation_required'
  )

  assert.equal(isExplicitAssistantCreateCommand('帮我创建今天的日记', 'create_diary'), true)
  assert.equal(isExplicitAssistantCreateCommand('查找今天的日记', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('不要创建今天的日记', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('我刚才创建了今天的日记', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('我想知道怎么创建日记', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('请告诉我如何创建书签', 'create_bookmark'), false)
  assert.equal(isExplicitAssistantCreateCommand('创建日记需要什么', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('教我一下怎样新建分组', 'create_group'), false)
  assert.equal(isExplicitAssistantCreateCommand('how do I create a diary?', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('show me how to save a bookmark', 'create_bookmark'), false)
  assert.equal(isExplicitAssistantCreateCommand('请说明创建日记功能', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('请解释创建日记是什么意思', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('创建日记会发生什么？', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('能不能创建日记？', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('Please explain create diary', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('Please explain how create diary', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('可以帮我创建今天的日记吗', 'create_diary'), true)
  assert.equal(isExplicitAssistantCreateCommand('请创建今天的日记', 'create_diary'), true)
  assert.equal(isExplicitAssistantCreateCommand('你能创建日记吗？', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('请问你能创建日记吗？', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('现在系统会自动创建日记吗？', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('系统是不是会自动创建日记吧', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('我想确认这个应用会保存书签吗', 'create_bookmark'), false)
  assert.equal(isExplicitAssistantCreateCommand('帮我判断这个系统会创建日记吗', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('把“创建日记”翻译成英文', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('把"创建日记"翻译成英文', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('请改写“创建一个日记”', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('请总结“创建日记”这句话', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('解释一下“创建日记”', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('请举例说明创建日记', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('给我一个创建日记的示例', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('请给一个创建日记的例子', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('请以“创建日记”为例造句', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('帮我引用创建日记这句话', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('Translate "create a diary" into Chinese', 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand("Please explain 'create a diary'", 'create_diary'), false)
  assert.equal(isExplicitAssistantCreateCommand('创建今天的日记吧', 'create_diary'), true)
  assert.equal(isExplicitAssistantCreateCommand('现在请帮我创建今天的日记', 'create_diary'), true)
  assert.equal(isExplicitAssistantCreateCommand('把今天的工作总结写成日记并保存', 'create_diary'), true)
  assert.equal(isExplicitAssistantCreateCommand('把这个网址保存到导航', 'create_bookmark'), true)
  assert.equal(isExplicitAssistantCreateCommand('帮我把网页保存到工作分组', 'create_bookmark'), true)
  assert.equal(isExplicitAssistantCreateCommand('帮我把网页保存到工作分组', 'create_group'), false)
  assert.equal(isExplicitAssistantCreateCommand('把这个书签添加到收藏分组', 'create_bookmark'), true)
  assert.equal(isExplicitAssistantCreateCommand('把这个书签添加到收藏分组', 'create_group'), false)
  assert.equal(isExplicitAssistantCreateCommand('帮我新建一个收藏分组', 'create_group'), true)
  assert.equal(isExplicitAssistantCreateCommand('create a bookmark for this page', 'create_bookmark'), true)
})

test('write execution passes normalized arguments and user-bound idempotency metadata', async () => {
  let captured = null
  const operationRunner = async (options) => {
    captured = options
    return {
      result: { note: { id: 'resource' } },
      receipt: {
        id: options.operationId,
        operationId: options.operationId,
        tool: options.toolName,
        status: 'succeeded',
        summary: { created: true, deduplicated: false },
        resourceType: 'note',
        resourceId: '00000000-0000-4000-8000-000000000004',
        href: '/whisper?note=00000000-0000-4000-8000-000000000004',
        createdAt: '2026-08-26T01:02:03.000Z',
        undoSupported: false,
        undoUntil: null,
        replayed: false
      }
    }
  }

  const output = await executeAssistantTool({
    user: { id: USER_ID, role: 'admin' },
    toolName: 'create_diary',
    args: {
      title: ' 今日记录 ',
      content: ' 正文 ',
      entryDate: '2026-08-26',
      tags: ['工作', '工作']
    },
    commandText: '创建今天的日记并保存',
    operationId: OPERATION_ID,
    operationRunner
  })

  assert.equal(output.receipt.tool, 'create_diary')
  assert.equal(captured.userId, USER_ID)
  assert.equal(captured.operationId, OPERATION_ID)
  assert.equal(captured.authorizationMode, 'explicit_command')
  assert.deepEqual(captured.args, {
    title: '今日记录',
    content: '正文',
    entryDate: '2026-08-26',
    mood: '',
    tags: ['工作']
  })
  assert.equal(Object.hasOwn(captured.args, 'userId'), false)
})

test('create bookmark enforces owned group lookup inside the operation transaction', async () => {
  const calls = []
  const bookmarkId = '00000000-0000-4000-8000-000000000004'
  const client = {
    async query(sql, values = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim()
      calls.push({ sql: normalized, values })
      if (normalized.startsWith('SET LOCAL lock_timeout')) return { rows: [] }
      if (normalized.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [] }
      if (normalized.startsWith('SELECT id FROM nav_groups')) return { rows: [{ id: GROUP_ID }] }
      if (normalized.startsWith('SELECT * FROM nav_bookmarks')) return { rows: [] }
      if (normalized.startsWith('SELECT COALESCE(MAX(display_order)')) {
        return { rows: [{ next_order: 2 }] }
      }
      if (normalized.startsWith('INSERT INTO nav_bookmarks')) {
        return {
          rows: [{
            id: bookmarkId,
            user_id: USER_ID,
            group_id: GROUP_ID,
            title: '示例',
            url: 'https://example.com/',
            favicon: '',
            description: '',
            tags: [],
            display_order: 2,
            created_at: '2026-08-26T01:02:03.000Z',
            updated_at: '2026-08-26T01:02:03.000Z'
          }]
        }
      }
      throw new Error(`Unexpected SQL: ${normalized}`)
    }
  }

  const output = await executeAssistantTool({
    user: { id: USER_ID },
    toolName: 'create_bookmark',
    args: {
      groupId: GROUP_ID,
      title: '示例',
      url: 'example.com',
      deduplicate: false
    },
    commandText: '帮我把这个网站保存到导航',
    operationId: OPERATION_ID,
    operationRunner: async (options) => {
      const executed = await options.execute(client)
      return { result: executed.result, receipt: null }
    }
  })

  assert.equal(output.result.bookmark.id, bookmarkId)
  const ownedGroupLookup = calls.find((call) => call.sql.startsWith('SELECT id FROM nav_groups'))
  assert.deepEqual(ownedGroupLookup.values, [GROUP_ID, USER_ID])
  const insert = calls.find((call) => call.sql.startsWith('INSERT INTO nav_bookmarks'))
  assert.equal(insert.values[0], USER_ID)
  assert.equal(insert.values[2], '示例')
  assert.equal(insert.values[3], 'https://example.com/')
  assert.equal(insert.values.length > 0, true)
})

test('create bookmark cannot disable duplicate protection', async () => {
  let captured = null
  await executeAssistantTool({
    user: { id: USER_ID },
    toolName: 'create_bookmark',
    args: {
      groupId: GROUP_ID,
      title: '示例',
      url: 'https://example.com/',
      deduplicate: false
    },
    commandText: '保存 https://example.com/ 到导航',
    operationId: OPERATION_ID,
    operationRunner: async (options) => {
      captured = options.args
      return { result: {}, receipt: null }
    }
  })
  assert.equal(captured.deduplicate, true)
})

test('confirmed writes use confirmation authorization and reject unsafe arguments first', async () => {
  await assert.rejects(
    executeAssistantTool({
      user: { id: USER_ID },
      toolName: 'create_bookmark',
      args: {
        groupId: GROUP_ID,
        title: '坏地址',
        url: 'javascript:alert(1)',
        userId: USER_ID
      },
      confirmed: true,
      operationId: OPERATION_ID
    }),
    (error) => error.code === 'assistant_tool_arguments_unknown'
  )

  let authorizationMode = null
  await executeAssistantTool({
    user: { id: USER_ID },
    toolName: 'create_group',
    args: { name: '工作' },
    confirmed: true,
    operationId: OPERATION_ID,
    operationRunner: async (options) => {
      authorizationMode = options.authorizationMode
      return { result: {}, receipt: null }
    }
  })
  assert.equal(authorizationMode, 'confirmation')
})
