import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createSourceAwareMaintenanceObserverGroup } from '../src/lib/sourceAwareMaintenanceObserver.js'

test('a healthy mailbox cannot hide another mailbox failure and only the failed source can recover it', async () => {
  const calls = []
  const group = createSourceAwareMaintenanceObserverGroup({
    async failed(payload) { calls.push(['failed', payload.source]) },
    async succeeded(payload) { calls.push(['succeeded', payload.source]) }
  }, { sourceKeys: ['mxroute', 'managed.0123456789abcdef01234567'] })
  const primary = group.forSource('mxroute')
  const secondary = group.forSource('managed.0123456789abcdef01234567')

  await primary.failed({ source: 'primary' })
  await secondary.succeeded({ source: 'secondary-healthy' })
  assert.deepEqual(calls, [['failed', 'primary']])
  assert.deepEqual(group.failingSources(), ['mxroute'])

  await primary.succeeded({ source: 'primary-recovered' })
  assert.deepEqual(calls, [
    ['failed', 'primary'],
    ['succeeded', 'primary-recovered']
  ])
  assert.deepEqual(group.failingSources(), [])
})

test('shared maintenance state recovers only after every failed mailbox recovers', async () => {
  const calls = []
  const group = createSourceAwareMaintenanceObserverGroup({
    async failed(payload) { calls.push(['failed', payload.source]) },
    async succeeded(payload) { calls.push(['succeeded', payload.source]) }
  }, { sourceKeys: ['mxroute', 'managed.0123456789abcdef01234567'] })
  const primary = group.forSource('mxroute')
  const secondary = group.forSource('managed.0123456789abcdef01234567')

  await primary.failed({ source: 'primary' })
  await secondary.failed({ source: 'secondary' })
  await primary.succeeded({ source: 'primary-recovered' })
  assert.equal(calls.some((call) => call[1] === 'primary-recovered'), false)
  await secondary.succeeded({ source: 'secondary-recovered' })
  assert.deepEqual(calls.at(-1), ['succeeded', 'secondary-recovered'])
})

test('cold start waits for every registered mailbox before clearing persisted failure state', async () => {
  const calls = []
  const group = createSourceAwareMaintenanceObserverGroup({
    async succeeded(payload) { calls.push(payload.source) }
  }, { sourceKeys: ['mxroute', 'managed.0123456789abcdef01234567'] })
  const primary = group.forSource('mxroute')
  const secondary = group.forSource('managed.0123456789abcdef01234567')

  await secondary.succeeded({ source: 'secondary-first' })
  assert.deepEqual(calls, [])
  await primary.succeeded({ source: 'primary-second' })
  assert.deepEqual(calls, ['primary-second'])
})

test('skipped locks never mark a source healthy and disabled sources are not pre-registered', async () => {
  const calls = []
  const group = createSourceAwareMaintenanceObserverGroup({
    async succeeded(payload) { calls.push(payload.source) }
  }, { sourceKeys: ['mxroute'] })
  const primary = group.forSource('mxroute')
  await primary.succeeded({ source: 'skipped', result: { skipped: 'already-running' } })
  assert.deepEqual(calls, [])
  await primary.succeeded({ source: 'completed', result: { processed: 0 } })
  assert.deepEqual(calls, ['completed'])
})

test('runtime controller registers only the sources enabled for each shared maintenance job', () => {
  const source = fs.readFileSync(new URL('../src/lib/emailRuntimeController.js', import.meta.url), 'utf8')
  assert.match(source, /const deliveryRuntimes = mailRuntimes\.filter\(\(item\) => item\.mailDeliveryEnabled\)/)
  assert.match(source, /const sentAppendRuntimes = mailRuntimes\.filter\(\(item\) => item\.emailSentAppendEnabled\)/)
  assert.match(source, /observerGroup\(MAINTENANCE_JOB_NAMES\.MAIL_DELIVERY,[\s\S]*?deliveryRuntimes\)/)
  assert.match(source, /observerGroup\(MAINTENANCE_JOB_NAMES\.EMAIL_SENT_APPEND,[\s\S]*?sentAppendRuntimes\)/)
  assert.match(source, /deliveryRuntimes\.forEach\(\(mailRuntime\) => starters\.push/)
  assert.match(source, /sentAppendRuntimes\.forEach\(\(mailRuntime\) => starters\.push/)
  assert.match(source, /reconcileFn = reconcileManagedMailRuntimeAccounts/)
  assert.match(source, /const reconciliation = await reconcileFn\(mailRuntimes\)/)
})
