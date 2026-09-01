import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  enabledImapCapabilities,
  selectEmailReconcileMode,
  syncDueEmailFolders
} from '../src/lib/emailMailboxReconciliation.js'
import { validateEmailIngestPolicy } from '../src/lib/emailIngestScheduler.js'
import {
  createEmailIngestTelemetry,
  latencyPercentile
} from '../src/lib/emailIngestTelemetry.js'

test('reconciliation selects QRESYNC and CONDSTORE only with a durable cursor', () => {
  assert.equal(selectEmailReconcileMode({
    capabilities: new Set(['CONDSTORE', 'QRESYNC']),
    reconciledModseq: '42',
    remoteHighestModseq: '43'
  }), 'qresync')
  assert.equal(selectEmailReconcileMode({
    capabilities: new Set(['CONDSTORE']),
    reconciledModseq: '42',
    remoteHighestModseq: '43'
  }), 'condstore')
  assert.equal(selectEmailReconcileMode({
    capabilities: new Set(['CONDSTORE', 'QRESYNC']),
    reconciledModseq: null,
    remoteHighestModseq: '43'
  }), 'uid_flags_scan')
  assert.equal(selectEmailReconcileMode({
    capabilities: new Set(['CONDSTORE', 'QRESYNC']),
    reconciledModseq: '42',
    remoteHighestModseq: '43',
    noModseq: true
  }), 'uid_flags_scan')
  assert.equal(selectEmailReconcileMode({
    capabilities: new Set(['CONDSTORE', 'QRESYNC']),
    reconciledModseq: '42',
    remoteHighestModseq: null
  }), 'uid_flags_scan')
})

test('capability detection uses advertised and actually enabled IMAP extensions', () => {
  const capabilities = enabledImapCapabilities({
    capabilities: new Set(['idle', 'condstore']),
    enabled: new Set(['CONDSTORE', 'QRESYNC'])
  })
  assert.deepEqual([...capabilities].sort(), ['CONDSTORE', 'IDLE', 'QRESYNC'])
  const rejectedEnable = enabledImapCapabilities({
    capabilities: new Set(['IDLE', 'CONDSTORE', 'QRESYNC']),
    enabled: new Set()
  })
  assert.deepEqual([...rejectedEnable], ['IDLE'])
})

test('rolling telemetry reports bounded connection retries and nearest-rank p50/p95', () => {
  assert.equal(latencyPercentile([10, 20, 30, 40], 0.50), 20)
  assert.equal(latencyPercentile([10, 20, 30, 40], 0.95), 40)

  const telemetry = createEmailIngestTelemetry({ sampleSize: 8 })
  telemetry.recordConnectionAttempt({ durationMs: 90, succeeded: false, retry: false })
  telemetry.recordDisconnect()
  telemetry.recordConnectionAttempt({ durationMs: 40, succeeded: true, retry: true })
  for (const duration of [10, 20, 30, 40, 50, 60, 70, 80, 90]) telemetry.recordSync(duration)
  assert.deepEqual(telemetry.snapshot(), {
    connectionAttempts: 2,
    connectionRetries: 1,
    connectionFailures: 1,
    reconnects: 1,
    connectLatencyP50Ms: 40,
    connectLatencyP95Ms: 90,
    syncLatencyP50Ms: 50,
    syncLatencyP95Ms: 90,
    telemetrySamples: 8
  })
})

test('reconciliation feature policy keeps direct callers compatible when flags are omitted', async () => {
  const policy = validateEmailIngestPolicy({})
  assert.equal(policy.protocolReconciliationEnabled, true)
  assert.equal(policy.secondaryFolderSyncEnabled, true)

  const queries = []
  const result = await syncDueEmailFolders({
    client: {},
    poolInstance: {
      async query(sql, values) {
        queries.push({ sql, values })
        return { rows: [] }
      }
    },
    userId: 'user-1',
    sourceKey: 'mail-source',
    primaryMailbox: 'INBOX'
  })

  assert.equal(result.foldersProcessed, 0)
  assert.equal(queries.length, 1)
  assert.match(queries[0].sql, /\$6::boolean/)
  assert.match(queries[0].sql, /\$7::boolean/)
  assert.match(
    queries[0].sql,
    /last_reconcile_error_at IS NULL[\s\S]*?\$6::boolean[\s\S]*?\$7::boolean/
  )
  assert.deepEqual(queries[0].values, [
    'user-1',
    'mail-source',
    900,
    'INBOX',
    2,
    true,
    true
  ])
})

test('both reconciliation staging flags off return before any database activity', async () => {
  let databaseCalls = 0
  const result = await syncDueEmailFolders({
    client: {},
    poolInstance: {
      async query() {
        databaseCalls += 1
        throw new Error('database must not be touched while both staging flags are off')
      }
    },
    userId: 'user-1',
    sourceKey: 'mail-source',
    primaryMailbox: 'INBOX',
    policy: {
      protocolReconciliationEnabled: false,
      secondaryFolderSyncEnabled: false
    }
  })

  assert.equal(databaseCalls, 0)
  assert.deepEqual(result, {
    foldersProcessed: 0,
    foldersFailed: 0,
    qresyncFolders: 0,
    condstoreFolders: 0,
    uidScanFolders: 0,
    uidValidityResets: 0,
    flagUpdates: 0,
    expunged: 0,
    secondaryProcessed: 0,
    secondaryRemaining: 0,
    continueImmediately: false
  })
})

test('protocol-only staging reconciles without syncing secondary history', async () => {
  const queries = []
  let reconcileCalls = 0
  let secondaryCalls = 0
  const folder = {
    id: 'folder-1',
    account_id: 'account-1',
    account_label: 'Personal',
    path: 'Archive'
  }
  const result = await syncDueEmailFolders({
    client: {},
    poolInstance: {
      async query(sql, values) {
        queries.push({ sql, values })
        return { rows: [folder] }
      }
    },
    userId: 'user-1',
    sourceKey: 'mail-source',
    primaryMailbox: 'INBOX',
    policy: {
      protocolReconciliationEnabled: true,
      secondaryFolderSyncEnabled: false
    },
    reconcileFolderImpl: async ({ listedFolder }) => {
      reconcileCalls += 1
      assert.equal(listedFolder, folder)
      return {
        mode: 'condstore',
        uidValidityReset: false,
        flagsUpdated: 2,
        expunged: 1
      }
    },
    syncSecondaryFolderImpl: async () => {
      secondaryCalls += 1
      throw new Error('secondary sync must stay disabled')
    }
  })

  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0].values.slice(5), [true, false])
  assert.equal(reconcileCalls, 1)
  assert.equal(secondaryCalls, 0)
  assert.equal(result.foldersProcessed, 1)
  assert.equal(result.condstoreFolders, 1)
  assert.equal(result.flagUpdates, 2)
  assert.equal(result.expunged, 1)
  assert.equal(result.secondaryProcessed, 0)
})

test('secondary-only staging syncs history without protocol reconciliation', async () => {
  const queries = []
  let reconcileCalls = 0
  let secondaryCalls = 0
  const folder = {
    id: 'folder-1',
    account_id: 'account-1',
    account_label: 'Personal',
    path: 'Archive'
  }
  const result = await syncDueEmailFolders({
    client: {},
    poolInstance: {
      async query(sql, values) {
        queries.push({ sql, values })
        return { rows: [folder] }
      }
    },
    userId: 'user-1',
    sourceKey: 'mail-source',
    primaryMailbox: 'INBOX',
    policy: {
      protocolReconciliationEnabled: false,
      secondaryFolderSyncEnabled: true
    },
    reconcileFolderImpl: async () => {
      reconcileCalls += 1
      throw new Error('protocol reconciliation must stay disabled')
    },
    syncSecondaryFolderImpl: async ({ folderId }) => {
      secondaryCalls += 1
      assert.equal(folderId, folder.id)
      return { processed: 3, remaining: 4, caughtUp: false }
    }
  })

  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0].values.slice(5), [false, true])
  assert.equal(reconcileCalls, 0)
  assert.equal(secondaryCalls, 1)
  assert.equal(result.foldersProcessed, 0)
  assert.equal(result.secondaryProcessed, 3)
  assert.equal(result.secondaryRemaining, 4)
  assert.equal(result.continueImmediately, true)
})

test('ingest keeps a separate QRESYNC connection so INBOX IDLE remains selected', async () => {
  const [scheduler, runtime, config, envExample] = await Promise.all([
    readFile(new URL('../src/lib/emailIngestScheduler.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/lib/emailRuntimeController.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/config.js', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8')
  ])
  assert.match(scheduler, /let reconcileImap = null/)
  assert.match(scheduler, /let primaryConnectionAttempted = false/)
  assert.match(scheduler, /let reconcileConnectionAttempted = false/)
  assert.match(scheduler, /qresync: true/)
  assert.match(scheduler, /disableAutoIdle: true/)
  assert.match(scheduler, /syncDueEmailFolders\(\{/)
  assert.match(
    scheduler,
    /validated\.protocolReconciliationEnabled[\s\S]*?validated\.secondaryFolderSyncEnabled[\s\S]*?ensureReconcileConnected\(\)/
  )
  assert.match(
    config,
    /imapProtocolReconciliationEnabled:\s*process\.env\.NAV_IMAP_PROTOCOL_RECONCILIATION_ENABLED === 'true'/
  )
  assert.match(
    config,
    /imapSecondaryFolderSyncEnabled:\s*process\.env\.NAV_IMAP_SECONDARY_FOLDER_SYNC_ENABLED === 'true'/
  )
  assert.match(envExample, /^NAV_IMAP_PROTOCOL_RECONCILIATION_ENABLED=false$/m)
  assert.match(envExample, /^NAV_IMAP_SECONDARY_FOLDER_SYNC_ENABLED=false$/m)
  assert.match(runtime, /protocolReconciliationEnabled: config\.imapProtocolReconciliationEnabled/)
  assert.match(runtime, /secondaryFolderSyncEnabled: config\.imapSecondaryFolderSyncEnabled/)
  assert.match(runtime, /folderSyncIntervalSeconds: config\.imapFolderSyncIntervalSeconds/)
  assert.match(runtime, /maxReconcileMessages: config\.imapReconcileMaxMessages/)
})
