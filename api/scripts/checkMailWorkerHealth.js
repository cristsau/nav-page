import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const heartbeatPath = path.resolve(
  process.env.NAV_MAIL_WORKER_HEARTBEAT_FILE
    || path.join(os.tmpdir(), 'nav-mail-worker-heartbeat.json')
)
const maximumAgeMs = 60_000

try {
  const payload = JSON.parse(await fs.readFile(heartbeatPath, 'utf8'))
  const updatedAt = new Date(payload.updatedAt).getTime()
  if (!Number.isSafeInteger(Number(payload.pid)) || Number(payload.pid) <= 0) process.exit(1)
  if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maximumAgeMs) process.exit(1)
  process.exit(0)
} catch {
  process.exit(1)
}
