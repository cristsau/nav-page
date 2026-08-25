import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

async function readSource(relativeUrl) {
  return (await fs.readFile(new URL(relativeUrl, import.meta.url), 'utf8'))
    .replace(/\r\n?/g, '\n')
}

async function readJson(relativeUrl) {
  return JSON.parse(await fs.readFile(new URL(relativeUrl, import.meta.url), 'utf8'))
}

test('WebAuthn storage binds credentials and challenges to one of two exact RP origins', async () => {
  const [migration, dualDomainMigration] = await Promise.all([
    readSource('../src/db/migrations/019_webauthn_passkeys.sql'),
    readSource('../src/db/migrations/032_dual_domain_webauthn.sql')
  ])

  assert.match(migration, /CREATE TABLE IF NOT EXISTS webauthn_credentials/)
  assert.match(migration, /credential_id TEXT NOT NULL UNIQUE/)
  assert.match(migration, /public_key BYTEA NOT NULL/)
  assert.match(migration, /counter BIGINT NOT NULL DEFAULT 0/)
  assert.match(migration, /REFERENCES users\(id\) ON DELETE CASCADE/)
  assert.match(migration, /CHECK \(rp_id = 'nav\.skrskr\.net'\)/)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS webauthn_challenges/)
  assert.match(migration, /CHECK \(origin = 'https:\/\/nav\.skrskr\.net'\)/)
  assert.match(migration, /kind IN \('registration', 'authentication'\)/)
  assert.match(migration, /used_at TIMESTAMPTZ/)
  assert.match(migration, /expires_at TIMESTAMPTZ NOT NULL/)
  assert.match(migration, /registration_scope_check/)
  assert.match(migration, /authentication_scope_check/)
  assert.doesNotMatch(migration, /password|cookie|token_hash/i)
  assert.match(dualDomainMigration, /rp_id IN \('nav\.skrskr\.net', 'nav\.cristsau\.cn'\)/)
  assert.match(dualDomainMigration, /origin IN \('https:\/\/nav\.skrskr\.net', 'https:\/\/nav\.cristsau\.cn'\)/)
  assert.match(dualDomainMigration, /webauthn_challenges_rp_origin_check/)
  assert.match(dualDomainMigration, /UNIQUE \(rp_id, credential_id\)/)
})

test('server uses SimpleWebAuthn v13 with an exact dual-origin allowlist and opt-in feature flag', async () => {
  const [route, config, origins, env, packageJson, lock, app, verifier] = await Promise.all([
    readSource('../src/routes/passkeys.js'),
    readSource('../src/config.js'),
    readSource('../src/lib/webauthnRelyingParties.js'),
    readSource('../.env.example'),
    readJson('../package.json'),
    readJson('../package-lock.json'),
    readSource('../src/app.js'),
    readSource('../src/db/verifyMigrations.js')
  ])

  assert.equal(packageJson.dependencies['@simplewebauthn/server'], '^13.3.2')
  assert.equal(lock.packages['node_modules/@simplewebauthn/server'].version, '13.3.2')
  assert.match(route, /from '@simplewebauthn\/server'/)
  assert.match(route, /generateRegistrationOptions/)
  assert.match(route, /verifyRegistrationResponse/)
  assert.match(route, /generateAuthenticationOptions/)
  assert.match(route, /verifyAuthenticationResponse/)
  assert.match(config, /webauthnRpId: 'nav\.skrskr\.net'/)
  assert.match(config, /webauthnOrigin: 'https:\/\/nav\.skrskr\.net'/)
  assert.match(config, /webauthnRelyingParties: WEBAUTHN_RELYING_PARTIES/)
  assert.match(origins, /https:\/\/nav\.skrskr\.net/)
  assert.match(origins, /https:\/\/nav\.cristsau\.cn/)
  assert.match(route, /resolveWebAuthnRelyingParty\(request\.headers\?\.origin\)/)
  assert.match(config, /process\.env\.NAV_WEBAUTHN_ENABLED === 'true'/)
  assert.match(env, /^NAV_WEBAUTHN_ENABLED=false$/m)
  assert.doesNotMatch(config, /process\.env\.NAV_WEBAUTHN_(?:RP_ID|ORIGIN)/)
  assert.match(app, /app\.register\(passkeyRoutes, \{ prefix: '\/api' \}\)/)
  assert.match(verifier, /verifyWebAuthnSchema\(\)/)
  assert.match(verifier, /webauthn_credentials/)
  assert.match(verifier, /webauthn_challenges/)
  assert.match(verifier, /webauthn_credentials_rp_credential_unique/)
  assert.match(verifier, /webauthn_challenges_challenge_key/)
  assert.match(verifier, /WebAuthn foreign keys must use ON DELETE CASCADE/)
})

test('registration and deletion require authentication, an allowed origin, and current password', async () => {
  const source = await readSource('../src/routes/passkeys.js')
  const registration = source.slice(
    source.indexOf("fastify.post('/auth/passkeys/register/options'"),
    source.indexOf("fastify.post('/auth/passkeys/register/verify'")
  )
  const deletion = source.slice(
    source.indexOf("fastify.delete('/auth/passkeys/:passkeyId'"),
    source.indexOf("fastify.post('/auth/passkeys/login/options'")
  )

  for (const route of [registration, deletion]) {
    assert.match(route, /requireAuth\(request, reply\)/)
    assert.match(route, /currentPassword/)
    assert.match(route, /verifyPassword\(currentPassword, user\.password_hash\)/)
  }
  assert.match(registration, /requirePasskeyRelyingParty\(request, reply\)/)
  assert.match(registration, /residentKey: 'required'/)
  assert.match(registration, /userVerification: 'required'/)
  assert.match(registration, /attestationType: 'none'/)
  assert.match(deletion, /requirePasskeyRelyingParty\(request, reply\)/)
  assert.match(deletion, /DELETE FROM webauthn_credentials[\s\S]*user_id = \$2/)
  assert.match(deletion, /auth\.passkey\.delete/)
})

test('challenge consumption is committed before verification and cannot be replayed', async () => {
  const source = await readSource('../src/routes/passkeys.js')
  const consume = source.slice(
    source.indexOf('async function consumeChallenge'),
    source.indexOf('async function enforcePasskeyLoginRateLimit')
  )
  const registrationVerify = source.slice(
    source.indexOf("fastify.post('/auth/passkeys/register/verify'"),
    source.indexOf("fastify.delete('/auth/passkeys/:passkeyId'")
  )
  const loginVerify = source.slice(
    source.indexOf("fastify.post('/auth/passkeys/login/verify'")
  )

  assert.match(consume, /SET used_at = NOW\(\)/)
  assert.match(consume, /used_at IS NULL/)
  assert.match(consume, /expires_at > NOW\(\)/)
  assert.match(consume, /origin = \$4/)
  assert.ok(registrationVerify.indexOf('await consumeChallenge') < registrationVerify.indexOf('verifyRegistrationResponse'))
  assert.ok(loginVerify.indexOf('await consumeChallenge') < loginVerify.indexOf('verifyAuthenticationResponse'))
  assert.equal(source.includes('const CHALLENGE_TTL_SECONDS = 300'), true)
})

test('passkey login is enumeration-resistant and reuses persistent limits, sessions, and cookie handling', async () => {
  const source = await readSource('../src/routes/passkeys.js')
  const options = source.slice(
    source.indexOf("fastify.post('/auth/passkeys/login/options'"),
    source.indexOf("fastify.post('/auth/passkeys/login/verify'")
  )
  const verify = source.slice(source.indexOf("fastify.post('/auth/passkeys/login/verify'"))

  assert.match(options, /enforcePasskeyLoginRateLimit\(request, reply\)/)
  assert.match(options, /enforcePasskeyLoginRateLimit\([\s\S]*username/)
  assert.match(source, /consumePublicAuthRateLimit\('passkey', request, identity\)/)
  assert.match(source, /allowCredentials: \[\]/)
  assert.match(source, /userId = userResult\.rows\[0\]\?\.id \|\| null/)
  assert.match(verify, /error: GENERIC_PASSKEY_ERROR/)
  assert.match(verify, /enforcePasskeyLoginRateLimit\(request, reply\)/)
  assert.match(verify, /INSERT INTO sessions/)
  assert.match(verify, /hashSessionToken\(token\)/)
  assert.match(verify, /setSessionCookie\(reply, login\.token\)/)
  assert.match(verify, /auth\.passkey\.login/)
  assert.doesNotMatch(verify, /Invalid username|Username not found|No passkey/i)
})

test('browser flow uses SimpleWebAuthn and explains per-domain enrollment', async () => {
  const [service, login, settings, packageJson, lock] = await Promise.all([
    readSource('../../app/src/shared/services/authApi.js'),
    readSource('../../app/src/modules/auth/AuthView.vue'),
    readSource('../../app/src/modules/settings/components/AccountSecuritySettings.vue'),
    readJson('../../app/package.json'),
    readJson('../../app/package-lock.json')
  ])

  assert.equal(packageJson.dependencies['@simplewebauthn/browser'], '^13.3.0')
  assert.equal(lock.packages['node_modules/@simplewebauthn/browser'].version, '13.3.0')
  assert.match(service, /from '@simplewebauthn\/browser'/)
  assert.match(service, /startRegistration\(\{[\s\S]*optionsJSON: ceremony\.options/)
  assert.match(service, /startAuthentication\(\{[\s\S]*optionsJSON: ceremony\.options/)
  assert.match(login, /autocomplete="username webauthn"/)
  assert.match(login, /当前域名未启用 Passkey/)
  assert.match(login, /使用 Passkey 登录/)
  assert.match(settings, /当前域名 RP ID/)
  assert.match(settings, /两个域名需要分别登记/)
  assert.match(settings, /v-model="passkeyCurrentPassword"/)
  assert.match(settings, /handleDeletePasskey/)
})

test('passkey payloads are redacted and security events have explicit UI labels', async () => {
  const [app, events, labels, auth, migration] = await Promise.all([
    readSource('../src/app.js'),
    readSource('../src/lib/securityEvents.js'),
    readSource('../../app/src/modules/settings/securityAuditUi.js'),
    readSource('../src/routes/auth.js'),
    readSource('../src/routes/migration.js')
  ])

  assert.match(app, /'req\.body\.response'/)
  assert.doesNotMatch(events, /credential_id|public_key|challenge/)
  for (const eventType of [
    'auth.passkey.register',
    'auth.passkey.login',
    'auth.passkey.delete'
  ]) {
    assert.equal(events.includes(`'${eventType}'`), true)
    assert.equal(labels.includes(`'${eventType}'`), true)
  }
  assert.match(labels, /passkey: 'Passkey'/)
  assert.match(auth, /DELETE FROM webauthn_credentials WHERE user_id = \$1/)
  assert.match(auth, /removedPasskeyCount/)
  assert.doesNotMatch(migration, /webauthn_credentials|webauthn_challenges/)
})
