import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function source(path) {
  return readFile(new URL(path, import.meta.url), 'utf8')
}

test('frontend prefers unified workspace API and keeps Dexie fallback', async () => {
  const service = await source('../../app/src/shared/services/unifiedSearchApi.js')
  assert.match(service, /\/workspace\/search/)
  assert.match(service, /searchLocalWorkspace/)
  assert.match(service, /searchLocalBookmarks/)
  assert.match(service, /searchLocalNotes/)
  assert.match(service, /服务器搜索/)
})

test('search UI exposes the personal assistant and clickable source cards', async () => {
  const [component, service] = await Promise.all([
    source('../../app/src/shared/components/SearchBox.vue'),
    source('../../app/src/shared/services/assistantApi.js')
  ])
  assert.match(component, /问助理/)
  assert.match(component, /个人资料助理/)
  assert.match(component, /站内来源/)
  assert.match(component, /sourceTarget/)
  assert.match(component, /matchReasons\.join/)
  assert.match(service, /\/assistant\/query/)
})

test('settings provides 7, 30 and 90 day AI usage with CSV export', async () => {
  const [panel, service] = await Promise.all([
    source('../../app/src/modules/settings/components/AiUsagePanel.vue'),
    source('../../app/src/shared/services/aiUsageApi.js')
  ])
  assert.match(panel, /const ranges = \[7, 30, 90\]/)
  assert.match(panel, /不会保存问题、正文或回答/)
  assert.match(panel, /估算成本/)
  assert.match(panel, /未知/)
  assert.match(service, /\/ai-usage\.csv/)
})
