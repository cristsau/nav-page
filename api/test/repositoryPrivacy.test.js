import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

test('browser-local mode has no hard-coded personal administrator credentials', async () => {
  const databaseUrl = new URL('../../app/src/shared/db/database.js', import.meta.url)
  const source = await fs.readFile(fileURLToPath(databaseUrl), 'utf8')

  assert.doesNotMatch(source, /DEFAULT_ADMIN_(?:USERNAME|PASSWORD)/)
  assert.match(source, /if \(!approvedUser\)/)
  assert.match(source, /autoApproved:\s*true/)
})
