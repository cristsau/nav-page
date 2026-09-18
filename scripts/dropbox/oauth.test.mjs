import test from 'node:test'
import assert from 'node:assert/strict'
import { request } from 'node:http'
import { readFileSync } from 'node:fs'
import { SCOPES, REDIRECT_URI, createAttempt, challenge, parseCallback, startReceiver, validateTokens, exchangeAndVerify } from './oauth.mjs'

const clientId = 'SyntheticApp12345'
const initial = () => ({ access_token: 'SYNTHETIC_ACCESS', refresh_token: 'SYNTHETIC_REFRESH',
  token_type: 'bearer', expires_in: 14400, scope: SCOPES.join(' '), account_id: 'dbid:SYNTHETIC' })
const reply = value => new Response(JSON.stringify(value), { status: 200 })

test('PKCE S256 matches RFC 7636 test vector', () => {
  assert.equal(challenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
})
test('fresh attempts use offline code flow, exact scopes and fixed loopback; no secret/verifier in URL', () => {
  const a = createAttempt(clientId), b = createAttempt(clientId), u = new URL(a.url)
  assert.notEqual(a.state, b.state); assert.notEqual(a.verifier, b.verifier)
  assert.equal(u.origin, 'https://www.dropbox.com')
  assert.equal(u.searchParams.get('response_type'), 'code')
  assert.equal(u.searchParams.get('token_access_type'), 'offline')
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT_URI)
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(u.searchParams.get('code_challenge'), challenge(a.verifier))
  assert.deepEqual(u.searchParams.get('scope').split(' '), SCOPES)
  assert.equal(u.searchParams.has('client_secret'), false)
  assert.equal(a.url.includes(a.verifier), false)
  assert.throws(() => createAttempt('x&client_secret=unsafe'), /invalid_app_key/)
})
test('callback accepts exactly one valid state and code', () => {
  const a = createAttempt(clientId), host = '127.0.0.1:53682'
  assert.deepEqual(parseCallback(`/dropbox/callback?state=${a.state}&code=synthetic`, host, host, a.state), { code: 'synthetic' })
  const bad = [
    `/dropbox/callback?state=wrong&code=x`,
    `/dropbox/callback?state=${a.state}&state=${a.state}&code=x`,
    `/dropbox/callback?state=${a.state}&code=x&code=y`,
    `/dropbox/callback?state=${a.state}&code=x&error=access_denied`,
    `/dropbox/callback?state=${a.state}&code=`,
    `/dropbox/callback?state=${a.state}&code=a%0ab`,
    `/another?state=${a.state}&code=x`,
    `//attacker.invalid/dropbox/callback?state=${a.state}&code=x`,
    `http://attacker.invalid/dropbox/callback?state=${a.state}&code=x`
  ]
  for (const url of bad) assert.throws(() => parseCallback(url, host, host, a.state))
  assert.throws(() => parseCallback(`/dropbox/callback?state=${a.state}&code=x`, 'attacker.invalid', host, a.state))
  assert.deepEqual(parseCallback(`/dropbox/callback?state=${a.state}&error=access_denied`, host, host, a.state), { denied: true })
})
test('loopback receiver rejects wrong Host/state/POST, accepts once, clears address via redirect', async () => {
  const a = createAttempt(clientId), r = await startReceiver({ state: a.state, port: 0 })
  try {
    assert.equal(r.address.address, '127.0.0.1')
    const base = `http://127.0.0.1:${r.address.port}`
    const path = `/dropbox/callback?state=${a.state}&code=SYNTHETIC_CODE`
    const invalidHost = await new Promise((resolve, reject) => {
      const req = request(base + path, { headers: { Host: 'attacker.invalid' } }, res => { res.resume(); resolve(res.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(invalidHost, 400)
    assert.equal((await fetch(base + '/dropbox/callback?state=bad&code=no')).status, 400)
    assert.equal((await fetch(base + path, { method: 'POST' })).status, 400)
    const response = await fetch(base + path, { redirect: 'manual' })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/done')
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(await r.result, 'SYNTHETIC_CODE')
    const done = await (await fetch(base + '/done')).text()
    assert.equal(done.includes('SYNTHETIC_CODE'), false)
    assert.equal((await fetch(base + path)).status, 409)
  } finally { r.stop() }
})
test('denial and timeout do not succeed, and receiver closes', async () => {
  const a = createAttempt(clientId), r = await startReceiver({ state: a.state, port: 0 })
  try {
    const rejected = assert.rejects(r.result, /user_denied/)
    await fetch(`http://127.0.0.1:${r.address.port}/dropbox/callback?state=${a.state}&error=access_denied`, { redirect: 'manual' })
    await rejected
  } finally { r.stop() }
  const timed = await startReceiver({ state: a.state, port: 0, timeoutMs: 20 })
  await assert.rejects(timed.result, /authorization_timed_out/)
  timed.stop()
})
test('tokens must include offline refresh and only the agreed scopes', () => {
  assert.equal(validateTokens(initial()).account_id, 'dbid:SYNTHETIC')
  for (const change of [
    { refresh_token: null }, { access_token: 'bad\nheader' }, { token_type: 'other' },
    { expires_in: -1 }, { expires_in: '14400' }, { scope: 'files.content.read' },
    { scope: `${SCOPES.join(' ')} sharing.write` }, { error: 'SENSITIVE_PROVIDER_ERROR' }
  ]) assert.throws(() => validateTokens({ ...initial(), ...change }))
})
test('exchange refresh and account verification are limited to official endpoints; no client secret', async () => {
  const a = createAttempt(clientId), calls = []
  const fetchImpl = async (url, options) => {
    calls.push([url, options])
    assert.equal(options.redirect, 'error'); assert.ok(options.signal)
    if (calls.length === 1) return reply(initial())
    if (calls.length === 2) return reply({ access_token: 'SYNTHETIC_NEW', token_type: 'bearer', expires_in: 14400 })
    return reply({ account_id: 'dbid:SYNTHETIC', email: 'fixture@example.invalid', disabled: false })
  }
  const result = await exchangeAndVerify(a, 'SYNTHETIC_CODE', { fetchImpl })
  assert.deepEqual(calls.map(c => c[0]), [
    'https://api.dropboxapi.com/oauth2/token', 'https://api.dropboxapi.com/oauth2/token',
    'https://api.dropboxapi.com/2/users/get_current_account'
  ])
  assert.equal(calls[0][1].body.get('code_verifier'), a.verifier)
  assert.equal(calls[0][1].body.has('client_secret'), false)
  assert.equal(calls[1][1].body.get('grant_type'), 'refresh_token')
  assert.equal(calls[1][1].body.has('client_secret'), false)
  assert.equal(result.display, 'fixture@example.invalid')
  assert.equal(result.credentials.refresh_token, 'SYNTHETIC_REFRESH')
  assert.equal('access_token' in result.credentials, false)
  assert.equal('email' in result.credentials, false)
})
test('account mismatch or disabled account refuses connection', async () => {
  for (const account of [{ account_id: 'dbid:OTHER' }, { account_id: 'dbid:SYNTHETIC', disabled: true }]) {
    let n = 0
    const fetchImpl = async () => reply(++n <= 2 ? initial() : account)
    await assert.rejects(exchangeAndVerify(createAttempt(clientId), 'SYNTHETIC_CODE', { fetchImpl }), /account_mismatch_or_disabled/)
  }
})
test('API errors and response limits never echo provider secrets', async () => {
  for (const [body, status, expected] of [
    ['SECRET_PROVIDER_RESPONSE', 400, 'dropbox_http_400'],
    ['SECRET_INVALID_JSON', 200, 'invalid_dropbox_response'],
    ['x'.repeat(65_537), 200, 'dropbox_response_too_large']
  ]) {
    await assert.rejects(exchangeAndVerify(createAttempt(clientId), 'SYNTHETIC_CODE', {
      fetchImpl: async () => new Response(body, { status })
    }), error => error.message === expected)
  }
  await assert.rejects(exchangeAndVerify(createAttempt(clientId), 'SYNTHETIC_CODE', {
    fetchImpl: async () => { throw new Error('SECRET_NETWORK_DETAIL') }
  }), error => error.message === 'dropbox_network_or_response_error')
})
test('local store source uses DPAPI CurrentUser, private ACL, CreateNew and no output of input', () => {
  const ps = readFileSync(new URL('./Save-Connection.ps1', import.meta.url), 'utf8')
  assert.match(ps, /DataProtectionScope\]::CurrentUser/)
  assert.match(ps, /SetAccessRuleProtection\(\$true,\$false\)/)
  assert.match(ps, /FileMode\]::CreateNew/)
  assert.match(ps, /ReparsePoint/)
  assert.match(ps, /In.ReadToEnd/)
  assert.doesNotMatch(ps, /Write-(Host|Output).*\$(text|record|plain|roundTrip)/)
  const runner = readFileSync(new URL('./connect.mjs', import.meta.url), 'utf8')
  assert.match(runner, /input: credentials \? JSON.stringify\(credentials\)/)
  assert.doesNotMatch(runner, /\bssh\b|\bscp\b|files\/upload|files\/delete/)
})
