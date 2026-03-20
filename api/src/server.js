import { createApp } from './app.js'
import { ensureAdminUser } from './bootstrap.js'
import { config } from './config.js'
import { pool, runMigrations } from './db/index.js'

async function main() {
  await runMigrations()
  await ensureAdminUser()

  const app = createApp()

  const close = async () => {
    await app.close()
    await pool.end()
    process.exit(0)
  }

  process.on('SIGINT', close)
  process.on('SIGTERM', close)

  await app.listen({
    host: config.host,
    port: config.port
  })
}

main().catch(async (error) => {
  console.error(error)
  await pool.end()
  process.exit(1)
})
