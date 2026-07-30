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
