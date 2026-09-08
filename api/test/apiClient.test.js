import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apiRequest,
  registerPasswordReauthHandler,
  buildApiRequestOptions,
  onApiUnauthorized,
  resetApiUnauthorizedNotification,
  shouldNotifyUnauthorized
} from '../../app/src/shared/services/apiClient.js'

test('sensitive API requests retry once after scoped password proof, never loop',async()=>{
 const original=globalThis.fetch
 let calls=0,proofs=0
 const unregister=registerPasswordReauthHandler(async action=>{
   proofs++;assert.deepEqual(action,{method:'GET',path:'/migration/export-cloud'})
 })
 try {
   globalThis.fetch=async()=>{calls++;return Response.json({code:'PASSWORD_REAUTH_REQUIRED'},{status:403})}
   await assert.rejects(apiRequest('/migration/export-cloud?format=json'),e=>e.code==='PASSWORD_REAUTH_REQUIRED')
   assert.equal(calls,2);assert.equal(proofs,1)
 } finally {unregister();globalThis.fetch=original}
})

test('cancelling password proof prevents the second business request',async()=>{
 const original=globalThis.fetch
 let calls=0
 const unregister=registerPasswordReauthHandler(async()=>{throw new Error('synthetic cancellation')})
 try {
   globalThis.fetch=async()=>{calls++;return Response.json({code:'PASSWORD_REAUTH_REQUIRED'},{status:403})}
   await assert.rejects(apiRequest('/migration/export-cloud'),/synthetic cancellation/)
   assert.equal(calls,1)
 } finally {unregister();globalThis.fetch=original}
})

test('bodyless API requests do not advertise an empty JSON document', () => {
  const options = buildApiRequestOptions({
    method: 'DELETE'
  })

  assert.equal(options.credentials, 'include')
  assert.equal(options.headers['Content-Type'], undefined)
})

test('API requests with a body default to JSON content type', () => {
  const options = buildApiRequestOptions({
    method: 'POST',
    body: JSON.stringify({ name: 'Personal' })
  })

  assert.equal(options.headers['Content-Type'], 'application/json')
})

test('API requests preserve an explicit content type header', () => {
  const options = buildApiRequestOptions({
    method: 'POST',
    body: 'name=Personal',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    }
  })

  assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(options.headers['Content-Type'], undefined)
})

test('public credential checks are excluded from global unauthorized invalidation', () => {
  assert.equal(shouldNotifyUnauthorized('/auth/login'), false)
  assert.equal(shouldNotifyUnauthorized('/auth/register?source=web'), false)
  assert.equal(shouldNotifyUnauthorized('/auth/recover/'), false)
  assert.equal(shouldNotifyUnauthorized('/auth/session'), true)
  assert.equal(shouldNotifyUnauthorized('/notes'), true)
  assert.equal(shouldNotifyUnauthorized('/notes', { expectedUnauthorized: true }), false)
})

test('internal unauthorized options are not passed to fetch', () => {
  const options = buildApiRequestOptions({
    method: 'POST',
    expectedUnauthorized: true,
    body: JSON.stringify({ username: 'cristau' })
  })

  assert.equal(options.expectedUnauthorized, undefined)
  assert.equal(options.headers['Content-Type'], 'application/json')
})

test('protected 401 responses notify subscribers once until authentication resets', async () => {
  const originalFetch = globalThis.fetch
  let notifications = 0
  const unsubscribe = onApiUnauthorized(() => {
    notifications += 1
  })
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: 'Authentication required' }),
    {
      status: 401,
      headers: { 'content-type': 'application/json' }
    }
  )

  try {
    resetApiUnauthorizedNotification()
    await assert.rejects(apiRequest('/notes'), (error) => error.status === 401)
    await assert.rejects(apiRequest('/media/images'), (error) => error.status === 401)
    assert.equal(notifications, 1)

    resetApiUnauthorizedNotification()
    await assert.rejects(apiRequest('/notes'), (error) => error.status === 401)
    assert.equal(notifications, 2)
  } finally {
    unsubscribe()
    resetApiUnauthorizedNotification()
    globalThis.fetch = originalFetch
  }
})

test('expected login 401 responses do not invalidate an existing session', async () => {
  const originalFetch = globalThis.fetch
  let notifications = 0
  const unsubscribe = onApiUnauthorized(() => {
    notifications += 1
  })
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: 'Invalid username or password' }),
    {
      status: 401,
      headers: { 'content-type': 'application/json' }
    }
  )

  try {
    resetApiUnauthorizedNotification()
    await assert.rejects(
      apiRequest('/auth/login', {
        method: 'POST',
        expectedUnauthorized: true,
        body: JSON.stringify({})
      }),
      (error) => error.status === 401
    )
    assert.equal(notifications, 0)
  } finally {
    unsubscribe()
    resetApiUnauthorizedNotification()
    globalThis.fetch = originalFetch
  }
})
