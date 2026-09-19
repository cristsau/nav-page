import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { authorizeFileLibrary, validateSeparateApps, windowsPowerShellEnvironment, storeFilesConnection } from './connect-files.mjs'
import { SCOPES, REDIRECT_URI } from './oauth.mjs'

const config = { clientId: 'SyntheticFiles123', backupClientId: 'SyntheticBackup123' }
function fixture(overrides = {}) {
  const calls = []
  const io = {
    confirmApp: async () => 'YES',
    store: async (id, mode, credentials) => { calls.push(['store', id, mode, credentials]) },
    startReceiver: async () => ({ result: Promise.resolve('SYNTHETIC_CODE'), stop: () => calls.push(['stop']) }),
    openBrowser: async url => { calls.push(['browser', url]) },
    exchange: async attempt => ({ display: 'fixture@example.invalid', credentials: { client_id: attempt.clientId, refresh_token: 'SYNTHETIC_REFRESH' } }),
    confirmAccount: async () => 'YES', ...overrides
  }
  return { io, calls }
}

test('Full Dropbox uses a distinct valid app; backup app cannot be reused', () => {
  assert.doesNotThrow(() => validateSeparateApps(config.clientId, config.backupClientId))
  assert.throws(() => validateSeparateApps(config.clientId, config.clientId), /backup_app_must_remain_separate/)
  for (const invalid of ['', 'x', 'bad&key=1', null]) assert.throws(() => validateSeparateApps(invalid, config.backupClientId))
})
test('no storage/browser/network before explicit Full Dropbox confirmation', async () => {
  const f = fixture({ confirmApp: async () => 'NO' })
  await assert.rejects(authorizeFileLibrary(config, f.io), /authorization_cancelled/)
  assert.deepEqual(f.calls, [])
  await assert.rejects(authorizeFileLibrary({ ...config, clientId: config.backupClientId }, f.io), /backup_app_must_remain_separate/)
  assert.deepEqual(f.calls, [])
})
test('preflight failure stops before browser/OAuth; no replacement of existing credentials', async () => {
  const f = fixture({ store: async () => { throw new Error('store_unavailable') } })
  await assert.rejects(authorizeFileLibrary(config, f.io), /store_unavailable/)
  assert.deepEqual(f.calls, [])
})
test('successful flow binds new app, exact scopes, offline PKCE, account consent and closes callback', async () => {
  const f = fixture()
  assert.equal(await authorizeFileLibrary(config, f.io), 'NAV_FILES_AUTHORIZATION_SAVED')
  const [check, browser, saved, stop] = f.calls
  assert.deepEqual(check.slice(0, 3), ['store', config.clientId, 'Check'])
  const url = new URL(browser[1])
  assert.equal(url.origin, 'https://www.dropbox.com')
  assert.equal(url.searchParams.get('client_id'), config.clientId)
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI)
  assert.equal(url.searchParams.get('token_access_type'), 'offline')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.deepEqual(url.searchParams.get('scope').split(' '), SCOPES)
  assert.deepEqual(saved.slice(0, 3), ['store', config.clientId, 'Store'])
  assert.equal(saved[3].client_id, config.clientId)
  assert.deepEqual(stop, ['stop'])
})
test('account rejection and app mismatch never save and always close callback', async () => {
  for (const [overrides, reason] of [
    [{ confirmAccount: async () => 'NO' }, /account_not_confirmed/],
    [{ exchange: async () => ({ credentials: { client_id: config.backupClientId } }) }, /app_identity_mismatch/],
    [{ openBrowser: async () => { throw new Error('browser_failed') } }, /browser_failed/],
    [{ exchange: async () => { throw new Error('exchange_failed') } }, /exchange_failed/]
  ]) {
    const f = fixture(overrides)
    await assert.rejects(authorizeFileLibrary(config, f.io), reason)
    assert.equal(f.calls.some(c => c[2] === 'Store'), false)
    assert.deepEqual(f.calls.at(-1), ['stop'])
  }
})
test('launcher stores only through stdin DPAPI helper and has no server/file operations', () => {
  const source = readFileSync(new URL('./connect-files.mjs', import.meta.url), 'utf8')
  assert.match(source, /input: credentials \? JSON.stringify\(credentials\)/)
  assert.match(source, /Save-Connection\.ps1/)
  assert.doesNotMatch(source, /\bssh\b|\bscp\b|files\/upload|files\/delete|writeFile|client_secret/)
  assert.match(source, /process.stdin.isTTY/)
})

test('PowerShell child environment strips inherited module paths case-insensitively, without changing parent', () => {
  const original = { PSModulePath: 'INCOMPATIBLE', psmodulepath: 'OTHER', Path: 'RETAIN', SystemRoot: 'RETAIN_SYSTEM' }
  assert.deepEqual(windowsPowerShellEnvironment(original), { Path: 'RETAIN', SystemRoot: 'RETAIN_SYSTEM' })
  assert.equal(original.PSModulePath, 'INCOMPATIBLE')
  const source = readFileSync(new URL('./connect-files.mjs', import.meta.url), 'utf8')
  assert.match(source, /env: \{ \.\.\.windowsPowerShellEnvironment\(\), NAV_DROPBOX_CONSENT_URL: url \}/)
})

test('real store bridge passes isolated environment and credentials only on stdin', () => {
  const credentials = { client_id: config.clientId, refresh_token: 'SYNTHETIC_TEST_SECRET' }
  let calls = 0
  const spawnImpl = (_exe, args, options) => {
    calls++
    assert.equal(Object.keys(options.env).some(k => k.toLowerCase() === 'psmodulepath'), false)
    assert.equal(options.env.Path, 'RETAIN')
    assert.equal(args.includes('SYNTHETIC_TEST_SECRET'), false)
    assert.equal(options.windowsHide, true)
    if (args.at(-1) === 'Check') {
      assert.equal(options.input, '')
      return { status: 0, stdout: '{"status":"LOCAL_STORE_READY"}' }
    }
    assert.deepEqual(JSON.parse(options.input), credentials)
    return { status: 0, stdout: '{"status":"LOCAL_AUTHORIZATION_SAVED"}' }
  }
  const deps = { spawnImpl, environment: { PSModulePath: 'BAD', Path: 'RETAIN' } }
  storeFilesConnection(config.clientId, 'Check', undefined, deps)
  storeFilesConnection(config.clientId, 'Store', credentials, deps)
  assert.equal(calls, 2)
})

test('store bridge errors do not disclose stdout/stderr or input', () => {
  for (const result of [
    { status: 1, stdout: '{"status":"LOCAL_STORE_FAILED","reason":"platform_error"}' },
    { status: null, stdout: '', stderr: 'SYNTHETIC_SECRET' },
    { status: 0, stdout: 'SYNTHETIC_SECRET' }
  ]) assert.throws(() => storeFilesConnection(config.clientId, 'Check', undefined, { spawnImpl: () => result }),
    e => e.message === 'private_local_store_unavailable')
  assert.throws(() => storeFilesConnection(config.clientId, 'Check', undefined, {
    spawnImpl: () => ({ status: 1, stdout: '{"reason":"connection_already_exists_no_overwrite"}' })
  }), /connection_already_exists_no_overwrite/)
})
