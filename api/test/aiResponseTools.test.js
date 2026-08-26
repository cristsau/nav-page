import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildChatRequest,
  buildResponseFunctionCallOutput,
  buildResponseFunctionTool,
  extractResponseFunctionCalls,
  normalizeResponseFunctionTools,
  normalizeResponseToolChoice
} from '../src/lib/aiResponses.js'

const CREATE_NOTE_TOOL = buildResponseFunctionTool({
  name: 'create_note',
  description: 'Create a note owned by the authenticated user.',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['title', 'content'],
    additionalProperties: false
  }
})

test('Responses custom function tools use strict OpenAI tool schema', () => {
  assert.deepEqual(CREATE_NOTE_TOOL, {
    type: 'function',
    name: 'create_note',
    description: 'Create a note owned by the authenticated user.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['title', 'content'],
      additionalProperties: false
    },
    strict: true
  })

  assert.throws(() => buildResponseFunctionTool({ name: 'bad tool' }), /名称格式无效/)
  assert.throws(
    () => buildResponseFunctionTool({ name: 'valid_name', parameters: { type: 'array' } }),
    /object JSON Schema/
  )
  assert.throws(
    () => normalizeResponseFunctionTools([CREATE_NOTE_TOOL, CREATE_NOTE_TOOL]),
    /名称重复/
  )
})

test('Responses requests combine built-in web search and custom functions without changing defaults', () => {
  const request = buildChatRequest(
    {
      apiMode: 'responses',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      webSearchEnabled: true
    },
    '查资料后保存',
    'system',
    'safe-user',
    {
      functionTools: [CREATE_NOTE_TOOL],
      toolChoice: 'auto'
    }
  )

  assert.deepEqual(request.body.tools, [
    { type: 'web_search' },
    CREATE_NOTE_TOOL
  ])
  assert.equal(request.body.tool_choice, 'auto')
  assert.equal(request.body.reasoning.effort, 'high')
  assert.equal(request.body.safety_identifier, 'safe-user')
  assert.equal(request.body.input, '用户搜索词：查资料后保存')
})

test('Responses function calls parse arguments and continue with function_call_output input items', () => {
  const firstPayload = {
    output: [{
      type: 'function_call',
      id: 'fc_123',
      call_id: 'call_123',
      name: 'create_note',
      arguments: '{"title":"今日记录","content":"正文"}'
    }]
  }
  const calls = extractResponseFunctionCalls(firstPayload)

  assert.deepEqual(calls, [{
    id: 'fc_123',
    callId: 'call_123',
    name: 'create_note',
    argumentsJson: '{"title":"今日记录","content":"正文"}',
    input: { title: '今日记录', content: '正文' }
  }])

  const output = buildResponseFunctionCallOutput('call_123', {
    ok: true,
    noteId: 'note-1'
  })
  const nextInput = [...firstPayload.output, output]
  const nextRequest = buildChatRequest(
    {
      apiMode: 'responses',
      model: 'gpt-5.6-sol',
      webSearchEnabled: false
    },
    '',
    'system',
    '',
    {
      functionTools: [CREATE_NOTE_TOOL],
      inputItems: nextInput
    }
  )

  assert.deepEqual(nextRequest.body.input, nextInput)
  assert.deepEqual(nextRequest.body.tools, [CREATE_NOTE_TOOL])
  assert.deepEqual(output, {
    type: 'function_call_output',
    call_id: 'call_123',
    output: '{"ok":true,"noteId":"note-1"}'
  })
})

test('malformed function arguments remain observable without being executed', () => {
  const [call] = extractResponseFunctionCalls({
    output: [{
      type: 'function_call',
      call_id: 'call_bad',
      name: 'create_note',
      arguments: '{bad-json'
    }]
  })

  assert.equal(call.input, null)
  assert.match(call.parseError, /有效 JSON/)
  assert.throws(() => buildResponseFunctionCallOutput('', {}), /调用 ID/)
})

test('tool choice validates supported modes and named functions', () => {
  assert.equal(normalizeResponseToolChoice('required'), 'required')
  assert.deepEqual(
    normalizeResponseToolChoice({ type: 'function', name: 'create_note' }),
    { type: 'function', name: 'create_note' }
  )
  assert.throws(() => normalizeResponseToolChoice('sometimes'), /选择方式无效/)
})

test('Chat Completions requests preserve compatibility and translate function tool shape', () => {
  const request = buildChatRequest(
    {
      apiMode: 'chat-completions',
      model: 'gpt-5.6-sol',
      webSearchEnabled: false
    },
    '创建笔记',
    'system',
    '',
    {
      functionTools: [CREATE_NOTE_TOOL],
      toolChoice: { type: 'function', name: 'create_note' }
    }
  )

  assert.deepEqual(request.body.tools, [{
    type: 'function',
    function: {
      name: 'create_note',
      description: CREATE_NOTE_TOOL.description,
      parameters: CREATE_NOTE_TOOL.parameters,
      strict: true
    }
  }])
  assert.deepEqual(request.body.tool_choice, {
    type: 'function',
    function: { name: 'create_note' }
  })
})
