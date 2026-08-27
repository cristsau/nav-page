import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  buildMailAcceptanceFixtureMessage,
  cleanupMailAcceptanceFixture,
  MailAcceptanceFixtureError,
  normalizeMailAcceptanceFixtureInput,
  prepareMailAcceptanceFixture
} from '../src/ops/mailAcceptanceFixture.js'

const RUN_ID = 'a'.repeat(48)
const USERNAME = `nav_release_accept_${'b'.repeat(32)}`
const USER_ID = '40000000-0000-4000-8000-000000000001'
const ACCOUNT_ID = '40000000-0000-4000-8000-000000000002'
const FOLDER_ID = '40000000-0000-4000-8000-000000000003'
const MESSAGE_ID = '40000000-0000-4000-8000-000000000004'
const LOCATION_ID = '40000000-0000-4000-8000-000000000005'
const MARKER = `navmail.${RUN_ID}`

function ownerRow() {
  return {
    key: `release_acceptance_account:${RUN_ID}`,
    value: {
      version: 3,
      runId: RUN_ID,
      username: USERNAME,
      userId: USER_ID,
      clientIps: ['203.0.113.10'],
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    },
    database_now: new Date(),
    id: USER_ID,
    username: USERNAME,
    role: 'admin',
    status: 'approved'
  }
}

test('fixture identity is bound to one release-acceptance run', () => {
  assert.deepEqual(
    normalizeMailAcceptanceFixtureInput({ runId: RUN_ID, username: USERNAME, marker: MARKER }),
    { runId: RUN_ID, username: USERNAME, marker: MARKER }
  )
  assert.throws(
    () => normalizeMailAcceptanceFixtureInput({ runId: RUN_ID, username: USERNAME, marker: 'navmail.other' }),
    (error) => error instanceof MailAcceptanceFixtureError
      && error.code === 'INVALID_FIXTURE_MARKER'
  )

  const fixture = buildMailAcceptanceFixtureMessage({ runId: RUN_ID, marker: MARKER })
  assert.equal(fixture.identity.sourceKey, `acceptance.${RUN_ID}`)
  assert.match(fixture.rawMessage.subject, new RegExp(MARKER))
  assert.match(fixture.rawMessage.text, new RegExp(MARKER))
  assert.match(fixture.rawMessage.sender.address, /@invalid\.example$/)
  assert.match(fixture.rawMessage.rawHash, /^[0-9a-f]{64}$/)
})

test('prepare creates only encrypted local mailbox fixture rows', async () => {
  const queries = []
  const encryptions = []
  const generated = [ACCOUNT_ID, FOLDER_ID, MESSAGE_ID, LOCATION_ID]
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params })
      if (sql.includes('FROM system_settings AS marker')) {
        return { rowCount: 1, rows: [ownerRow()] }
      }
      if (sql.includes('AS accounts') && sql.includes('AS locations')) {
        return { rowCount: 1, rows: [{ accounts: 0, folders: 0, messages: 0, locations: 0, outbox: 0 }] }
      }
      if (sql.includes('MIN(octet_length(message.envelope_encrypted))')) {
        return { rowCount: 1, rows: [{ count: 1, envelope_bytes: 64, content_bytes: 64, outbox: 0 }] }
      }
      return { rowCount: 1, rows: [] }
    }
  }
  const result = await prepareMailAcceptanceFixture(client, {
    runId: RUN_ID,
    username: USERNAME,
    marker: MARKER
  }, {
    uuidFactory: () => generated.shift(),
    encryptPayload: async (payload, options) => {
      encryptions.push({ payload, options })
      return Buffer.alloc(64, 7)
    }
  })

  assert.deepEqual(result, {
    accountId: ACCOUNT_ID,
    folderId: FOLDER_ID,
    messageId: MESSAGE_ID,
    locationId: LOCATION_ID,
    marker: MARKER
  })
  assert.equal(encryptions.length, 2)
  assert.equal(encryptions[0].options.context, `${USER_ID}:acceptance.${RUN_ID}:mailbox-v1`)
  const sql = queries.map((entry) => entry.sql).join('\n')
  assert.match(sql, /INSERT INTO email_accounts/)
  assert.match(sql, /INSERT INTO email_folders/)
  assert.match(sql, /INSERT INTO email_messages/)
  assert.match(sql, /INSERT INTO email_folder_messages/)
  assert.doesNotMatch(sql, /INSERT INTO mail_outbox/)
  assert.doesNotMatch(sql, /INSERT INTO email_events/)
  assert.doesNotMatch(sql, /pg_notify/i)
})

test('cleanup deletes only the exact marker-owned account', async () => {
  const queries = []
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params })
      if (sql.includes('FROM system_settings AS marker')) {
        return { rowCount: 1, rows: [ownerRow()] }
      }
      if (sql.includes('message.canonical_hash')) {
        return { rowCount: 1, rows: [{ count: 1, outbox: 0 }] }
      }
      if (sql.includes('DELETE FROM email_accounts')) {
        return { rowCount: 1, rows: [{ id: ACCOUNT_ID }] }
      }
      if (sql.includes('AS accounts') && sql.includes('FROM mail_outbox')) {
        return { rowCount: 1, rows: [{ accounts: 0, outbox: 0 }] }
      }
      return { rowCount: 1, rows: [] }
    }
  }
  const result = await cleanupMailAcceptanceFixture(client, {
    runId: RUN_ID,
    username: USERNAME,
    marker: MARKER,
    accountId: ACCOUNT_ID,
    folderId: FOLDER_ID,
    messageId: MESSAGE_ID,
    locationId: LOCATION_ID
  })

  assert.deepEqual(result, { cleaned: true })
  const deletion = queries.find((entry) => entry.sql.includes('DELETE FROM email_accounts'))
  assert.deepEqual(deletion.params, [ACCOUNT_ID, USER_ID, `acceptance.${RUN_ID}`, RUN_ID])
  assert.match(deletion.sql, /capabilities->>'releaseAcceptanceRunId'/)
})

test('prepare fails closed when the ephemeral user already has mailbox residue', async () => {
  const queries = []
  const client = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('FROM system_settings AS marker')) {
        return { rowCount: 1, rows: [ownerRow()] }
      }
      if (sql.includes('AS accounts') && sql.includes('AS locations')) {
        return {
          rowCount: 1,
          rows: [{ accounts: 1, folders: 0, messages: 0, locations: 0, outbox: 0 }]
        }
      }
      return { rowCount: 1, rows: [] }
    }
  }

  await assert.rejects(
    prepareMailAcceptanceFixture(client, {
      runId: RUN_ID,
      username: USERNAME,
      marker: MARKER
    }),
    (error) => error instanceof MailAcceptanceFixtureError
      && error.code === 'FIXTURE_RESIDUE_PRESENT'
  )
  assert.equal(queries.some((sql) => sql.includes('INSERT INTO email_')), false)
})

test('cleanup refuses a missing or mismatched fixture instead of deleting by user alone', async () => {
  const queries = []
  const client = {
    async query(sql) {
      queries.push(sql)
      if (sql.includes('FROM system_settings AS marker')) {
        return { rowCount: 1, rows: [ownerRow()] }
      }
      if (sql.includes('message.canonical_hash')) {
        return { rowCount: 1, rows: [{ count: 0, outbox: 0 }] }
      }
      return { rowCount: 1, rows: [] }
    }
  }

  await assert.rejects(
    cleanupMailAcceptanceFixture(client, {
      runId: RUN_ID,
      username: USERNAME,
      marker: MARKER,
      accountId: ACCOUNT_ID,
      folderId: FOLDER_ID,
      messageId: MESSAGE_ID,
      locationId: LOCATION_ID
    }),
    (error) => error instanceof MailAcceptanceFixtureError
      && error.code === 'FIXTURE_IDENTITY_MISMATCH'
  )
  assert.equal(queries.some((sql) => sql.includes('DELETE FROM email_accounts')), false)
})

test('CLI and orchestrator keep secrets out of argv, environment values and output', async () => {
  const [cli, shell, wrapper] = await Promise.all([
    readFile(new URL('../src/ops/mailAcceptanceFixtureCli.js', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/release/prepare-mail-fixture-and-accept.sh', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/release/nav-with-ephemeral-admin.sh', import.meta.url), 'utf8')
  ])
  assert.match(cli, /MAX_STDIN_BYTES/)
  assert.match(cli, /MAIL_ACCEPTANCE_FIXTURE_ERROR\|code=/)
  assert.match(cli, /applyManagedIntegrationsToRuntime\(\)/)
  assert.ok(
    cli.indexOf('applyManagedIntegrationsToRuntime()') < cli.indexOf('withTransaction((client)')
  )
  assert.match(cli, /withTransaction/)
  assert.doesNotMatch(cli, /process\.env\.(?:PASSWORD|USERNAME)/)
  assert.match(shell, /--rawfile username "\$NAV_ACCEPTANCE_USERNAME_FILE"/)
  assert.doesNotMatch(shell, /--rawfile password/)
  assert.doesNotMatch(shell, /NAV_ACCEPTANCE_PASSWORD=/)
  assert.doesNotMatch(shell, /(?:echo|printf)[^\n]*PASSWORD/)
  assert.match(shell, /API_CONTAINER="\$\{NAV_ACCEPTANCE_API_CONTAINER:-\}"/)
  assert.doesNotMatch(shell, /NAV_MAIL_ACCEPTANCE_API_CONTAINER:-/)
  assert.match(shell, /ACCEPT_SCRIPT="\$SCRIPT_DIR\/accept-mail-workspace\.sh"/)
  assert.match(shell, /trap finalize EXIT/)
  assert.match(shell, /fixture_request cleanup/)
  assert.match(shell, /NAV_MAIL_ACCEPTANCE_FIXTURE_MODE=required/)
  assert.match(wrapper, /export NAV_ACCEPTANCE_API_CONTAINER="\$API_CONTAINER"/)
  assert.match(wrapper, /export NAV_ACCEPTANCE_DATABASE_CONTAINER="\$DATABASE_CONTAINER"/)
  assert.match(wrapper, /export NAV_ACCEPTANCE_DATABASE_NAME="\$DATABASE_NAME"/)
  assert.match(wrapper, /export NAV_ACCEPTANCE_DATABASE_USER="\$DATABASE_USER"/)
})
