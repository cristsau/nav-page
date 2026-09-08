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

test('retired endpoints cannot be enabled by the legacy runtime flag and do no DB I/O', async () => {
  const {createApp}=await import('../src/app.js')
  const {config}=await import('../src/config.js')
  const previous=config.webauthnEnabled
  config.webauthnEnabled=true
  const app=createApp()
  try {
    const capabilities=await app.inject('/api/auth/passkeys/config')
    assert.deepEqual(capabilities.json(),{enabled:false,retired:true})
    for(const path of ['/auth/passkeys','/auth/passkeys/register/options','/auth/passkeys/register/verify','/auth/passkeys/login/options','/auth/passkeys/login/verify','/auth/passkeys/old-credential']) {
      for(const method of ['GET','POST','PUT','DELETE']) {
        const response=await app.inject({method,url:'/api'+path,headers:{origin:config.corsOrigin.split(',')[0]}})
        assert.equal(response.statusCode,410,method+' '+path)
        assert.equal(response.json().code,'PASSKEY_RETIRED')
        assert.equal(response.headers['cache-control'],'no-store')
      }
    }
  } finally {await app.close();config.webauthnEnabled=previous}
})

test('retired protocol remains disconnected; new device-key dependencies are separately pinned', async () => {
  for(const file of ['../src/routes/passkeys.js','../../app/src/shared/services/authApi.js','../../app/src/shared/composables/useAuth.js','../../app/src/modules/auth/AuthView.vue','../../app/src/modules/settings/components/AccountSecuritySettings.vue']) {
    const source=await readSource(file)
    assert.doesNotMatch(source,/@simplewebauthn|startAuthentication|startRegistration|navigator\.credentials|username webauthn|handleRegisterPasskey/)
  }
  assert.equal((await readJson('../package.json')).dependencies['@simplewebauthn/server'],'14.0.1')
  assert.equal((await readJson('../../app/package.json')).dependencies['@simplewebauthn/browser'],'14.0.0')
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
