import { pool, runMigrations } from './index.js'

async function main() {
  await runMigrations()
  console.log('migrations complete')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
