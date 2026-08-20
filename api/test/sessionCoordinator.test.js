import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createSessionCoordinator,
  DEFAULT_SESSION_REVALIDATE_INTERVAL_MS
} from '../../app/src/shared/services/sessionCoordinator.js'

function deferred() {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function makeCoordinator(resolveSession, { now = () => 1_000 } = {}) {
  let cached = null
  const commits = []
  const coordinator = createSessionCoordinator({
    resolveSession,
    readCachedSession: () => cached,
    commitSession: (session) => {
      cached = session
      commits.push(session)
    },
    now
  })
  return {
    coordinator,
    commits,
    getCached: () => cached
  }
}

test('concurrent initial session checks share one in-flight request', async () => {
  const request = deferred()
  let calls = 0
  const { coordinator, commits, getCached } = makeCoordinator(() => {
    calls += 1
    return request.promise
  })

  const first = coordinator.initialize()
  const second = coordinator.initialize()

  assert.strictEqual(first, second)
  assert.equal(calls, 0)
  await Promise.resolve()
  assert.equal(calls, 1)

  const user = { id: 'user-1', username: 'cristau' }
  request.resolve(user)
  assert.deepEqual(await first, user)
  assert.deepEqual(getCached(), user)
  assert.deepEqual(commits, [user])
})

test('concurrent forced revalidations share one in-flight request', async () => {
  const request = deferred()
  let calls = 0
  const user = { id: 'user-1', username: 'cristau' }
  const { coordinator } = makeCoordinator(() => {
    calls += 1
    return request.promise
  })
  coordinator.accept(user)

  const first = coordinator.revalidate({ force: true })
  const second = coordinator.revalidate({ force: true })

  assert.strictEqual(first, second)
  await Promise.resolve()
  assert.equal(calls, 1)
  request.resolve(user)
  assert.deepEqual(await first, user)
})

test('logout invalidation wins over a late initial session response', async () => {
  const request = deferred()
  const { coordinator, commits, getCached } = makeCoordinator(() => request.promise)

  const pending = coordinator.initialize()
  await Promise.resolve()
  coordinator.invalidate()
  request.resolve({ id: 'stale-user' })

  assert.equal(await pending, null)
  assert.equal(getCached(), null)
  assert.deepEqual(commits, [null])
})

test('an explicit 401 invalidates the cached session', async () => {
  const unauthorized = Object.assign(new Error('Authentication required'), { status: 401 })
  const { coordinator, commits, getCached } = makeCoordinator(async () => {
    throw unauthorized
  })
  coordinator.accept({ id: 'user-1' })

  const result = await coordinator.revalidate({ force: true })

  assert.equal(result, null)
  assert.equal(getCached(), null)
  assert.deepEqual(commits, [{ id: 'user-1' }, null])
})

test('a null session response explicitly invalidates the cached session', async () => {
  const { coordinator, getCached } = makeCoordinator(async () => null)
  coordinator.accept({ id: 'user-1' })

  assert.equal(await coordinator.revalidate({ force: true }), null)
  assert.equal(getCached(), null)
})

test('a network failure preserves the cached authenticated session', async () => {
  const networkError = new TypeError('fetch failed')
  const { coordinator, commits, getCached } = makeCoordinator(async () => {
    throw networkError
  })
  const user = { id: 'user-1' }
  coordinator.accept(user)

  await assert.rejects(
    coordinator.revalidate({ force: true }),
    (error) => error === networkError
  )
  assert.deepEqual(getCached(), user)
  assert.deepEqual(commits, [user])
})

test('revalidation remains in-memory until the five minute interval expires', async () => {
  let clock = 5_000
  let calls = 0
  const user = { id: 'user-1' }
  const { coordinator } = makeCoordinator(async () => {
    calls += 1
    return user
  }, { now: () => clock })
  coordinator.accept(user)

  assert.deepEqual(await coordinator.revalidate(), user)
  assert.equal(calls, 0)

  clock += DEFAULT_SESSION_REVALIDATE_INTERVAL_MS
  assert.deepEqual(await coordinator.revalidate(), user)
  assert.equal(calls, 1)
})
