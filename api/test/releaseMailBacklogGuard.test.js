import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const hasBash = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0
const scriptPath = new URL('../../scripts/nav-release-mail-backlog-guard.sh', import.meta.url)
const header = 'id,user_id,account_id,email_message_id,status,attempt_count,max_attempts,notification_eligible,next_attempt_at,started_at,completed_at,last_error_at,last_error_code,created_at,updated_at\n'
const row = '"00000000-0000-0000-0000-000000000001","00000000-0000-0000-0000-000000000002","00000000-0000-0000-0000-000000000003","00000000-0000-0000-0000-000000000004","pending","0","5","true","2026-09-01T00:00:00.000000Z","","","","","2026-09-01T00:00:00.000000Z","2026-09-01T00:00:00.000000Z"\n'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-mail-backlog-guard-'))
  const payload = path.join(root, 'payload.csv')
  const fakeDocker = path.join(root, 'docker')
  await fs.writeFile(payload, header + row)
  await fs.writeFile(fakeDocker, '#!/usr/bin/env bash\nset -eu\ncat -- "$NAV_TEST_BACKLOG_PAYLOAD"\n', { mode: 0o700 })
  return { root, payload, fakeDocker }
}

test('release mail backlog guard snapshots and verifies an exact row set', { skip: !hasBash }, async (t) => {
  const { root, payload, fakeDocker } = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const expected = path.join(root, 'retained-jobs-before.csv')
  const environment = {
    ...process.env,
    NAV_RELEASE_GUARD_DOCKER_BIN: fakeDocker,
    NAV_TEST_BACKLOG_PAYLOAD: payload
  }
  const captured = spawnSync('bash', [scriptPath.pathname, 'snapshot', '--container', 'nav-postgres', '--output', expected], {
    encoding: 'utf8',
    env: environment
  })
  assert.equal(captured.status, 0, captured.stderr)
  assert.match(captured.stdout, /BACKLOG_SNAPSHOT_ROWS=1/)

  const verified = spawnSync('bash', [scriptPath.pathname, 'verify', '--container', 'nav-postgres', '--expected', expected], {
    encoding: 'utf8',
    env: environment
  })
  assert.equal(verified.status, 0, verified.stderr)
  assert.match(verified.stdout, /BACKLOG_SNAPSHOT_STATUS=MATCH/)
})
test('release mail backlog guard fails closed when a new job appears', { skip: !hasBash }, async (t) => {
  const { root, payload, fakeDocker } = await fixture()
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const expected = path.join(root, 'retained-jobs-before.csv')
  const environment = {
    ...process.env,
    NAV_RELEASE_GUARD_DOCKER_BIN: fakeDocker,
    NAV_TEST_BACKLOG_PAYLOAD: payload
  }
  assert.equal(spawnSync('bash', [scriptPath.pathname, 'snapshot', '--container', 'nav-postgres', '--output', expected], {
    encoding: 'utf8', env: environment
  }).status, 0)
  await fs.appendFile(payload, row.replace(/000000000001/g, '000000000011'))

  const verified = spawnSync('bash', [scriptPath.pathname, 'verify', '--container', 'nav-postgres', '--expected', expected], {
    encoding: 'utf8', env: environment
  })
  assert.equal(verified.status, 75)
  assert.match(verified.stderr, /repeat preflight before switching/)
})

test('release mail backlog guard documentation surface is explicit', async () => {
  const source = await fs.readFile(scriptPath, 'utf8')
  assert.match(source, /notification_eligible/)
  assert.match(source, /ORDER BY id/)
  assert.match(source, /cmp --silent/)
  assert.doesNotMatch(source, /DELETE|UPDATE email_classification_jobs|INSERT INTO email_classification_jobs/)
})
