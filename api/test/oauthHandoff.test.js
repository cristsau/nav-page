import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createOauthHandoffs, requireHandoffOrigin, validHandoffSecret, setHandoffCookie } from '../src/lib/oauthHandoff.js'
import { sessionLifetimeDays, sessionCookieMaxAge } from '../src/lib/sessionPolicy.js'

const origin = 'https://nav.skrskr.net'
const hash = text => createHash('sha256').update(text).digest('hex')

test('session trust is explicit, absolute, bounded and shared by cookie and database policy', () => {
  for (const value of [false, undefined, 'true', 1, {}, null]) assert.equal(sessionLifetimeDays(value), 14)
  assert.equal(sessionLifetimeDays(true), 30)
  assert.equal(sessionCookieMaxAge(true), 30 * 86400)
  assert.equal(sessionLifetimeDays(false, { sessionTtlDays: 3 }), 3)
  assert.equal(sessionLifetimeDays(false, { sessionTtlDays: 365 }), 14)
  assert.equal(sessionLifetimeDays(false, { sessionTtlDays: NaN }), 14)
})

test('PWA handoff requires exact origin, never an alternate domain or extension', () => {
  assert.doesNotThrow(() => requireHandoffOrigin({ headers: { origin } }, origin))
  for (const other of ['', 'null', 'https://nav.cristsau.cn', origin + '/', 'https://evil.example']) {
    assert.throws(() => requireHandoffOrigin({ headers: { origin: other } }, origin), { code: 'OAUTH_HANDOFF_ORIGIN' })
  }
  assert.equal(validHandoffSecret('x'.repeat(43)), true)
  assert.equal(validHandoffSecret('x'.repeat(42)), false)
  assert.equal(validHandoffSecret('+' + 'x'.repeat(42)), false)
  const cookies = []
  setHandoffCookie({ setCookie: (...args) => cookies.push(args) }, 'x'.repeat(43))
  assert.deepEqual(cookies[0][2], { httpOnly: true, secure: true, sameSite: 'strict', path: '/api/auth/oauth', maxAge: 600 })
})

test('launch and claim secrets are distinct; database stores only digests and a safe return path', async () => {
  const statements = []
  const client = { query: async (sql, params) => { statements.push({ sql, params }); return { rows: [], rowCount: 0 } } }
  const store = createOauthHandoffs({ ...client, withTransaction: fn => fn(client) })
  const result = await store.begin({ origin, provider: 'google', returnTo: '//evil.example', trustDevice: 'true' })
  assert.match(result.claim, /^[\w-]{43}$/)
  assert.match(result.launch, /^[\w-]{43}$/)
  assert.notEqual(result.claim, result.launch)
  const insert = statements.find(value => value.sql.includes('INSERT INTO'))
  assert.deepEqual(insert.params, ['google', origin, hash(result.claim), hash(result.launch), '/', false])
  assert.equal(JSON.stringify(statements).includes(result.claim), false)
  assert.equal(JSON.stringify(statements).includes(result.launch), false)
  const queriesBefore = statements.length
  assert.equal(await store.launch({ origin, provider: 'google', secret: 'bad' }), null)
  assert.deepEqual(await store.inspect({ origin, claim: 'bad' }), { state: 'expired' })
  assert.equal(statements.length, queriesBefore)
})

test('launch is bound to provider, origin, freshness and exactly one use', async () => {
  let query
  const store = createOauthHandoffs({ query: async (sql, params) => { query = { sql, params }; return { rows: [] } } })
  assert.equal(await store.launch({ origin, provider: 'google', secret: 'a'.repeat(43) }), null)
  assert.deepEqual(query.params, [hash('a'.repeat(43)), origin, 'google'])
  for (const constraint of ['launched_at IS NULL', 'launch_expires_at>NOW()', 'expires_at>NOW()']) assert.ok(query.sql.includes(constraint))
})

test('completion consumes its proof and rechecks live user version/identity before minting any session', async () => {
  for (const invalid of [null, 'version', 'status', 'identity']) {
    const statements = []
    const client = { query: async (sql, params) => {
      statements.push({ sql, params })
      if (sql.includes('SELECT u.*')) return { rows: [{ id: 'user-a', status: invalid === 'status' ? 'frozen' : 'approved', auth_version: 4 }] }
      if (sql.includes('SELECT h.*')) return { rows: [{ id: 'flow-a', credential_version: invalid === 'version' ? 3 : 4,
        identity_user_id: invalid === 'identity' ? 'user-b' : 'user-a', identity_id: 'identity-a', trust_device: true, return_path: '/whisper' }] }
      return { rows: [], rowCount: 1 }
    } }
    const store = createOauthHandoffs({ withTransaction: fn => fn(client) })
    let minted = 0
    const result = await store.finish({ origin, claim: 'a'.repeat(43), createSession: async (_client, user, trust) => {
      assert.equal(statements.at(-1).sql, 'DELETE FROM auth_oauth_handoffs WHERE id=$1')
      assert.equal(user.identity_id, 'identity-a')
      assert.equal(trust, true)
      minted += 1
      return { token: 'synthetic-test-session', user }
    } })
    assert.equal(minted, invalid ? 0 : 1)
    assert.equal(Boolean(result), !invalid)
    assert.match(statements[0].sql, /FOR UPDATE OF u/)
    assert.match(statements[1].sql, /FOR UPDATE OF h,i/)
    assert.match(statements[1].sql, /expires_at>NOW\(\)/)
  }
})

test('approval also rejects anonymous handoffs started before a credential change',async()=>{
 let statement
 const client={query:async(sql,params)=>{statement={sql,params};return {rowCount:0}}}
 const store=createOauthHandoffs({})
 const changed=new Date()
 assert.equal(await store.approve(client,{id:'flow',origin,provider:'google',user:{id:'user',identity_id:'identity',auth_version:4,auth_changed_at:changed}}),false)
 assert.match(statement.sql,/created_at >= \$7::timestamptz/)
 assert.equal(statement.params[6],changed)
})
