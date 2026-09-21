// Disposable GitHub Linux runner only. All payloads synthetic, no user accounts.
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, chmod, chown, rm, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
if (process.env.GITHUB_ACTIONS !== 'true' || process.platform !== 'linux' || process.getuid() !== 0) throw Error('DISPOSABLE_RUNNER_REQUIRED')
const suffix = randomBytes(5).toString('hex'), network = 'nav-media-ci-' + suffix, seed = network + '-seed', worker = network + '-bt'
const root = await mkdtemp(join(tmpdir(), network + '-')), spool = join(root, 'spool'), fixture = join(root, 'seed')
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 90000, maxBuffer: 1000000 })
const bencode = value => Buffer.isBuffer(value) ? Buffer.concat([Buffer.from(value.length + ':'), value]) : typeof value === 'string' ? bencode(Buffer.from(value)) : typeof value === 'number' ? Buffer.from(`i${value}e`) : Array.isArray(value) ? Buffer.concat([Buffer.from('l'), ...value.map(bencode), Buffer.from('e')]) : Buffer.concat([Buffer.from('d'), ...Object.keys(value).sort().flatMap(key => [bencode(key), bencode(value[key])]), Buffer.from('e')])
async function file(path, value) { const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp'; await writeFile(temp, value, { mode: 0o600 }); await chown(temp, 65532, 65532); await rename(temp, path) }
async function dir(path) { await mkdir(path, { mode: 0o700 }); await chown(path, 65532, 65532) }
let leaseTimer
try {
  await chmod(root, 0o755); await dir(spool); await dir(fixture); await dir(join(fixture, 'bundle'))
  const first = Buffer.alloc(333333, 17), second = Buffer.alloc(123456, 29), combined = Buffer.concat([first, second]), pieces = []
  for (let start = 0; start < combined.length; start += 16384) pieces.push(createHash('sha1').update(combined.subarray(start, start + 16384)).digest())
  const info = { name: 'bundle', files: [{ length: first.length, path: ['one.bin'] }, { length: second.length, path: ['two.bin'] }], 'piece length': 16384, pieces: Buffer.concat(pieces) }
  const torrent = bencode({ announce: 'http://11.253.0.2:8080/announce', info }), hash = createHash('sha1').update(bencode(info)).digest('hex')
  await file(join(fixture, 'fixture.torrent'), torrent); await file(join(fixture, 'bundle/one.bin'), first); await file(join(fixture, 'bundle/two.bin'), second)
  const tracker = `const http=require('node:http'),{spawn}=require('node:child_process'); const peers=Buffer.from([11,253,0,2,26,225]); http.createServer((q,s)=>{s.end(Buffer.concat([Buffer.from('d8:intervali2e5:peers6:'),peers,Buffer.from('e')]))}).listen(8080,'0.0.0.0'); const p=spawn('/usr/bin/aria2c',['--no-conf','--quiet=true','--dir=/fixture','--torrent-file=/fixture/fixture.torrent','--check-integrity=true','--seed-time=20','--listen-port=6881','--enable-dht=false','--enable-dht6=false','--enable-peer-exchange=false','--disable-ipv6=true','--bt-enable-lpd=false']);p.on('exit',c=>{if(c)process.exit(c)});`
  await file(join(fixture, 'seed.cjs'), tracker)
  docker(['network', 'create', '--internal', '--subnet', '11.253.0.0/24', network])
  docker(['run', '-d', '--name', seed, '--network', network, '--ip', '11.253.0.2', '--user', '65532:65532', '--cap-drop', 'ALL', '--read-only', '--security-opt', 'no-new-privileges', '--memory', '128m', '--tmpfs', '/tmp:rw,size=16m', '-v', fixture + ':/fixture', '--entrypoint', 'node', 'nav-media:test', '/fixture/seed.cjs'])
  docker(['run', '-d', '--name', worker, '--network', network, '--ip', '11.253.0.3', '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'SETPCAP', '--read-only', '--security-opt', 'no-new-privileges', '--memory', '128m', '--pids-limit', '64', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '-v', spool + ':/var/lib/nav-media', 'nav-media:test', 'bt'])
  for (let i = 0; i < 30; i++) { try { await readFile(join(spool, 'bt-ready.json')); break } catch { if (i === 29) throw Error('BT_NOT_READY'); await sleep(1000) } }
  const check = `const fs=require('node:fs'),net=require('node:net');if(fs.existsSync('/etc/nav-offline/worker.json'))throw Error('credential mount'); Promise.all(['127.0.0.1','10.0.0.1','169.254.169.254','172.81.57.10','15.204.56.108','192.168.1.1','::1'].map(host=>new Promise((resolve,reject)=>{const s=net.connect({host,port:8080});s.setTimeout(1000);s.on('connect',()=>{s.destroy();reject(Error('private reachable'))});s.on('error',()=>resolve());s.on('timeout',()=>{s.destroy();resolve()})}))).then(()=>console.log('PRIVATE_EGRESS_DENIED')).catch(()=>process.exit(1));`
  if (!docker(['exec', '--user', '65532:65532', worker, 'node', '-e', check]).includes('PRIVATE_EGRESS_DENIED')) throw Error('NETWORK_TEST_FAILED')
  const id = randomBytes(16).toString('hex'), attempt = randomBytes(16).toString('hex'), directory = join(spool, id)
  await dir(directory)
  async function request(kind, selection, newAttempt) {
    await file(join(directory, 'request.json'), JSON.stringify({ id, attempt: newAttempt, kind, url: `magnet:?xt=urn:btih:${hash}&tr=${encodeURIComponent('http://11.253.0.2:8080/announce')}`, selection }))
    const lease = () => file(join(spool, 'active.json'), JSON.stringify({ id, attempt: newAttempt, until: Date.now() + 15000 }))
    await lease(); leaseTimer = setInterval(() => lease().catch(() => {}), 5000)
    try {
      for (let i = 0; i < 150; i++) {
        let status; try { status = JSON.parse(await readFile(join(directory, 'status.json'), 'utf8')) } catch {}
        if (status?.attempt === newAttempt && ['complete', 'selecting', 'error', 'stopped'].includes(status.state)) return status
        await sleep(1000)
      }
      throw Error('BT_FIXTURE_TIMEOUT')
    } finally { clearInterval(leaseTimer) }
  }
  const listing = await request('magnet', null, attempt)
  if (listing.state !== 'selecting' || listing.files.length !== 2 || listing.infoHash !== hash) throw Error('MAGNET_METADATA_FAILED:' + (listing.error || listing.state))
  const result = await request('magnet', 2, randomBytes(16).toString('hex'))
  if (result.state !== 'complete') throw Error('BT_DOWNLOAD_FAILED:' + (result.error || result.state))
  const bytes = await readFile(join(directory, 'result.bin'))
  if (!bytes.equals(second)) throw Error('BT_FIXTURE_HASH_MISMATCH')
  console.log(JSON.stringify({ status: 'PASS', metadata: true, explicitSelection: true, downloadedHashVerified: true, privateNetworkDenied: true, userData: false }))
} finally {
  clearInterval(leaseTimer)
  for (const name of [worker, seed]) { try { docker(['rm', '-f', name]) } catch {} }
  try { docker(['network', 'rm', network]) } catch {}
  // Exact freshly generated disposable fixture directory only.
  if (root.startsWith(join(tmpdir(), network + '-'))) await rm(root, { recursive: true, force: true })
}
