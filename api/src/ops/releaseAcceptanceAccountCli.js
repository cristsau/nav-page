import { pool, withTransaction } from '../db/index.js'
import { hashPassword, validateNewPassword } from '../lib/auth.js'
import {
  cleanupReleaseAcceptanceAccount,
  inspectReleaseAcceptanceResidue,
  provisionReleaseAcceptanceAccount,
  ReleaseAcceptanceAccountError
} from './releaseAcceptanceAccount.js'

const MAX_STDIN_BYTES = 8 * 1024

async function readJsonInput() {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > MAX_STDIN_BYTES) {
      throw new ReleaseAcceptanceAccountError('INPUT_TOO_LARGE')
    }
    chunks.push(chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw || '{}')
  } catch {
    throw new ReleaseAcceptanceAccountError('INVALID_JSON_INPUT')
  }
}

async function provision() {
  const input = await readJsonInput()
  const password = String(input.password || '')
  if (!validateNewPassword(password).valid || password.length < 48) {
    throw new ReleaseAcceptanceAccountError('INVALID_ACCEPTANCE_PASSWORD')
  }
  const passwordHash = await hashPassword(password)
  const result = await withTransaction((client) => (
    provisionReleaseAcceptanceAccount(client, {
      runId: input.runId,
      username: input.username,
      passwordHash,
      clientIps: input.clientIps
    })
  ))
  return {
    ok: true,
    userId: result.userId,
    expiresAt: result.expiresAt
  }
}

async function cleanup() {
  const input = await readJsonInput()
  const result = await withTransaction((client) => (
    cleanupReleaseAcceptanceAccount(client, {
      runId: input.runId,
      expectedUsername: input.expectedUsername,
      expectedUserId: input.expectedUserId
    })
  ))
  return {
    ok: true,
    ...result
  }
}

async function status() {
  const result = await inspectReleaseAcceptanceResidue(pool)
  return {
    ok: true,
    ...result
  }
}

async function main() {
  const command = String(process.argv[2] || '')
  if (!['provision', 'cleanup', 'status'].includes(command)) {
    throw new ReleaseAcceptanceAccountError('INVALID_COMMAND')
  }

  const result = command === 'provision'
    ? await provision()
    : command === 'cleanup'
      ? await cleanup()
      : await status()
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

try {
  await main()
} catch (error) {
  const code = error instanceof ReleaseAcceptanceAccountError
    ? error.code
    : 'RELEASE_ACCEPTANCE_ACCOUNT_FAILED'
  process.stderr.write(`RELEASE_ACCEPTANCE_ACCOUNT_ERROR|code=${code}\n`)
  process.exitCode = 70
} finally {
  await pool.end().catch(() => {})
}
