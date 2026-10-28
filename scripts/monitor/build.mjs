// Pinned upstream frontends with a small reviewed NAV mount adapter.
import { execFileSync } from 'node:child_process'
import { mkdir, cp, writeFile, chmod } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join, sep } from 'node:path'
const root = resolve(import.meta.dirname, '../..')
const build = process.env.NAV_MONITOR_BUILD_DIR
if (!build || !resolve(build).startsWith(resolve(process.env.RUNNER_TEMP || 'D:/DomoDev') + sep)) throw Error('Explicit isolated monitor build directory required')
await mkdir(build, { recursive: false })
const run = (cmd, args, cwd, env = {}) => execFileSync(cmd, args, { cwd, env: { ...process.env, TZ: 'Asia/Shanghai', ...env }, stdio: 'inherit' })
const sources = [
  { name: 'hub', repo: 'monitor', tag: 'v1.5.1', sha: 'da5c6667bfdf9494c2e1aa1e763c7d14f6544278', path: 'web-admin', patch: 'admin.patch', out: 'admin' },
  { name: 'theme', repo: 'monitor-theme-default', tag: 'v1.4.2', sha: '6cd1ed45601167ce44aad52d99df227785302f74', path: '.', patch: 'theme.patch', out: '.' }
]
const destination = join(root, 'app/dist/monitor-app')
await mkdir(destination, { recursive: true })
for (const source of sources) {
  const checkout = join(build, source.name), web = join(checkout, source.path)
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', source.tag, 'https://github.com/monitor-probe/' + source.repo + '.git', checkout], root)
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: checkout, encoding: 'utf8' }).trim() !== source.sha) throw Error('Upstream commit mismatch')
  run('git', ['apply', '--check', join(root, 'integrations/monitor', source.patch)], checkout)
  run('git', ['apply', join(root, 'integrations/monitor', source.patch)], checkout)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], web)
  run(npm, ['test'], web)
  run(npm, ['run', 'build'], web, { NAV_MONITOR_EMBED: '1' })
  await cp(join(web, 'dist'), join(destination, source.out), { recursive: true })
  await cp(join(checkout, 'LICENSE'), join(destination, 'LICENSE-' + source.name + '.txt'))
}
const binaries = [
  { repo: 'monitor', tag: 'v1.5.1', name: 'monitor-hub-x86_64-unknown-linux-musl', file: 'monitor-hub', sha: '5275d4cc6a01409428031453c6020629c1a7a6f5de5da44c555d1cccc4174d76' },
  { repo: 'agent', tag: 'v1.2.3', name: 'monitor-agent-x86_64-unknown-linux-musl', file: 'monitor-agent', sha: '3d19446f6e37b5e88385c170ddf9ff4abea82445a6d16868b494f3884506a174' }
]
for (const binary of binaries) {
  const response = await fetch(`https://github.com/monitor-probe/${binary.repo}/releases/download/${binary.tag}/${binary.name}`, { signal: AbortSignal.timeout(120000) })
  if (!response.ok) throw Error('Official binary download failed')
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 12 * 1024 ** 2 || createHash('sha256').update(bytes).digest('hex') !== binary.sha) throw Error('Official binary digest mismatch')
  await writeFile(join(build, binary.file), bytes, { mode: 0o700 }); await chmod(join(build, binary.file), 0o700)
}
await writeFile(join(destination, 'provenance.json'), JSON.stringify({ sources, binaries }, null, 2))
console.log('MONITOR_BUILD_PASS: pinned sources, patches, upstream tests and binary digests')
