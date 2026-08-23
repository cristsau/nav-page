import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createDataRestorePreviewToken,
  createDataRestoreSafetyBackupReceipt,
  createDataRestoreStateDigest,
  DATA_RESTORE_LIMITS,
  DATA_RESTORE_SOURCES,
  validateDataRestoreRequest,
  verifyDataRestorePreviewToken,
  verifyDataRestoreSafetyBackupReceipt
} from '../src/lib/dataRestore.js'
import {
  consumeDataRestoreRateLimit,
  DATA_RESTORE_RATE_LIMIT_MAX_REQUESTS
} from '../src/lib/dataRestoreRateLimit.js'

const SECRET = 'test-only-restore-preview-secret-1234567890'
const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GROUP_A = '11111111-1111-4111-8111-111111111111'
const GROUP_B = '22222222-2222-4222-8222-222222222222'
const NOTE_ID = '33333333-3333-4333-8333-333333333333'
const SHARE_ID = '44444444-4444-4444-8444-444444444444'
const MEDIA_A = '66666666-6666-4666-8666-666666666666'
const MEDIA_B = '77777777-7777-4777-8777-777777777777'
const CURRENT_STATE_DIGEST = createDataRestoreStateDigest({ groups: 1, notes: 2 })
const NOW = Date.parse('2026-08-23T01:00:00.000Z')

function restoreRequest(overrides = {}) {
  const data = overrides.data || {
    groups: [],
    bookmarks: [],
    notes: [],
    customEngines: [],
    shares: [],
    settings: [],
    mediaAssets: []
  }
  const counts = Object.fromEntries(
    ['groups', 'bookmarks', 'notes', 'customEngines', 'shares', 'settings', 'mediaAssets']
      .map((name) => [name, Array.isArray(data[name]) ? data[name].length : 0])
  )
  counts.attachments = Array.isArray(data.notes)
    ? data.notes.reduce((total, note) => (
        total + (Array.isArray(note?.attachments) ? note.attachments.length : 0)
      ), 0)
    : 0
  counts.totalRecords = Object.entries(counts)
    .filter(([name]) => name !== 'attachments' && name !== 'totalRecords')
    .reduce((total, [, count]) => total + count, 0)

  return {
    source: DATA_RESTORE_SOURCES.CLOUD_BACKUP,
    schema: 'domo-nav-backup',
    version: 1,
    manifest: {
      schema: 'domo-nav-backup',
      version: 1,
      counts
    },
    ...overrides,
    data
  }
}

test('restore payload requires every destructive collection and applies bounded counts', () => {
  const restore = validateDataRestoreRequest(restoreRequest({
    data: {
      groups: [{ id: GROUP_A }],
      bookmarks: [],
      notes: [{ id: NOTE_ID }],
      customEngines: [],
      shares: [],
      settings: []
    }
  }))

  assert.deepEqual(restore.counts, {
    groups: 1,
    bookmarks: 0,
    notes: 1,
    customEngines: 0,
    shares: 0,
    settings: 0,
    mediaAssets: 0,
    attachments: 0,
    totalRecords: 2
  })
  assert.deepEqual(restore.data.mediaAssets, [])

  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: { groups: [], bookmarks: [], notes: [], customEngines: [], shares: [] }
    })),
    /缺少 settings 数组/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: { ...restoreRequest().data, futureCollection: [] }
    })),
    /不支持的集合/
  )

  const legacyV1 = restoreRequest()
  delete legacyV1.data.mediaAssets
  delete legacyV1.manifest.counts.mediaAssets
  const acceptedLegacyV1 = validateDataRestoreRequest(legacyV1)
  assert.deepEqual(acceptedLegacyV1.data.mediaAssets, [])
  assert.equal(acceptedLegacyV1.backupCounts.mediaAssets, 0)

  const inconsistentLegacyV1 = restoreRequest()
  delete inconsistentLegacyV1.data.mediaAssets
  inconsistentLegacyV1.manifest.counts.mediaAssets = 1
  assert.throws(
    () => validateDataRestoreRequest(inconsistentLegacyV1),
    /mediaAssets 计数不一致/
  )
})

test('cloud restore rejects the wrong backup schema or version', () => {
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({ schema: 'unknown' })),
    /只支持 DOMO NAV 第 1 版云端备份/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({ version: 2 })),
    /只支持 DOMO NAV 第 1 版云端备份/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      manifest: {
        schema: 'domo-nav-backup',
        version: 1,
        counts: { ...restoreRequest().manifest.counts, notes: 1 }
      }
    })),
    /notes 计数不一致/
  )
})

test('restore validation rejects duplicate identifiers, share codes and setting keys before apply', () => {
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        groups: [{ id: GROUP_A }, { id: GROUP_A.toUpperCase() }]
      }
    })),
    /重复 ID/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        groups: [{ id: GROUP_A }, { id: GROUP_A }]
      }
    })),
    /重复 ID/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        shares: [
          { id: SHARE_ID, noteId: NOTE_ID, code: 'sameCode' },
          {
            id: '55555555-5555-4555-8555-555555555555',
            noteId: NOTE_ID,
            code: 'sameCode'
          }
        ]
      }
    })),
    /重复分享码/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        settings: [
          { id: 'theme', value: {} },
          { id: 'theme', value: {} }
        ]
      }
    })),
    /重复设置 ID/
  )
})

test('restore canonicalizes UUID references and known legacy theme values', () => {
  const restore = validateDataRestoreRequest(restoreRequest({
    data: {
      ...restoreRequest().data,
      groups: [{ id: GROUP_A.toUpperCase() }],
      bookmarks: [{
        id: GROUP_B.toUpperCase(),
        groupId: GROUP_A.toUpperCase()
      }],
      settings: [{ id: 'theme', value: 'warm-dark' }]
    }
  }))

  assert.equal(restore.data.groups[0].id, GROUP_A)
  assert.equal(restore.data.bookmarks[0].id, GROUP_B)
  assert.equal(restore.data.bookmarks[0].groupId, GROUP_A)
  assert.equal(restore.data.settings[0].value, 'dark')
})

test('restore bounds attachments and estimated database work before apply', () => {
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        notes: [{
          id: NOTE_ID,
          attachments: Array.from(
            { length: DATA_RESTORE_LIMITS.attachments + 1 },
            () => ({})
          )
        }]
      }
    })),
    /附件总数/
  )
})

test('restore validation rejects malformed scalar fields before apply', () => {
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        groups: [{ id: GROUP_A, order: 'not-a-number' }]
      }
    })),
    /分组顺序/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        notes: [{ id: NOTE_ID, encrypted: 'false' }]
      }
    })),
    /笔记加密状态/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        settings: [{ id: 'theme', value: 'midnight' }]
      }
    })),
    /theme 设置/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        settings: [{ id: ' theme ', value: { unsafe: true } }]
      }
    })),
    /theme 设置/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        settings: [{ id: ' appConfig ', value: 'not-an-object' }]
      }
    })),
    /appConfig 设置/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        settings: [{ id: ' whisperBgImage ', value: 'javascript:unsafe' }]
      }
    })),
    /whisperBgImage 设置/
  )
})

test('restore validation rejects ambiguous media URL and upstream identities', () => {
  const media = (id, url, upstreamId) => ({ id, url, upstreamId })
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        mediaAssets: [
          media(MEDIA_A, 'https://pic.example/a.png', 'user/a'),
          media(MEDIA_B, 'https://pic.example/a.png', 'user/b')
        ]
      }
    })),
    /重复 URL/
  )
  assert.throws(
    () => validateDataRestoreRequest(restoreRequest({
      data: {
        ...restoreRequest().data,
        mediaAssets: [
          media(MEDIA_A, 'https://pic.example/a.png', 'user/same'),
          media(MEDIA_B, 'https://pic.example/b.png', 'user/same')
        ]
      }
    })),
    /重复图床对象标识/
  )
})

test('public share codes are excluded unless the user explicitly restores them', () => {
  const request = restoreRequest({
    data: {
      ...restoreRequest().data,
      shares: [{ id: SHARE_ID, noteId: NOTE_ID, code: 'bearerCode123' }]
    }
  })
  const safeDefault = validateDataRestoreRequest(request)
  const explicit = validateDataRestoreRequest({ ...request, restoreShares: true })

  assert.equal(safeDefault.backupCounts.shares, 1)
  assert.equal(safeDefault.counts.shares, 0)
  assert.deepEqual(safeDefault.data.shares, [])
  assert.equal(explicit.counts.shares, 1)
})

test('preview token is user, source, payload and expiry bound', () => {
  const restore = validateDataRestoreRequest(restoreRequest())
  const preview = createDataRestorePreviewToken({
    restore,
    userId: USER_ID,
    sessionId: SESSION_ID,
    currentStateDigest: CURRENT_STATE_DIGEST,
    secret: SECRET,
    now: NOW
  })

  assert.equal(
    verifyDataRestorePreviewToken({
      token: preview.token,
      restore,
      userId: USER_ID,
      sessionId: SESSION_ID,
      currentStateDigest: CURRENT_STATE_DIGEST,
      secret: SECRET,
      now: NOW + 1_000
    }).valid,
    true
  )
  assert.equal(
    verifyDataRestorePreviewToken({
      token: preview.token,
      restore,
      userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      sessionId: SESSION_ID,
      currentStateDigest: CURRENT_STATE_DIGEST,
      secret: SECRET,
      now: NOW + 1_000
    }).reason,
    'mismatch'
  )
  assert.equal(
    verifyDataRestorePreviewToken({
      token: preview.token,
      restore,
      userId: USER_ID,
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      currentStateDigest: CURRENT_STATE_DIGEST,
      secret: SECRET,
      now: NOW + 1_000
    }).reason,
    'mismatch'
  )
  assert.equal(
    verifyDataRestorePreviewToken({
      token: preview.token,
      restore,
      userId: USER_ID,
      sessionId: SESSION_ID,
      currentStateDigest: createDataRestoreStateDigest({ groups: 2, notes: 2 }),
      secret: SECRET,
      now: NOW + 1_000
    }).reason,
    'mismatch'
  )

  const changedRestore = validateDataRestoreRequest(restoreRequest({
    data: { ...restoreRequest().data, groups: [{ id: GROUP_B }] }
  }))
  assert.equal(
    verifyDataRestorePreviewToken({
      token: preview.token,
      restore: changedRestore,
      userId: USER_ID,
      sessionId: SESSION_ID,
      currentStateDigest: CURRENT_STATE_DIGEST,
      secret: SECRET,
      now: NOW + 1_000
    }).reason,
    'mismatch'
  )
  assert.equal(
    verifyDataRestorePreviewToken({
      token: preview.token,
      restore,
      userId: USER_ID,
      sessionId: SESSION_ID,
      currentStateDigest: CURRENT_STATE_DIGEST,
      secret: SECRET,
      now: NOW + 10 * 60 * 1_000
    }).reason,
    'expired'
  )
})

test('safety backup receipt is bound to the user, session, state and expiry', () => {
  const backup = restoreRequest()
  const issued = createDataRestoreSafetyBackupReceipt({
    backup,
    userId: USER_ID,
    sessionId: SESSION_ID,
    currentStateDigest: CURRENT_STATE_DIGEST,
    secret: SECRET,
    now: NOW
  })

  assert.equal(
    verifyDataRestoreSafetyBackupReceipt({
      receipt: issued.receipt,
      userId: USER_ID,
      sessionId: SESSION_ID,
      currentStateDigest: CURRENT_STATE_DIGEST,
      secret: SECRET,
      now: NOW + 1_000
    }).valid,
    true
  )
  assert.equal(
    verifyDataRestoreSafetyBackupReceipt({
      receipt: issued.receipt,
      userId: USER_ID,
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      currentStateDigest: CURRENT_STATE_DIGEST,
      secret: SECRET,
      now: NOW + 1_000
    }).reason,
    'mismatch'
  )
  assert.equal(
    verifyDataRestoreSafetyBackupReceipt({
      receipt: issued.receipt,
      userId: USER_ID,
      sessionId: SESSION_ID,
      currentStateDigest: createDataRestoreStateDigest({ groups: 2, notes: 2 }),
      secret: SECRET,
      now: NOW + 1_000
    }).reason,
    'mismatch'
  )
  assert.equal(
    verifyDataRestoreSafetyBackupReceipt({
      receipt: issued.receipt,
      userId: USER_ID,
      sessionId: SESSION_ID,
      currentStateDigest: CURRENT_STATE_DIGEST,
      secret: SECRET,
      now: NOW + 10 * 60 * 1_000
    }).reason,
    'expired'
  )
})

test('canonical token ignores object key order but preserves array order', () => {
  const left = validateDataRestoreRequest(restoreRequest({
    data: {
      groups: [{ id: GROUP_A, name: 'A' }],
      bookmarks: [],
      notes: [],
      customEngines: [],
      shares: [],
      settings: [],
      mediaAssets: []
    }
  }))
  const preview = createDataRestorePreviewToken({
    restore: left,
    userId: USER_ID,
    sessionId: SESSION_ID,
    currentStateDigest: CURRENT_STATE_DIGEST,
    secret: SECRET,
    now: NOW
  })
  const reordered = validateDataRestoreRequest(restoreRequest({
    data: {
      mediaAssets: [],
      settings: [],
      shares: [],
      customEngines: [],
      notes: [],
      bookmarks: [],
      groups: [{ name: 'A', id: GROUP_A }]
    }
  }))

  assert.equal(
    verifyDataRestorePreviewToken({
      token: preview.token,
      restore: reordered,
      userId: USER_ID,
      sessionId: SESSION_ID,
      currentStateDigest: CURRENT_STATE_DIGEST,
      secret: SECRET,
      now: NOW + 1_000
    }).valid,
    true
  )
})

test('data restore uses a dedicated low-frequency persistent limiter', async () => {
  let count = 0
  const queryFn = async () => ({
    rows: [{
      request_count: ++count,
      retry_after_seconds: 60,
      window_expires_at: '2026-08-23T02:00:00.000Z'
    }]
  })
  const request = {
    currentUser: { id: USER_ID },
    session: { id: SESSION_ID }
  }

  for (let index = 0; index < DATA_RESTORE_RATE_LIMIT_MAX_REQUESTS; index += 1) {
    assert.equal((await consumeDataRestoreRateLimit(request, {
      queryFn,
      secret: SECRET
    })).allowed, true)
  }
  assert.equal((await consumeDataRestoreRateLimit(request, {
    queryFn,
    secret: SECRET
  })).allowed, false)
})
