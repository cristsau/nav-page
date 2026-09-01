import test from 'node:test'
import assert from 'node:assert/strict'
import { processEmailSentAppendJobs } from '../src/lib/emailSentAppend.js'
import { processEmailRemoteCommands } from '../src/lib/emailRemoteCommandWorker.js'
import { deliverMailOutbox } from '../src/lib/mailOutbox.js'

function sentRuntime(sourceKey, ownerUsername) {
  return {
    emailSourceKey: sourceKey,
    emailOwnerUsername: ownerUsername,
    imapHost: 'mail.example.test',
    imapPort: 993,
    imapSecure: true,
    imapUsername: `${ownerUsername}@example.test`,
    imapPasswordFile: `/secrets/${sourceKey}-imap`,
    imapMailbox: 'INBOX'
  }
}

function sentPool(sourceKey) {
  const queries = []
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values })
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
      if (/SELECT job\.\*, account\.source_key/.test(sql)) {
        return {
          rowCount: 1,
          rows: [{ id: `job-${sourceKey}`, status: 'pending', append_attempted: false }]
        }
      }
      if (/SELECT COUNT\(\*\)::integer AS count/.test(sql)) return { rows: [{ count: 1 }] }
      if (/pg_advisory_unlock/.test(sql)) return { rows: [{ released: true }] }
      return { rowCount: 1, rows: [] }
    },
    release() {}
  }
  return { queries, async connect() { return client } }
}

class MissingSentFolderImap {
  constructor() { this.usable = true }
  async connect() {}
  async list() { return [] }
  async logout() { this.usable = false }
}

test('two Sent append runtimes use distinct locks and source-plus-owner scoped maintenance', async () => {
  const cases = [
    ['mxroute', 'owner-a'],
    ['managed.0123456789abcdef01234567', 'owner-b']
  ]
  const lockNames = []
  for (const [sourceKey, ownerUsername] of cases) {
    const pool = sentPool(sourceKey)
    const result = await processEmailSentAppendJobs({
      poolInstance: pool,
      policy: { intervalSeconds: 30, batchSize: 5, retentionDays: 30 },
      runtimeConfig: sentRuntime(sourceKey, ownerUsername),
      ImapClient: MissingSentFolderImap,
      readSecretImpl: async () => 'mail-password',
      assertHostImpl: async () => {}
    })
    assert.equal(result.processed, 1)
    assert.equal(result.blocked, 1)
    const lock = pool.queries.find(({ sql }) => /pg_try_advisory_lock/.test(sql))
    lockNames.push(lock.values[0])
    const scoped = pool.queries.filter(({ sql }) => (
      /SENT_APPEND_LEASE_EXPIRED/.test(sql)
      || /SENT_APPEND_RETENTION_EXPIRED/.test(sql)
      || /SELECT job\.\*, account\.source_key/.test(sql)
      || /SELECT COUNT\(\*\)::integer AS count/.test(sql)
    ))
    assert.ok(scoped.length >= 4)
    for (const query of scoped) {
      assert.match(query.sql, /owner\.username/)
      assert.match(query.sql, /owner\.status = 'approved'/)
      assert.ok(query.values.includes(sourceKey))
      assert.ok(query.values.includes(ownerUsername))
    }
  }
  assert.deepEqual(lockNames, [
    'nav_email_sent_append:mxroute',
    'nav_email_sent_append:managed.0123456789abcdef01234567'
  ])
})

test('a runtime with the same source but another owner cannot claim legacy remote jobs', async () => {
  const queries = []
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values })
      if (/SELECT id\s+FROM email_remote_commands/.test(sql)) return { rowCount: 0, rows: [] }
      return { rowCount: 0, rows: [] }
    },
    release() {}
  }
  const result = await processEmailRemoteCommands({
    poolInstance: { async connect() { return client } },
    policy: { intervalSeconds: 3, batchSize: 1, staleRunningSeconds: 300 },
    runtimeConfig: {
      emailSourceKey: 'managed.0123456789abcdef01234567',
      emailOwnerUsername: 'owner-b'
    }
  })
  assert.equal(result.processed, 0)
  const claim = queries.find(({ sql }) => /SELECT id\s+FROM email_remote_commands/.test(sql))
  assert.ok(claim)
  assert.match(claim.sql, /JOIN users AS owner/)
  assert.match(claim.sql, /owner\.username = \$2/)
  assert.deepEqual(claim.values, ['managed.0123456789abcdef01234567', 'owner-b'])
  for (const query of queries.filter(({ sql }) => /UPDATE email_remote_commands/.test(sql))) {
    assert.match(query.sql, /owner\.username/)
    assert.match(query.sql, /owner\.status = 'approved'/)
    assert.ok(query.values.includes('owner-b'))
  }
})

test('a secondary SMTP runtime claims user mail only for its source and bound owner', async () => {
  const queries = []
  const client = {
    async query(sql, values = []) {
      queries.push({ sql, values })
      if (/pg_try_advisory_lock/.test(sql)) return { rows: [{ acquired: true }] }
      if (/SELECT \* FROM mail_outbox/.test(sql)) return { rowCount: 0, rows: [] }
      if (/SELECT COUNT\(\*\)::integer AS count FROM mail_outbox/.test(sql)) {
        return { rows: [{ count: 0 }] }
      }
      if (/pg_advisory_unlock/.test(sql)) return { rows: [{ released: true }] }
      return { rowCount: 0, rows: [] }
    },
    release() {}
  }
  let transportCalls = 0
  const result = await deliverMailOutbox({
    poolInstance: { async connect() { return client } },
    policy: { intervalSeconds: 30, batchSize: 5, maxAttempts: 3 },
    runtimeConfig: {
      emailSourceKey: 'managed.0123456789abcdef01234567',
      emailOwnerUsername: 'owner-b',
      emailPrimaryAccount: false
    },
    transportFactory: async () => {
      transportCalls += 1
      throw new Error('transport must not be created without an owner-matched candidate')
    }
  })
  assert.equal(result.processed, 0)
  assert.equal(transportCalls, 0)
  const scoped = queries.filter(({ sql }) => /delivery_account\.source_key/.test(sql))
  assert.ok(scoped.length >= 4)
  for (const query of scoped) {
    assert.match(query.sql, /JOIN users AS delivery_owner/)
    assert.match(query.sql, /delivery_account\.enabled = TRUE/)
    assert.match(query.sql, /delivery_owner\.username = \$3/)
    assert.match(query.sql, /delivery_owner\.status = 'approved'/)
    assert.equal(query.values[0], 'managed.0123456789abcdef01234567')
    assert.equal(query.values[1], false)
    assert.equal(query.values[2], 'owner-b')
  }
})
