import { pool, withTransaction } from '../db/index.js'
import {
  cleanupMailAcceptanceFixture,
  MailAcceptanceFixtureError,
  prepareMailAcceptanceFixture
} from './mailAcceptanceFixture.js'
import { applyManagedIntegrationsToRuntime } from '../lib/managedIntegrations.js'

const MAX_STDIN_BYTES = 8 * 1024

async function readJsonInput() {
  const chunks = []
  let length = 0
  for await (const chunk of process.stdin) {
    length += chunk.length
    if (length > MAX_STDIN_BYTES) {
      throw new MailAcceptanceFixtureError('INPUT_TOO_LARGE')
    }
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new MailAcceptanceFixtureError('INVALID_JSON_INPUT')
  }
}

async function main() {
  const command = String(process.argv[2] || '')
  if (!['prepare', 'cleanup'].includes(command)) {
    throw new MailAcceptanceFixtureError('INVALID_COMMAND')
  }
  // The API server and mail worker load settings stored under
  // NAV_MANAGED_INTEGRATIONS_DIR during startup. This CLI runs as a separate
  // Node process inside the same image, so it must apply that document too;
  // otherwise production installations that keep the mailbox encryption key
  // in the managed integration directory cannot create the encrypted fixture.
  await applyManagedIntegrationsToRuntime()
  const input = await readJsonInput()
  const result = await withTransaction((client) => (
    command === 'prepare'
      ? prepareMailAcceptanceFixture(client, input)
      : cleanupMailAcceptanceFixture(client, input)
  ))
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`)
}

try {
  await main()
} catch (error) {
  const code = error instanceof MailAcceptanceFixtureError
    ? error.code
    : 'MAIL_ACCEPTANCE_FIXTURE_FAILED'
  process.stderr.write(`MAIL_ACCEPTANCE_FIXTURE_ERROR|code=${code}\n`)
  process.exitCode = 70
} finally {
  await pool.end().catch(() => {})
}
