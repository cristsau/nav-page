// Durable single-writer controller. No provider credentials, paths or shell input
// come from callers. The host adapter owns all IO and the exclusive process lock.
export const ID = /^[a-f0-9]{32}$/
const validId = v => typeof v === 'string' && ID.test(v)
const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const iso = v => typeof v === 'string' && Number.isFinite(Date.parse(v))
const terminal = new Set(['succeeded', 'failed'])
export class ControlError extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status }
}
const fail = (code, status) => { throw new ControlError(code, status) }
export const initialControlState = () => ({ version: 1, revision: 0, schedule: { enabled: false, time: '03:45', lastDay: null }, jobs: [] })
export function validateControlState(s) {
  if (s?.version !== 1 || !Number.isSafeInteger(s.revision) || s.revision < 0 || typeof s.schedule?.enabled !== 'boolean'
    || typeof s.schedule.time !== 'string' || !time.test(s.schedule.time) || !(s.schedule.lastDay === null || (typeof s.schedule.lastDay === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.schedule.lastDay)))
    || !Array.isArray(s.jobs) || s.jobs.length > 50) fail('CONTROL_STATE_INVALID', 503)
  const ids = new Set()
  for (const j of s.jobs) {
    if (!j || !validId(j.id) || ids.has(j.id) || !['backup', 'verify'].includes(j.kind)
      || !['manual', 'schedule'].includes(j.source) || !['queued', 'running', 'review', ...terminal].includes(j.state)
      || !['queued', 'snapshot', 'upload', 'verify', 'completed', 'stopped'].includes(j.stage)
      || !iso(j.createdAt) || !iso(j.updatedAt) || !(j.pointId === null || validId(j.pointId))
      || (j.kind === 'verify' && !j.pointId) || !(j.code === null || /^[A-Z_]{1,64}$/.test(j.code))) fail('CONTROL_STATE_INVALID', 503)
    ids.add(j.id)
  }
  if (s.jobs.filter(j => ['queued', 'running', 'review'].includes(j.state)).length > 1) fail('CONTROL_STATE_INVALID', 503)
  return s
}
function chinaClock(now) {
  const d = new Date(now.getTime() + 8 * 3600_000).toISOString()
  return { day: d.slice(0, 10), time: d.slice(11, 16) }
}
export class BackupController {
  #state; #save; #execute; #gates; #now; #queue = Promise.resolve(); #running = false; #poisoned = false
  constructor({ state, save, execute, gates, now = () => new Date() }) {
    this.#state = structuredClone(validateControlState(state)); this.#save = save; this.#execute = execute; this.#gates = gates; this.#now = now
  }
  #serial(fn) {
    const result = this.#queue.then(() => { if (this.#poisoned) fail('CONTROL_STORE_UNAVAILABLE', 503); return fn() })
    this.#queue = result.catch(() => {}); return result
  }
  async #commit(next) {
    validateControlState(next)
    try { await this.#save(next) } catch { this.#poisoned = true; fail('CONTROL_STORE_UNAVAILABLE', 503) }
    this.#state = next
  }
  async recover() {
    return this.#serial(async () => {
      const next = structuredClone(this.#state)
      for (const j of next.jobs) if (j.state === 'running') {
        j.state = 'review'; j.stage = 'stopped'; j.code = 'INTERRUPTED_REVIEW_REQUIRED'; j.updatedAt = this.#now().toISOString()
      }
      if (JSON.stringify(next) !== JSON.stringify(this.#state)) await this.#commit(next)
    })
  }
  async status() {
    return this.#serial(async () => {
      const g = await this.#gates()
      return { connected: true, revision: this.#state.revision, timezone: 'Asia/Shanghai',
        schedule: { ...this.#state.schedule, active: this.#state.schedule.enabled && g.schedule === true && !this.#blocked(),
          blockedReason: this.#blocked() ? 'REVIEW_REQUIRED' : g.schedule !== true ? 'SCHEDULE_GATE_CLOSED' : null },
        capabilities: { backup: g.backup === true, verify: g.verify === true, download: g.download === true, schedule: g.schedule === true },
        busy: this.#busy(), reviewRequired: this.#blocked(), jobs: structuredClone(this.#state.jobs).reverse() }
    })
  }
  #busy() { return this.#state.jobs.some(j => ['queued', 'running'].includes(j.state)) }
  #blocked() { return this.#state.jobs.some(j => j.state === 'review') }
  async #enqueue(input, source, day = null) {
    if (!input || Object.keys(input).some(k => !['id', 'kind', 'pointId'].includes(k)) || !validId(input.id)
      || !['backup', 'verify'].includes(input.kind) || (input.kind === 'verify' ? !validId(input.pointId) : input.pointId != null)) fail('INVALID_OPERATION', 400)
    const prior = this.#state.jobs.find(j => j.id === input.id)
    if (prior) {
      if (prior.kind !== input.kind || prior.pointId !== (input.pointId || null) || prior.source !== source) fail('IDEMPOTENCY_CONFLICT')
      return structuredClone(prior)
    }
    if (this.#blocked()) fail('REVIEW_REQUIRED')
    if (this.#busy()) fail('BACKUP_BUSY')
    const gates = await this.#gates()
    if (gates[input.kind] !== true || (source === 'schedule' && gates.schedule !== true)) fail('OPERATION_DISABLED', 503)
    const next = structuredClone(this.#state), now = this.#now()
    // Retain deduplication receipts for at least 72 hours. Never silently evict
    // an in-flight/unknown result to make space for another cloud operation.
    next.jobs = next.jobs.filter(j => !terminal.has(j.state) || now - new Date(j.updatedAt) < 72 * 3600_000)
    if (next.jobs.length >= 50) fail('HISTORY_LIMIT')
    const job = { id: input.id, kind: input.kind, pointId: input.pointId || null, source, state: 'queued', stage: 'queued',
      code: null, createdAt: now.toISOString(), updatedAt: now.toISOString() }
    next.jobs.push(job)
    if (day) next.schedule.lastDay = day
    await this.#commit(next)
    return structuredClone(job)
  }
  enqueue(input) { return this.#serial(() => this.#enqueue(input, 'manual')) }
  setSchedule(input) {
    return this.#serial(async () => {
      if (!input || Object.keys(input).sort().join(',') !== 'enabled,revision,time' || typeof input.enabled !== 'boolean'
        || typeof input.time !== 'string' || !time.test(input.time) || input.revision !== this.#state.revision) fail('SCHEDULE_CONFLICT')
      if (input.enabled && (await this.#gates()).schedule !== true) fail('SCHEDULE_GATE_CLOSED')
      const next = structuredClone(this.#state)
      next.revision++
      next.schedule = { enabled: input.enabled, time: input.time, lastDay: chinaClock(this.#now()).day }
      // A setting change never starts a catch-up backup. First run is tomorrow.
      await this.#commit(next)
      return { saved: true, revision: next.revision }
    })
  }
  tick(id) {
    return this.#serial(async () => {
      const clock = chinaClock(this.#now()), s = this.#state.schedule
      if (!s.enabled || s.lastDay === clock.day || clock.time < s.time || this.#busy() || this.#blocked()) return null
      if ((await this.#gates()).schedule !== true) return null
      return this.#enqueue({ id, kind: 'backup' }, 'schedule', clock.day)
    })
  }
  async #update(id, values) {
    return this.#serial(async () => {
      const next = structuredClone(this.#state), j = next.jobs.find(j => j.id === id)
      if (!j || j.state !== 'running') fail('JOB_CHANGED')
      Object.assign(j, values, { updatedAt: this.#now().toISOString() }); await this.#commit(next)
    })
  }
  async runNext() {
    if (this.#running) return
    this.#running = true
    let job
    try {
      job = await this.#serial(async () => {
        const next = structuredClone(this.#state), j = next.jobs.find(j => j.state === 'queued')
        if (!j) return null
        const g = await this.#gates()
        if (!g[j.kind] || (j.source === 'schedule' && (!g.schedule || !next.schedule.enabled))) {
          j.state = 'failed'; j.stage = 'stopped'; j.code = 'OPERATION_DISABLED'; j.updatedAt = this.#now().toISOString()
          await this.#commit(next); return null
        }
        j.state = 'running'; j.stage = j.kind === 'backup' ? 'snapshot' : 'verify'; j.updatedAt = this.#now().toISOString()
        await this.#commit(next); return structuredClone(j)
      })
      if (!job) return
      const result = await this.#execute(job, async stage => {
        if (!['snapshot', 'upload', 'verify'].includes(stage)) fail('INVALID_STAGE')
        await this.#update(job.id, { stage })
      })
      if (result?.verified !== true) fail('RESULT_UNVERIFIED')
      await this.#update(job.id, { state: 'succeeded', stage: 'completed', code: null })
    } catch (e) {
      if (job && !this.#poisoned) await this.#update(job.id, { state: job.kind === 'backup' ? 'review' : 'failed', stage: 'stopped',
        code: job.kind === 'backup' ? 'BACKUP_REVIEW_REQUIRED' : 'VERIFICATION_FAILED' })
      if (this.#poisoned || !job) throw e
    } finally { this.#running = false }
  }
}
