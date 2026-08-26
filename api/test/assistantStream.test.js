import test from 'node:test'
import assert from 'node:assert/strict'
import { consumeAssistantSseBody } from '../../app/src/shared/services/assistantStream.js'

const encoder = new TextEncoder()

function createSseBody(...chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

test('assistant SSE rejects EOF before a done event as retryable incomplete output', async () => {
  const events = []
  await assert.rejects(
    consumeAssistantSseBody(
      createSseBody('event: delta\ndata: {"delta":"partial"}\n\n'),
      { onEvent: (event, payload) => events.push({ event, payload }) }
    ),
    /响应流不完整.*可重试/
  )
  assert.deepEqual(events, [{ event: 'delta', payload: { delta: 'partial' } }])
})

test('assistant SSE succeeds only after receiving a done event', async () => {
  const events = []
  await consumeAssistantSseBody(
    createSseBody(
      'event: delta\ndata: {"delta":"complete"}\n\n',
      'event: done\ndata: {"message":{"id":"message-1"}}\n\n'
    ),
    { onEvent: (event, payload) => events.push({ event, payload }) }
  )

  assert.deepEqual(events.map(({ event }) => event), ['delta', 'done'])
  assert.equal(events[1].payload.message.id, 'message-1')
})
