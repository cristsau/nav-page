import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  getManagedOauthState,
  identityOauthCallbacks,
  saveEmailOauthConfig,
  saveIdentityOauthConfig
} from '../src/lib/managedOauthIntegrations.js'
import {
  buildAuthorizationUrl,
  pkceChallenge,
  safeReturnPath,
  signOauthCookie,
  subjectDigest,
  verifyOauthCookie
} from '../src/lib/oauthProtocol.js'
import { resolveImapAuth, resolveSmtpAuth } from '../src/lib/emailOauth2.js'

test('oauth transaction signing, PKCE and subject digests are deterministic and tamper evident', () => {
  const signed = signOauthCookie({ state: 'state', nonce: 'nonce' }, 'server-state-key')
  assert.deepEqual(verifyOauthCookie(signed, 'server-state-key'), { state: 'state', nonce: 'nonce' })
  assert.throws(() => verifyOauthCookie(`${signed.slice(0, -1)}x`, 'server-state-key'))
  assert.match(pkceChallenge('verifier'), /^[A-Za-z0-9_-]{43}$/)
  assert.match(subjectDigest('wechat', 'unionid:stable', 'subject-key'), /^[0-9a-f]{64}$/)
  assert.notEqual(
    subjectDigest('wechat', 'unionid:stable', 'subject-key'),
    subjectDigest('wechat', 'nickname:stable', 'subject-key')
  )
  assert.equal(safeReturnPath('//evil.example'), '/')
})

test('Google identity login requests only openid email and profile scopes', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      issuer: 'https://accounts.google.com',
      authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      token_endpoint: 'https://oauth2.googleapis.com/token',
      jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs'
    })
  })
  const authorizationUrl = await buildAuthorizationUrl(
    'google',
    { clientId: 'domo-nav-client' },
    {
      redirectUri: 'https://nav.cristsau.cn/api/auth/oauth/google/callback',
      state: 'state-value',
      nonce: 'nonce-value',
      verifier: 'pkce-verifier'
    },
    { fetchImpl, now: 1_788_402_000_000 }
  )
  const scopes = new URL(authorizationUrl).searchParams.get('scope').split(' ')

  assert.deepEqual(scopes, ['openid', 'email', 'profile'])
  assert.equal(scopes.some((scope) => /gmail|drive|contacts|calendar/i.test(scope)), false)
})

test('managed identity configuration is default-off and never echoes secrets', async (t) => {
  const managedIntegrationsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-oauth-'))
  t.after(() => fs.rm(managedIntegrationsDir, { recursive: true, force: true }))
  const runtimeConfig = { managedIntegrationsDir }

  const saved = await saveIdentityOauthConfig({
    allowVerifiedEmailAutoLink: false,
    google: { enabled: false, clientId: 'google-client', clientSecret: 'private-google-secret' },
    wechat: { enabled: false, clientId: 'wx-client' }
  }, runtimeConfig)
  assert.equal(saved.google.enabled, false)
  assert.equal(saved.google.secretConfigured, true)
  assert.equal('clientSecret' in saved.google, false)

  const state = await getManagedOauthState(runtimeConfig)
  assert.equal(state.emailOAuth.selectedProvider, '')
  assert.equal(JSON.stringify(state).includes('private-google-secret'), false)
  assert.deepEqual(identityOauthCallbacks().google, [
    'https://nav.skrskr.net/api/auth/oauth/google/callback',
    'https://nav.cristsau.cn/api/auth/oauth/google/callback'
  ])
  await assert.rejects(
    saveIdentityOauthConfig({ wechat: { enabled: true, clientId: 'wx-missing-secret' } }, runtimeConfig),
    /Client ID.*Client Secret/
  )
})

test('oauth-only mail skeleton saves disabled and adapters use access tokens without exposing refresh tokens', async (t) => {
  const managedIntegrationsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-mail-oauth-'))
  t.after(() => fs.rm(managedIntegrationsDir, { recursive: true, force: true }))
  const runtimeConfig = { managedIntegrationsDir }
  const saved = await saveEmailOauthConfig({
    selectedProvider: '',
    google: { enabled: false, clientId: 'mail-google-client', scope: 'https://mail.google.com/' },
    microsoft: { enabled: false, clientId: '', tenant: 'common' }
  }, runtimeConfig)
  assert.equal(saved.selectedProvider, '')
  assert.equal(saved.google.clientSecretConfigured, false)
  assert.equal('refreshToken' in saved.google, false)

  const tokenProvider = async () => ({ accessToken: 'short-lived-access-token' })
  assert.deepEqual(
    await resolveImapAuth({ imapOauthProvider: 'google', imapUsername: 'user@example.com' }, { tokenProvider }),
    { user: 'user@example.com', accessToken: 'short-lived-access-token' }
  )
  assert.deepEqual(
    await resolveSmtpAuth({ smtpOauthProvider: 'microsoft', smtpUsername: 'user@example.com' }, { tokenProvider }),
    { type: 'OAuth2', user: 'user@example.com', accessToken: 'short-lived-access-token' }
  )
})

test('wechat exchange source uses stable unionid/openid and never nickname merging', async () => {
  const source = await fs.readFile(new URL('../src/lib/oauthProtocol.js', import.meta.url), 'utf8')
  assert.match(source, /unionid:\$\{token\.unionid\}/)
  assert.match(source, /openid:\$\{token\.openid\}/)
  assert.doesNotMatch(source, /nickname/i)
})

test('oauth routes fail closed for duplicate verified emails and invalid public inputs', async () => {
  const source = await fs.readFile(new URL('../src/routes/oauth.js', import.meta.url), 'utf8')
  assert.match(source, /ORDER BY id[\s\S]*LIMIT 2 FOR UPDATE/)
  assert.match(source, /candidates\.rowCount !== 1/)
  assert.match(source, /OAuth Provider [^']+['\s\S]*statusCode = 400/)
  assert.match(source, /statusCode = 403/)
})
