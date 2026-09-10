// Disposable local PostgreSQL 16 only. Never reuse a running database or app environment.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../api/package.json', import.meta.url))
const { Client } = require('pg')
const bin = process.env.NAV_TEST_PG_BIN
assert.ok(bin && path.isAbsolute(bin), 'Set NAV_TEST_PG_BIN to the extracted PostgreSQL 16 bin directory')
const suffix = process.platform === 'win32' ? '.exe' : ''
const executable = name => path.join(bin, name + suffix)
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-registration-check-'))
const data = path.join(runtime, 'data')
const databaseLog = path.join(runtime, 'postgres.log')
const testLog = path.join(runtime, 'test.log')
const env = {}
for (const key of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
  if (process.env[key]) env[key] = process.env[key]
}
const options = { env, windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024 }
const report = { status: 'CHECK_REQUIRED', checkedAt: new Date().toISOString(), scope: 'Local disposable PostgreSQL 16; actual routes and SQL, synthetic accounts/outbox, stubbed Turnstile. No SMTP delivery, production access or store submission.', log: testLog, stopped: false, testDataRemoved: false }
let startAttempted = false, testExit = 1, port
try {
  report.postgresVersion = (await run(executable('postgres'), ['--version'], options)).stdout.trim()
  assert.match(report.postgresVersion, /PostgreSQL\) 16\./)
  await run(executable('initdb'), ['-D', data, '-U', 'nav_registration_test', '-A', 'trust', '--encoding=UTF8', '--locale=C'], options)
  const probe = net.createServer()
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve) })
  port = probe.address().port
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()))
  startAttempted = true
  await run(executable('pg_ctl'), ['-D', data, '-l', databaseLog, '-w', '-t', '20', '-o', `-h 127.0.0.1 -p ${port}`, 'start'], options)
  const client = new Client({ host: '127.0.0.1', port, user: 'nav_registration_test', database: 'postgres' })
  await client.connect()
  try {
    assert.equal(path.resolve((await client.query('SHOW data_directory')).rows[0].data_directory).toLowerCase(), path.resolve(data).toLowerCase())
    await client.query('CREATE DATABASE nav_registration_test')
  } finally { await client.end() }
  const testEnvironment = {
    ...env, NODE_ENV: 'test', API_LOG_LEVEL: 'silent',
    DATABASE_URL: `postgres://nav_registration_test@127.0.0.1:${port}/nav_registration_test`,
    NAV_REGISTRATION_INTEGRATION_TEST: 'true', NAV_REGISTRATION_TEST_DATA_DIR: data,
    AUTH_REGISTER_RATE_LIMIT_MAX: '100', AUTH_LOGIN_RATE_LIMIT_MAX: '100',
    AUTHENTICATED_WRITE_RATE_LIMIT_MAX: '200', NAV_RATE_LIMIT_KEY_SECRET: randomBytes(32).toString('hex')
  }
  try {
    const result = await run(process.execPath, ['--test', '--test-concurrency=1', 'integration/registrationPostgres.integration.js'], { ...options, cwd: path.join(root, 'api'), env: testEnvironment, timeout: 180000 })
    await fs.writeFile(testLog, result.stdout + result.stderr)
    testExit = 0
  } catch (error) {
    await fs.writeFile(testLog, String(error.stdout || '') + String(error.stderr || ''))
    testExit = typeof error.code === 'number' ? error.code : 1
  }
  report.testExit = testExit
  report.status = testExit === 0 ? 'PASS' : 'FAIL'
} catch (error) {
  report.status = 'SETUP_FAILED'
  report.error = String(error.message).slice(0, 1200)
} finally {
  if (startAttempted) {
    try {
      await run(executable('pg_ctl'), ['-D', data, '-m', 'fast', '-w', '-t', '20', 'stop'], options)
      report.stopped = true
    } catch { report.stopped = false }
  }
  // Delete only this new test cluster after a successful stop. Never arbitrary caller paths.
  if (!startAttempted || report.stopped) {
    const resolved = await fs.realpath(runtime)
    assert.equal(path.dirname(resolved).toLowerCase(), (await fs.realpath(os.tmpdir())).toLowerCase())
    assert.match(path.basename(resolved), /^nav-registration-check-[a-zA-Z0-9_-]+$/)
    for (const name of ['data', 'synthetic-smtp.txt']) {
      const target = path.join(resolved, name)
      const stat = await fs.lstat(target).catch(() => null)
      if (!stat) continue
      assert.equal(stat.isSymbolicLink(), false)
      await fs.rm(target, { recursive: name === 'data', force: true })
    }
    report.testDataRemoved = true
    // PostgreSQL logs may contain synthetic query arguments; retain only test counts/errors.
    await fs.rm(path.join(resolved, 'postgres.log'), { force: true })
  }
  if (startAttempted && !report.stopped) report.status = 'CLEANUP_REQUIRED'
  const log = await fs.readFile(testLog, 'utf8').catch(() => '')
  report.summary = log.split(/\r?\n/).filter(line => /^(?:# |ℹ )?(tests|pass|fail|skipped) \d/.test(line)).join('; ')
  await fs.writeFile(path.join(runtime, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  process.exitCode = report.status === 'PASS' ? 0 : 1
}
