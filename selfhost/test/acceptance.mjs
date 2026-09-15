import assert from 'node:assert/strict'
import https from 'node:https'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(process.env.NAV_COMPOSE_PACKAGE)
const settings = JSON.parse(readFileSync(join(root, 'config/settings.json')))
assert.equal(settings.mode, 'local', 'Acceptance may only run against a synthetic local instance')
assert.equal(settings.username, 'ci-admin')
const dc = args => execFileSync('docker', ['compose', '--env-file', '.env', '-f', 'compose.yaml', ...args], { cwd: root, encoding: 'utf8', timeout: 300000, stdio: ['pipe', 'pipe', 'pipe'] })
let cookie = ''
const ca = readFileSync(join(root, 'domonav-local-ca.crt'))
function request(path, { method = 'GET', body, origin = settings.origin, authenticated = true } = {}) {
  const data = body ? JSON.stringify(body) : undefined
  return new Promise((resolveResponse, reject) => {
    const req = https.request(new URL(path, settings.origin), {
      ca, family: 4, method, headers: { Origin: origin, ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) }
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => resolveResponse({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) }))
    })
    req.setTimeout(15000, () => req.destroy(new Error('Request timeout')))
    req.on('error', reject)
    req.end(data)
  })
}
async function login() {
  const response = await request('/api/auth/login', { method: 'POST', body: { username: settings.username, password: readFileSync(join(root, 'config/secrets/admin-password'), 'utf8') }, authenticated: false })
  assert.equal(response.status, 200, 'Administrator login failed')
  assert.equal(response.json().user.role, 'admin')
  const cookies = response.headers['set-cookie'] || []
  assert.ok(cookies.some(value => /httponly/i.test(value) && /secure/i.test(value) && /samesite=lax/i.test(value)))
  cookie = cookies.map(value => value.split(';')[0]).join('; ')
}
const marker = 'Compose synthetic persistence acceptance'
try {
  assert.equal((await request('/')).status, 200)
  const version = await request('/version.json')
  assert.equal(version.status, 200)
  assert.ok(version.json().buildId)
  assert.match(version.headers['cache-control'], /no-store/)
  assert.equal((await request('/api/health')).json().ok, true)
  assert.equal((await request('/api/groups', { authenticated: false })).status, 401)
  await login()
  console.log('PASS strict TLS + frontend version + initial admin login + secure session')
  assert.equal((await request('/api/groups', { method: 'POST', origin: 'https://untrusted.example', body: { name: 'must-not-exist' } })).status, 403)
  const groupResponse = await request('/api/groups', { method: 'POST', body: { name: marker } })
  assert.equal(groupResponse.status, 201)
  const groupId = groupResponse.json().group.id
  const bookmark = await request('/api/bookmarks', { method: 'POST', body: { groupId, title: marker, url: 'https://example.com/compose-acceptance' } })
  assert.equal(bookmark.status, 201)
  dc(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '240'])
  await login()
  const groups = (await request('/api/groups')).json().groups
  assert.equal(groups.filter(group => group.name === marker).length, 1)
  const bookmarks = (await request('/api/bookmarks')).json().bookmarks
  assert.equal(bookmarks.filter(item => item.title === marker).length, 1)
  console.log('PASS CSRF rejection + bookmark write + recreate persistence + unchanged admin login')
  const inspection = JSON.parse(execFileSync('docker', ['inspect', ...dc(['ps', '-q']).trim().split('\n')], { encoding: 'utf8' }))
  const api = inspection.find(item => item.Config.Labels['com.docker.compose.service'] === 'api')
  const db = inspection.find(item => item.Config.Labels['com.docker.compose.service'] === 'db')
  for (const service of [api, db]) assert.ok(Object.values(service.NetworkSettings.Ports || {}).every(value => value === null))
  assert.ok(!api.Config.Env.some(value => /^(?:DATABASE_URL|ADMIN_PASSWORD|NAV_RATE_LIMIT_KEY_SECRET)=/.test(value)))
  execFileSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--tmpfs', '/tmp', '--entrypoint', 'node', api.Config.Image, 'scripts/verifyEmbeddingIsolation.js'], { timeout: 120000, stdio: 'pipe' })
  console.log('PASS internal-only API/DB + secrets absent from Docker env + offline native CPU isolation')
  execFileSync('bash', ['manage.sh', 'backup', '--allow-pause'], { cwd: root, timeout: 300000, stdio: 'pipe' })
  const backup = join(root, 'backups', readdirSync(join(root, 'backups')).sort().at(-1))
  assert.equal(statSync(backup).mode & 0o077, 0)
  execFileSync('sha256sum', ['--check', '--status', 'SHA256SUMS'], { cwd: backup })
  execFileSync('tar', ['-tzf', join(backup, 'integrations.tar.gz')], { stdio: 'pipe' })
  execFileSync('tar', ['-tzf', join(backup, 'config.tar.gz')], { stdio: 'pipe' })
  await login()
  assert.equal((await request('/api/bookmarks')).json().bookmarks.filter(item => item.title === marker).length, 1)
  // Restore the actual dump into a NEW disposable database, never over the running one.
  const isolated = `nav-compose-restore-${process.pid}`
  const postgresImage = JSON.parse(readFileSync(join(root, 'image-lock.json'))).postgres
  let created = false
  try {
    execFileSync('docker', ['run', '-d', '--name', isolated, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data', '--mount', `type=bind,src=${join(root, 'config/secrets/db-password')},dst=/run/secrets/password,readonly`, '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/password', '-e', 'POSTGRES_DB=nav', '-e', 'POSTGRES_USER=nav', postgresImage], { stdio: 'pipe' })
    created = true
    let ready = false
    for (let i = 0; i < 30; i++) {
      try { execFileSync('docker', ['exec', isolated, 'pg_isready', '-U', 'nav', '-d', 'nav'], { stdio: 'pipe' }); ready = true; break } catch { await new Promise(done => setTimeout(done, 1000)) }
    }
    assert.ok(ready, 'Isolated restore database did not become ready')
    execFileSync('docker', ['exec', '-i', isolated, 'pg_restore', '-U', 'nav', '-d', 'nav', '--exit-on-error', '--single-transaction'], { input: readFileSync(join(backup, 'database.dump')), timeout: 120000, stdio: ['pipe', 'pipe', 'pipe'] })
    const count = execFileSync('docker', ['exec', isolated, 'psql', '-U', 'nav', '-d', 'nav', '-Atc', `SELECT count(*) FROM nav_bookmarks WHERE title='${marker}'`], { encoding: 'utf8' }).trim()
    assert.equal(count, '1')
    console.log('PASS private backup + service recovery + fresh isolated PostgreSQL dump restore')
  } finally {
    if (created) execFileSync('docker', ['rm', '-f', isolated], { stdio: 'pipe' })
  }
  console.log('COMPOSE_ACCEPTANCE_PASS — synthetic Linux test only; no public DNS, external mail or production changes')
} catch (error) {
  // Never dump child-process stdout/stderr or request/response bodies into CI logs.
  console.error(`COMPOSE_ACCEPTANCE_FAILED: ${error.code || error.name || 'unknown'}`)
  if (error instanceof assert.AssertionError) console.error(error.message.split('\n')[0])
  process.exitCode = 1
}
