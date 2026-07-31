import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

async function readWhisperView() {
  return fs.readFile(
    fileURLToPath(new URL('../../app/src/modules/whisper/Whisper.vue', import.meta.url)),
    'utf8'
  )
}

test('notes keep one persistent create entry with an accessible type menu', async () => {
  const source = await readWhisperView()

  assert.match(source, /aria-haspopup="menu"/)
  assert.match(source, /aria-controls="note-create-menu"/)
  assert.match(source, /role="menuitem"[\s\S]*chooseCreateNote\('memo'\)/)
  assert.match(source, /role="menuitem"[\s\S]*chooseCreateNote\('diary'\)/)
  assert.doesNotMatch(source, /fab-group|header__diary-btn/)
})

test('an empty notes workspace hides zero-only statistics and reuses the single create menu', async () => {
  const source = await readWhisperView()

  assert.match(source, /v-if="notes\.length > 0" class="overview-strip"/)
  assert.match(source, /v-else-if="notes\.length === 0" class="empty-state"/)
  assert.match(source, /新建第一条记录/)
  assert.match(source, /@click="toggleCreateMenu"[\s\S]{0,160}新建第一条记录/)
  assert.doesNotMatch(source, /新建备忘录[\s\S]*handleCreateNote\('memo'\)/)
})
