import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, cpSync, readFileSync, existsSync, statSync, writeFileSync, symlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const root = resolve(process.env.NAV_COMPOSE_PACKAGE)
const { validateAnswers, initialize } = await import(pathToFileURL(join(root, 'setup.mjs')))
const valid = { mode: 'local', origin: 'https://localhost:8443', username: 'test-admin', password: 'Synthetic-test-only-password-789!' }
const read = name => readFileSync(join(root, name), 'utf8')
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'nav-compose-test-'))
  for (const path of ['setup.mjs', 'Caddyfile.template', 'package-info.json', 'image-lock.json', 'source/api/src/lib/auth.js', 'source/api/src/lib/commonPasswords.js', 'source/api/package.json']) {
    cpSync(join(root, path), join(dir, path), { recursive: true })
  }
  return dir
}
// Synthetic test-only credentials, never used against a real instance.
test('local and public HTTPS origins', () => {
  assert.equal(validateAnswers(valid).hostname, 'localhost')
  assert.equal(validateAnswers({ ...valid, mode: 'public', origin: 'https://nav.example.com' }).origin, 'https://nav.example.com')
})
for (const origin of ['http://nav.example.com', 'https://name:secret@nav.example.com', 'https://nav.example.com/path', 'https://nav.example.com?a=1', 'https://nav.example.com#x', 'https://127.0.0.1', 'https://nav.example.com:8443', 'https://bad{host}.example.com']) {
  test(`reject unsafe public origin ${origin.replace('name:secret@', '')}`, () => assert.throws(() => validateAnswers({ ...valid, mode: 'public', origin })))
}
for (const username of ['ab', 'admin\nNAV_TEST=true', 'a'.repeat(33), 'Admin', 'name;command']) {
  test('reject invalid administrator name', () => assert.throws(() => validateAnswers({ ...valid, username })))
}
for (const password of ['short', 'x'.repeat(129), ' leading-and-trailing ', 'long-enough\npassword']) {
  test('reject invalid passphrase', () => assert.throws(() => validateAnswers({ ...valid, password })))
}
test('initialize, secret separation, independent instances and no overwrite', async () => {
  const a = temp(), b = temp()
  await initialize(a, valid)
  await initialize(b, valid)
  const envA = readFileSync(join(a, '.env'), 'utf8')
  const settings = JSON.parse(readFileSync(join(a, 'config/settings.json')))
  assert.match(envA, /NAV_BIND_ADDRESS=127.0.0.1/)
  assert.match(envA, /NAV_HTTPS_PORT=8443/)
  assert.equal(settings.origin, valid.origin)
  assert.doesNotMatch(envA, /PASSWORD=|SECRET=|KEY=/)
  assert.ok(!envA.includes(valid.password))
  const secret = readFileSync(join(a, 'config/secrets/db-password'), 'utf8')
  assert.match(secret, /^[a-f0-9]{64}$/)
  assert.notEqual(secret, readFileSync(join(b, 'config/secrets/db-password'), 'utf8'))
  assert.notEqual(settings.project, JSON.parse(readFileSync(join(b, 'config/settings.json'))).project)
  const authKeys = JSON.parse(readFileSync(join(a, 'config/secrets/auth-email-keys')))
  assert.notEqual(authKeys.hmacKey, authKeys.encryptionKey)
  assert.match(readFileSync(join(a, 'config/Caddyfile'), 'utf8'), /tls internal/)
  await assert.rejects(initialize(a, valid), /already exists/)
  assert.equal(readFileSync(join(a, 'config/secrets/db-password'), 'utf8'), secret)
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(a, 'config')).mode & 0o777, 0o700)
    assert.equal(statSync(join(a, 'config/secrets/db-password')).mode & 0o777, 0o600)
  }
})
test('public mode is explicit and produces an ACME domain configuration', async () => {
  const dir = temp()
  await initialize(dir, { ...valid, mode: 'public', origin: 'https://nav.example.com' })
  const env = readFileSync(join(dir, '.env'), 'utf8')
  assert.match(env, /NAV_BIND_ADDRESS=0.0.0.0/)
  assert.match(env, /NAV_HTTPS_PORT=443/)
  assert.doesNotMatch(readFileSync(join(dir, 'config/Caddyfile'), 'utf8'), /tls internal|@@/)
})
test('incomplete configuration is never overwritten', async () => {
  const dir = temp()
  writeFileSync(join(dir, '.env'), 'sentinel')
  await assert.rejects(initialize(dir, valid), /already exists/)
  assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'sentinel')
  assert.equal(existsSync(join(dir, 'config')), false)
})
test('bad image pins are rejected before generating any secret', async () => {
  const dir = temp()
  writeFileSync(join(dir, 'image-lock.json'), JSON.stringify({ node: 'node:latest' }))
  await assert.rejects(initialize(dir, valid), /pin is missing/)
  assert.equal(existsSync(join(dir, 'config')), false)
})
test('symlinked package root is rejected', async () => {
  const dir = temp()
  const parent = mkdtempSync(join(tmpdir(), 'nav-compose-link-'))
  const link = join(parent, 'alias')
  symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(initialize(link, valid), /symbolic link/)
})
test('archive file manifest matches every distributed byte', () => {
  const lines = read('SHA256SUMS').trim().split('\n')
  assert.ok(lines.length > 100)
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
    assert.ok(match)
    const [, expected, name] = match
    assert.ok(!name.includes('..') && !name.startsWith('/') && !name.includes('\\'))
    assert.ok(!/(^|\/)\.env($|\.)|(^|\/)node_modules\/|^config\/|\/downloads\//.test(name), name)
    assert.equal(createHash('sha256').update(readFileSync(join(root, name))).digest('hex'), expected, name)
  }
})
test('Docker build excludes mutable config and uses locked dependencies', () => {
  assert.ok(read('.dockerignore').startsWith('**\n'))
  assert.doesNotMatch(read('Dockerfile'), /COPY\s+\.\s|ARG.*(?:PASSWORD|SECRET)/)
  assert.match(read('Dockerfile'), /VITE_AUTH_MODE=backend/)
  assert.match(read('Dockerfile'), /npm ci --omit=dev/)
  assert.match(read('Dockerfile'), /--strip-install-tools/)
})
test('compose isolation, persistence and bounded readiness contracts', () => {
  const compose = read('compose.yaml')
  assert.doesNotMatch(compose, /container_name:|privileged:|network_mode:\s*host|5432:5432|3001:3001|docker.sock|POSTGRES_PASSWORD:/)
  assert.match(compose, /POSTGRES_PASSWORD_FILE:/)
  assert.match(compose, /internal: true/)
  assert.match(compose, /SESSION_COOKIE_SECURE: "true"/)
  assert.match(compose, /database:\/var\/lib\/postgresql\/data/)
  assert.match(compose, /condition: service_healthy/)
  assert.match(read('manage.sh'), /--wait-timeout 240/)
  assert.doesNotMatch(read('manage.sh'), /down -v|volume prune|rm -rf/)
})
