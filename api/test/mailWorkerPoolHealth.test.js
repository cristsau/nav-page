import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createMailWorkerPoolHealthMonitor } from '../src/lib/mailWorkerPoolHealth.js'

test('mail worker pool health reports bounded counts without alerting on transient waits', () => {
  let now = Date.parse('2026-09-01T00:00:00.000Z')
  const monitor = createMailWorkerPoolHealthMonitor({
    alertAfterMs: 60_000,
    now: () => now
  })

  const first = monitor.sample({ totalCount: 8, idleCount: 1, waitingCount: 2 })
  assert.equal(first.waitingDurationMs, 0)
  assert.equal(first.alerting, false)
  assert.equal(first.transition, null)

  now += 59_999
  const transient = monitor.sample({ totalCount: 8, idleCount: 0, waitingCount: 1 })
  assert.equal(transient.alerting, false)
})
test('mail worker pool health opens one alert and records recovery', () => {
  let now = Date.parse('2026-09-01T00:00:00.000Z')
  const monitor = createMailWorkerPoolHealthMonitor({
    alertAfterMs: 60_000,
    now: () => now
  })

  monitor.sample({ totalCount: 8, idleCount: 0, waitingCount: 1 })
  now += 60_000
  const alert = monitor.sample({ totalCount: 8, idleCount: 0, waitingCount: 3 })
  assert.equal(alert.alerting, true)
  assert.equal(alert.transition, 'alert')
  assert.equal(alert.waitingDurationMs, 60_000)

  now += 15_000
  assert.equal(monitor.sample({ totalCount: 8, idleCount: 1, waitingCount: 1 }).transition, null)

  now += 15_000
  const recovery = monitor.sample({ totalCount: 8, idleCount: 8, waitingCount: 0 })
  assert.equal(recovery.alerting, false)
  assert.equal(recovery.transition, 'recovery')
  assert.equal(recovery.waitingSince, null)
})

test('worker heartbeat and healthcheck include pool saturation state', async () => {
  const [worker, healthcheck, compose, env] = await Promise.all([
    fs.readFile(new URL('../src/mailWorker.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../scripts/checkMailWorkerHealth.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../docker-compose.backend.yml', import.meta.url), 'utf8'),
    fs.readFile(new URL('../.env.example', import.meta.url), 'utf8')
  ])
  assert.match(worker, /totalCount: poolHealth\.totalCount/)
  assert.match(worker, /MAIL_WORKER_DATABASE_POOL_WAITING/)
  assert.match(healthcheck, /pool\.alerting === true/)
  assert.match(compose, /NAV_MAIL_WORKER_POOL_WAIT_ALERT_SECONDS/)
  assert.match(env, /NAV_MAIL_WORKER_POOL_WAIT_ALERT_SECONDS=60/)
})
