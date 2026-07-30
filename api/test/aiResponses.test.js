import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_OPENAI_ENDPOINT,
  DEFAULT_OPENAI_MODEL,
  buildChatRequest,
  extractAiText,
  extractResponseSources,
  resolveChatApiMode,
  resolveChatEndpoint
} from '../src/lib/aiResponses.js'

test('OpenAI defaults use the Responses API and balanced model', () => {
  assert.equal(resolveChatEndpoint({}), DEFAULT_OPENAI_ENDPOINT)
  assert.equal(resolveChatApiMode({}, DEFAULT_OPENAI_ENDPOINT), 'responses')

  const request = buildChatRequest({}, '上海天气', 'system prompt', 'safe-user')
  assert.equal(request.apiMode, 'responses')
  assert.equal(request.model, DEFAULT_OPENAI_MODEL)
  assert.equal(request.body.store, false)
  assert.deepEqual(request.body.tools, [{ type: 'web_search' }])
  assert.equal(request.body.reasoning.effort, 'low')
  assert.equal(request.body.safety_identifier, 'safe-user')
})

test('legacy CLI proxy keeps Chat Completions compatibility', () => {
  const provider = {
    mode: 'proxy',
    cliProxyBaseUrl: 'https://proxy.example.com/',
    apiMode: 'chat-completions',
    model: 'custom-model'
  }
  const request = buildChatRequest(provider, 'query', 'system')

  assert.equal(request.endpoint, 'https://proxy.example.com/v1/chat/completions')
  assert.equal(request.apiMode, 'chat-completions')
  assert.equal(request.body.model, 'custom-model')
  assert.equal(request.body.messages[1].content, '用户搜索词：query')
})

test('Responses output text and URL citations are extracted and deduplicated', () => {
  const payload = {
    output: [
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: '这是回答。',
            annotations: [
              {
                type: 'url_citation',
                title: 'Example source',
                url: 'https://example.com/a'
              },
              {
                type: 'url_citation',
                title: 'Duplicate',
                url: 'https://example.com/a'
              },
              {
                type: 'url_citation',
                title: 'Unsafe',
                url: 'file:///tmp/a'
              }
            ]
          }
        ]
      }
    ]
  }

  assert.equal(extractAiText(payload), '这是回答。')
  assert.deepEqual(extractResponseSources(payload), [
    {
      title: 'Example source',
      url: 'https://example.com/a',
      description: 'AI 回答引用来源',
      source: 'example.com'
    }
  ])
})

test('web search can be disabled for Responses API providers', () => {
  const request = buildChatRequest(
    { apiMode: 'responses', webSearchEnabled: false },
    'query',
    'system'
  )
  assert.equal('tools' in request.body, false)
})
