import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('logged-out pages do not request protected custom search engines', async () => {
  const configUrl = new URL('../../app/src/shared/composables/useConfig.js', import.meta.url)
  const source = await readFile(configUrl, 'utf8')

  assert.match(
    source,
    /if \(shouldUseBackendSearchEngines\(\) && !getCurrentUserId\(\)\)/
  )
})

test('initial route authentication finishes before settings composables mount', async () => {
  const mainUrl = new URL('../../app/src/main.js', import.meta.url)
  const source = await readFile(mainUrl, 'utf8')
  const routerReadyIndex = source.indexOf('await router.isReady()')
  const mountIndex = source.indexOf("app.mount('#app')")

  assert.ok(routerReadyIndex >= 0)
  assert.ok(mountIndex > routerReadyIndex)
})

test('startup failures render a retryable fail-closed state instead of a blank page', async () => {
  const mainUrl = new URL('../../app/src/main.js', import.meta.url)
  const source = await readFile(mainUrl, 'utf8')

  assert.match(source, /bootstrapApp\(\)\.catch\(renderStartupError\)/)
  assert.match(source, /系统未载入任何账号数据/)
  assert.match(source, /window\.location\.reload\(\)/)
  assert.doesNotMatch(source, /bootstrapApp\(\)\s*$/m)
})
