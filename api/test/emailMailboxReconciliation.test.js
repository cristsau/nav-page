import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  enabledImapCapabilities,
  selectEmailReconcileMode
} from '../src/lib/emailMailboxReconciliation.js'
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

test('ingest keeps a separate QRESYNC connection so INBOX IDLE remains selected', async () => {
  const scheduler = await readFile(new URL('../src/lib/emailIngestScheduler.js', import.meta.url), 'utf8')
  const runtime = await readFile(new URL('../src/lib/emailRuntimeController.js', import.meta.url), 'utf8')
  assert.match(scheduler, /let reconcileImap = null/)
  assert.match(scheduler, /let primaryConnectionAttempted = false/)
  assert.match(scheduler, /let reconcileConnectionAttempted = false/)
  assert.match(scheduler, /qresync: true/)
  assert.match(scheduler, /disableAutoIdle: true/)
  assert.match(scheduler, /syncDueEmailFolders\(\{/)
  assert.match(runtime, /folderSyncIntervalSeconds: config\.imapFolderSyncIntervalSeconds/)
  assert.match(runtime, /maxReconcileMessages: config\.imapReconcileMaxMessages/)
})
