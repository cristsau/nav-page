import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function validateAnswers({ mode, origin, username, password }) {
  if (!['local', 'public'].includes(mode)) throw new Error('Mode must be local or public')
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a bare HTTPS origin without a path')
  }
  if (mode === 'local' && url.origin !== 'https://localhost:8443') throw new Error('Local mode uses https://localhost:8443')
  if (mode === 'public' && (url.port || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname))) {
    throw new Error('Public mode requires your DNS domain, HTTPS port 443 and no IP literal')
  }
  if (!/^[a-z][a-z0-9._-]{2,31}$/.test(username)) throw new Error('Admin name: 3-32 lowercase letters, numbers, dot, underscore or dash')
  if (Array.from(password).length < 15 || Array.from(password).length > 128 || password !== password.trim() || /[\x00-\x1f\x7f]/.test(password)) {
    throw new Error('Use a unique 15-128 character passphrase without leading/trailing whitespace')
  }
  return { mode, origin: url.origin, username, hostname: url.hostname, publicHost: url.host }
}

export async function initialize(root, answers) {
  root = resolve(root)
  if (realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Package root cannot be a symbolic link')
  for (const name of ['config', '.env']) {
    if (existsSync(join(root, name))) throw new Error('Configuration already exists; use manage.sh start. It will not be overwritten')
  }
  const settings = validateAnswers(answers)
  const { validateNewPassword } = await import(pathToFileURL(join(root, 'source/api/src/lib/auth.js')))
  if (!validateNewPassword(answers.password).valid) throw new Error('Choose a longer, less common administrator passphrase')
  const info = JSON.parse(readFileSync(join(root, 'package-info.json')))
  const images = JSON.parse(readFileSync(join(root, 'image-lock.json')))
  if (!/^[a-f0-9]{40}$/.test(info.sourceRevision) || !/^[a-z0-9][a-z0-9.-]{0,60}$/.test(info.version)) throw new Error('Invalid package identity')
  for (const [name, repository] of [['node', 'node'], ['postgres', 'postgres'], ['caddy', 'caddy']]) {
    if (!new RegExp(`^${repository}:[a-zA-Z0-9.-]+@sha256:[a-f0-9]{64}$`).test(images[name] || '')) throw new Error('Package image pin is missing')
  }
  const project = `domonav-${randomBytes(6).toString('hex')}`
  const dir = join(root, 'config')
  mkdirSync(dir, { mode: 0o700 })
  mkdirSync(join(dir, 'secrets'), { mode: 0o700 })
  const write = (path, content) => writeFileSync(path, content, { mode: 0o600, flag: 'wx' })
  write(join(dir, 'secrets/db-password'), randomBytes(32).toString('hex'))
  write(join(dir, 'secrets/admin-password'), answers.password)
  write(join(dir, 'secrets/rate-limit-key'), randomBytes(32).toString('hex'))
  write(join(dir, 'secrets/auth-email-keys'), JSON.stringify({ version: 1, hmacKey: randomBytes(32).toString('hex'), encryptionKey: randomBytes(32).toString('hex') }))
  const caddy = readFileSync(join(root, 'Caddyfile.template'), 'utf8')
    .replaceAll('@@HOST@@', settings.hostname)
    .replaceAll('@@PUBLIC_HOST@@', settings.publicHost)
    .replaceAll('@@TLS@@', settings.mode === 'local' ? 'tls internal' : '# Public ACME certificate automation')
  write(join(dir, 'Caddyfile'), caddy)
  write(join(dir, 'api.env'), [
    '# Optional features stay disabled until configured and tested.',
    'NAV_MAIL_DELIVERY_ENABLED=false', 'NAV_REGISTRATION_EMAIL_ENABLED=false',
    'NAV_TURNSTILE_ENABLED=false', 'NAV_DEVICE_KEYS_ENABLED=false',
    'NAV_SEMANTIC_SEARCH_ENABLED=false', 'NAV_EMBEDDING_SCHEDULER_ENABLED=false',
    'NAV_WEB_PUSH_ENABLED=false', 'NAV_BOOKMARK_HEALTH_SCHEDULER_ENABLED=false',
    'NAV_SECURITY_EVENT_RETENTION_ENABLED=false', 'NAV_MEDIA_DELETE_RETRY_ENABLED=false',
    'NAV_NOTE_REMINDER_SCHEDULER_ENABLED=false', 'NAV_AI_USAGE_RETENTION_ENABLED=false', ''
  ].join('\n'))
  write(join(dir, 'settings.json'), JSON.stringify({ schema: 1, ...settings, project, packageVersion: info.version }, null, 2))
  write(join(root, '.env'), [
    `COMPOSE_PROJECT_NAME=${project}`, `NAV_PACKAGE_VERSION=${info.version}`,
    `NAV_SOURCE_REVISION=${info.sourceRevision}`, `NAV_PUBLIC_APP_ORIGIN=${settings.origin}`,
    `NAV_ADMIN_USERNAME=${settings.username}`, `NAV_BIND_ADDRESS=${settings.mode === 'local' ? '127.0.0.1' : '0.0.0.0'}`,
    `NAV_HTTP_PORT=${settings.mode === 'local' ? '8080' : '80'}`, `NAV_HTTPS_PORT=${settings.mode === 'local' ? '8443' : '443'}`,
    `NAV_NODE_IMAGE=${images.node}`, `NAV_POSTGRES_IMAGE=${images.postgres}`, `NAV_CADDY_IMAGE=${images.caddy}`, ''
  ].join('\n'))
  return { origin: settings.origin, project }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    const [mode, origin, username, password] = input.split('\n')
    await initialize(process.cwd(), { mode, origin, username, password })
    console.log('Configuration initialized. Secrets were not printed.')
  } catch (error) {
    // Validation messages are fixed strings and never include user input.
    console.error(error instanceof TypeError ? 'Invalid installation input' : error.message)
    process.exitCode = 1
  }
}
