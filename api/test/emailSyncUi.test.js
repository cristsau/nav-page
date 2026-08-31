import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../../', import.meta.url)

async function source(path) {
  return readFile(new URL(path, root), 'utf8')
}

test('mail client requests a bounded server-side sync and reads its durable status', async () => {
  const api = await source('app/src/shared/services/emailApi.js')

  assert.match(api, /export function requestEmailAccountSync/)
  assert.match(api, /\/email\/accounts\/\$\{requiredId\(accountId[\s\S]*?\/sync`/)
  assert.match(api, /method: 'POST'/)
  assert.match(api, /export function fetchEmailAccountSyncStatus/)
  assert.match(api, /\/sync-status`/)
  assert.match(api, /cache: 'no-store'/)
  assert.doesNotMatch(api, /imapflow|new ImapFlow|imap:\/\//i)
})

test('mail store tracks sync generations, polls to completion and retains SSE refresh', async () => {
  const store = await source('app/src/modules/mail/useMailStore.js')

  assert.match(store, /requestEmailAccountSync/)
  assert.match(store, /fetchEmailAccountSyncStatus/)
  assert.match(store, /syncRequestGeneration/)
  assert.match(store, /syncCompletedGeneration/)
  assert.match(store, /SYNC_STATUS_FAST_POLL_LIMIT = 25/)
  assert.match(store, /SYNC_STATUS_SLOW_POLL_MS = 10_000/)
  assert.match(store, /SYNC_STATUS_SLOW_POLL_LIMIT = 24/)
  assert.match(store, /generation > 0[\s\S]*?completed >= generation/)
  assert.match(store, /服务器检查仍未回报完成；可再次点“立即收信”重新检查。/)
  assert.match(store, /scheduleMailboxRefresh\(\{ replace: true \}\)/)
  assert.match(store, /state\.syncNotice = '服务器已发现邮件更新，正在刷新列表…'/)
  assert.match(store, /stopMailSyncStatusPolling\(\)/)
  assert.match(store, /if \(changed\) \{[\s\S]*?stopMailSyncStatusPolling\(\{ invalidate: true \}\)/)
  assert.match(store, /function resetMailStore[\s\S]*?stopMailSyncStatusPolling\(\{ invalidate: true \}\)/)
  assert.match(store, /createMailSyncPollEpochGate/)
  assert.match(store, /const pollEpoch = syncPollGate\.begin\(\)/)
  assert.match(store, /fetchEmailAccountSyncStatus\(accountId\)[\s\S]*?syncStatusStillCurrent\(accountId, ownerUserId, pollEpoch\)/)
  assert.match(store, /catch \{[\s\S]*?syncStatusStillCurrent\(accountId, ownerUserId, pollEpoch\)[\s\S]*?scheduleMailSyncStatusPoll\(\{ accountId, ownerUserId, generation, pollEpoch/)
  assert.ok(
    (store.match(/syncStatusStillCurrent\(accountId, ownerUserId, pollEpoch\)/g) || []).length >= 8,
    'the poll token must guard request, response, catch and reschedule paths'
  )
  assert.match(store, /mailSyncFailureForRequest\(payload, state\.syncRequestedAt\)/)
  assert.match(store, /服务器收信失败（错误代码：\$\{failure\.code\}），可再次点“立即收信”重试。/)
})

test('mail sync poll epochs reject a deferred response from an older request', async () => {
  const { createMailSyncPollEpochGate } = await import(
    new URL('app/src/modules/mail/mailSyncState.js', root)
  )
  const gate = createMailSyncPollEpochGate()
  let releaseOldResponse
  const oldResponse = new Promise((resolve) => { releaseOldResponse = resolve })
  const oldEpoch = gate.begin()
  const applyIfCurrent = async (epoch, response) => {
    const payload = await response
    return gate.isCurrent(epoch) ? payload : null
  }
  const oldApply = applyIfCurrent(oldEpoch, oldResponse)

  const newEpoch = gate.begin()
  releaseOldResponse({ requestGeneration: 1, completedGeneration: 1 })

  assert.equal(await oldApply, null)
  assert.equal(gate.isCurrent(newEpoch), true)
})

test('mail sync failures are public codes belonging to the current request only', async () => {
  const { mailSyncFailureForRequest } = await import(
    new URL('app/src/modules/mail/mailSyncState.js', root)
  )
  const requestedAt = '2026-08-31T01:00:00.000Z'

  assert.deepEqual(mailSyncFailureForRequest({
    lastErrorAt: '2026-08-31T01:00:01.000Z',
    lastErrorCode: 'imap_auth_failed'
  }, requestedAt), {
    code: 'IMAP_AUTH_FAILED',
    at: '2026-08-31T01:00:01.000Z'
  })
  assert.equal(mailSyncFailureForRequest({
    lastErrorAt: '2026-08-31T00:59:59.000Z',
    lastErrorCode: 'IMAP_AUTH_FAILED'
  }, requestedAt), null)
  assert.equal(mailSyncFailureForRequest({
    lastErrorAt: '2026-08-31T01:00:01.000Z',
    lastErrorCode: 'IMAP failed: password=secret'
  }, requestedAt), null)
})

test('manual refresh wakes the worker before reloading cache and exposes honest progress', async () => {
  const view = await source('app/src/modules/mail/MailView.vue')
  const refreshBody = view.slice(
    view.indexOf('async function refreshWorkspace()'),
    view.indexOf('async function chooseAccount')
  )

  assert.ok(refreshBody.indexOf('await mail.requestSync()') >= 0)
  assert.ok(refreshBody.indexOf('await mail.requestSync()') < refreshBody.indexOf('await reloadWorkspace()'))
  assert.match(view, /立即收信/)
  assert.match(view, /已刷新本地邮件，但未能请求服务器收信/)
  assert.match(view, /aria-live="polite"/)
  assert.match(view, /state\.syncNotice/)
  assert.match(view, /state\.syncState === 'error' \? 'is-error' : 'is-info'/)
  assert.match(view, /void reloadWorkspace\(\)\.catch/)
})
