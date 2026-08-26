import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

test('assistant view owns the logical operation id and reuses it for an explicit retry', async () => {
  const api = await source('../../app/src/shared/services/assistantApi.js')
  const view = await source('../../app/src/modules/assistant/AssistantView.vue')

  assert.match(api, /operationId,/)
  assert.match(api, /const requestOperationId = String\(operationId/)
  assert.match(api, /operationId: requestOperationId/)
  assert.doesNotMatch(api, /crypto\?\.randomUUID/)
  assert.match(api, /resolvedOptions\(\)\.timeZone/)

  assert.match(view, /function createAssistantOperationId\(\)/)
  assert.match(view, /const pendingSend = ref\(null\)/)
  assert.match(view, /options\?\.retry === true && pendingSend\.value/)
  assert.match(view, /operationId: createAssistantOperationId\(\)/)
  assert.match(view, /operationId,/)
  assert.match(view, /function retryLastQuestion\(\)/)
  assert.match(view, /sendQuestion\(\{ retry: true \}\)/)
  assert.match(view, /pendingSend\.value\?\.operationId === operationId/)
  assert.match(view, /本次回答未完成，可重试本次请求/)
})

test('assistant UI renders bounded tool progress and durable action receipts', async () => {
  const view = await source('../../app/src/modules/assistant/AssistantView.vue')
  assert.match(view, /event === 'agent_status'/)
  assert.match(view, /event === 'tool_start'/)
  assert.match(view, /event === 'action'/)
  assert.match(view, /assistant-actions/)
  assert.match(view, /operationId/)
  assert.match(view, /可安全创建日记、备忘录、书签和分组/)
})

test('assistant route separates clock, local, web and write execution paths', async () => {
  const route = await source('../src/routes/assistant.js')
  assert.match(route, /classifyAssistantIntent/)
  assert.match(route, /formatAssistantClockAnswer/)
  assert.match(route, /runAssistantAgentModel/)
  assert.match(route, /MAX_ASSISTANT_TOOL_CALLS = 8/)
  assert.match(route, /MAX_ASSISTANT_WRITE_CALLS = 3/)
  assert.match(route, /assistant_agent_operations/)
  assert.match(route, /本次没有执行任何写入操作/)
  assert.match(route, /availableBookmarkGroups/)
  assert.match(route, /groupId 必须从中原样选择，不得猜测/)
  assert.match(route, /isAssistantBookmarkUrlAllowed/)
  assert.match(route, /assertAssistantToolCallAllowed/)
  assert.match(route, /isExplicitAssistantCreateCommand/)
  assert.match(route, /const allowedToolNames = new Set\(tools\.map/)
  assert.match(route, /toolArgs\.deduplicate = true/)
  assert.match(route, /signal\?\.throwIfAborted\?\.\(\)/)
  assert.match(route, /`\$\{call\.name\}:write`/)
  assert.match(route, /mergeAssistantUsage\(usage, payload\?\.usage\)/)
  assert.match(route, /if \(!intent\.action\) return \[\]/)
  assert.match(route, /AND status IN \('succeeded', 'undone'\)/)
  assert.match(route, /operation_id = ANY\(\$5::uuid\[\]\)/)
  assert.match(route, /actionsByMessage\.get\(operation\.response_message_id\)/)
  assert.match(route, /SET response_message_id = \$1, updated_at = NOW\(\)/)
  assert.match(route, /AND message_id = \$4/)
  assert.doesNotMatch(route, /SET message_id = \$1, updated_at = NOW\(\)/)
  assert.match(route, /intent\.webSearch && selectedWriteTool === 'create_bookmark'[\s\S]*?MAX_ASSISTANT_WRITE_CALLS[\s\S]*?: 1/)
  assert.match(route, /selectExplicitAssistantCreateTool/)
  assert.match(route, /selectAssistantBookmarkGroup/)
  assert.match(route, /bookmarkGroupBlocked/)
})
