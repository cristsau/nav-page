import { readFile, lstat } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'

// Resolve before importing config.js: secrets never enter image layers or argv.
async function secret(name) {
  const path = `/run/secrets/${name}`
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > 4096) {
    throw new Error(`Invalid secret file: ${name}`)
  }
  const value = (await readFile(path, 'utf8')).trim()
  if (!value || /[\r\n\0]/.test(value)) throw new Error(`Invalid secret format: ${name}`)
  return value
}
try {
  const password = await secret('db_password')
  process.env.DATABASE_URL = `postgresql://nav:${encodeURIComponent(password)}@db:5432/nav`
  process.env.ADMIN_PASSWORD = await secret('admin_password')
  process.env.NAV_RATE_LIMIT_KEY_SECRET = await secret('rate_limit_key')
  // Only the current Compose web peer is trusted; never accept arbitrary proxies.
  const addresses = await lookup('web', { all: true })
  process.env.TRUSTED_PROXY_ADDRESSES = addresses.map(item => item.address).join(',')
  await import('./src/server.js')
} catch {
  console.error('NAV startup failed. Check secret permissions, web DNS and local configuration; no credentials were logged.')
  process.exitCode = 1
}
