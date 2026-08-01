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

async function readReminderCenter() {
  return fs.readFile(
    fileURLToPath(new URL('../../app/src/modules/whisper/components/ReminderCenter.vue', import.meta.url)),
    'utf8'
  )
}

async function readCommandPalette() {
  return fs.readFile(
    fileURLToPath(new URL('../../app/src/shared/components/CommandPalette.vue', import.meta.url)),
    'utf8'
  )
}

async function readReminderComposable() {
  return fs.readFile(
    fileURLToPath(new URL('../../app/src/shared/composables/useNoteReminders.js', import.meta.url)),
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

test('due reminders are reachable from the notes header and command palette', async () => {
  const [whisper, commands] = await Promise.all([
    readWhisperView(),
    readCommandPalette()
  ])

  assert.match(whisper, /aria-label="reminderUnreadCount \? `打开到期提醒/)
  assert.match(whisper, /<ReminderCenter[\s\S]*:unread-count="reminderUnreadCount"/)
  assert.match(whisper, /action === 'view-due-reminders'[\s\S]*openReminderCenter/)
  assert.match(whisper, /handlePreviewNote\(note, reminderButtonRef\.value\)/)
  assert.match(whisper, /:return-focus="previewReturnFocus"/)
  assert.match(whisper, /header__title-compact/)
  assert.match(commands, /id: 'view-due-reminders'/)
  assert.match(commands, /action: 'view-due-reminders'/)
  assert.match(commands, /icon: 'clock'/)
})

test('reminder center is an accessible mobile sheet with truthful local-only behavior', async () => {
  const source = await readReminderCenter()

  assert.match(source, /role="dialog"/)
  assert.match(source, /aria-modal="true"/)
  assert.match(source, /aria-labelledby="reminder-center-title"/)
  assert.match(source, /previouslyFocusedElement = document\.activeElement/)
  assert.match(source, /previouslyFocusedElement\.focus\(\)/)
  assert.match(source, /关闭页面后不会发送系统通知/)
  assert.match(source, /max-height: 85dvh/)
  assert.match(source, /min-height: 44px/)
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(source, /@complete="handleReminderComplete"|emit\('complete', reminder\)/)
  assert.doesNotMatch(source, /[😀-🙏🌀-🫿]/u)
})

test('due reminders refresh while the NAV page remains visible', async () => {
  const source = await readReminderComposable()

  assert.match(source, /NOTE_REMINDER_FOREGROUND_REFRESH_MS = 60_000/)
  assert.match(source, /window\.setInterval\([\s\S]*refreshWhileVisible/)
  assert.match(source, /document\.visibilityState === 'visible'/)
  assert.match(source, /window\.clearInterval\(foregroundRefreshTimer\)/)
  assert.match(source, /LOCAL_REMINDER_READ_STORAGE_KEY/)
  assert.match(source, /saveLocalReminderReadIds\(localReadIds\)/)
})
