// Runs in a credential-free container; BT egress-filtered, transcode network:none.
import { writeFile, readFile, rename, lstat, unlink, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SPOOL, jobId, jobDirectory, safeDirectory, safeFile, readJson, atomicJson } from './media-fs.mjs'
import { processRun, delay } from './media-process.mjs'
import { magnetSource, torrentInput, torrentMetadata, selectTorrentFile, compatibleVideoArgs, verifyCompatibleVideo, videoOutputBudget, MEDIA_LIMIT, TORRENT_LIMIT } from './media-policy.mjs'
const RESERVE = 2 * 1024 ** 3
export async function space(required = 0) {
  const s = await statfs(SPOOL)
  if (s.bavail * s.bsize < required + RESERVE) throw Error('DOWNLOAD_DISK_LIMIT')
}
export const ariaArgs = dir => ['--no-conf=true', '--quiet=true', '--enable-rpc=false', '--enable-dht=true', '--enable-dht6=false',
  '--disable-ipv6=true', '--enable-peer-exchange=true', '--bt-enable-lpd=false', '--bt-max-peers=24', '--bt-max-open-files=16',
  '--max-concurrent-downloads=1', '--max-overall-download-limit=2M', '--max-overall-upload-limit=64K', '--seed-time=0',
  '--check-integrity=true', '--bt-hash-check-seed=false', '--file-allocation=none', '--disk-cache=8M', '--auto-file-renaming=false',
  '--allow-overwrite=false', '--follow-torrent=false', '--follow-metalink=false', '--save-session=', '--dht-file-path=/tmp/dht.dat',
  '--async-dns=true', '--async-dns-server=1.1.1.1,8.8.8.8', '--summary-interval=0', '--bt-stop-timeout=600', '--dir=' + dir]

export async function runBt(request, signal, update, run = processRun) {
  const directory = jobDirectory(request.id), metadataDir = join(directory, 'metadata'), payload = join(directory, 'payload')
  await safeDirectory(metadataDir, true); await safeDirectory(payload, true)
  let metadata
  if (request.kind === 'magnet') {
    const magnet = magnetSource(request.url), path = join(metadataDir, magnet.infoHash + '.torrent')
    let exists = false
    try { await safeFile(path, TORRENT_LIMIT); exists = true } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (!exists) {
      await update({ stage: 'metadata' })
      await run('/usr/bin/aria2c', [...ariaArgs(metadataDir), '--bt-metadata-only=true', '--bt-save-metadata=true', '--', magnet.uri], { signal, timeout: 10 * 60000 })
    }
    await safeFile(path, TORRENT_LIMIT); metadata = torrentMetadata(await readFile(path))
    if (metadata.infoHash !== magnet.infoHash) throw Error('TORRENT_HASH_MISMATCH')
  } else metadata = torrentInput(request.torrent)
  if (request.selection == null) return { state: 'selecting', files: metadata.files, total: metadata.total, infoHash: metadata.infoHash }
  const selected = selectTorrentFile(metadata, request.selection), input = join(metadataDir, 'validated.torrent')
  await space(metadata.total)
  // Exact sanitized input; no shell, web-seeds, command hooks, credentials or original paths.
  try { await safeFile(input, TORRENT_LIMIT); await unlink(input) } catch (e) { if (e.code !== 'ENOENT') throw e }
  await writeFile(input, Buffer.from(metadata.torrent, 'base64'), { flag: 'wx', mode: 0o600 })
  await update({ stage: 'bt_download', size: selected.size })
  await run('/usr/bin/aria2c', [...ariaArgs(payload), '--select-file=' + selected.index, '--torrent-file=' + input], { signal, timeout: 24 * 3600000 })
  // Every parent is checked; rename only a validated selected regular file.
  const parts = selected.path.split('/'); let parent = payload
  for (const part of parts.slice(0, -1)) { parent = join(parent, part); await safeDirectory(parent) }
  const result = join(parent, parts.at(-1)), stat = await safeFile(result, MEDIA_LIMIT)
  if (stat.size !== selected.size) throw Error('DOWNLOAD_SIZE_CHANGED')
  const output = join(directory, 'result.bin')
  try { await lstat(output); throw Error('MEDIA_OUTPUT_EXISTS') } catch (e) { if (e.code !== 'ENOENT') throw e }
  await rename(result, output)
  return { state: 'complete', size: stat.size }
}

const FORMATS = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpeg,mpegts,flv,ogg,asf'
export async function probe(path, signal, run = processRun) {
  const output = await run('/usr/bin/ffprobe', ['-v', 'error', '-threads', '1', '-max_alloc', '33554432', '-protocol_whitelist', 'file',
    '-format_whitelist', FORMATS, '-show_entries', 'format=duration:stream=codec_type,codec_name,pix_fmt,width,height', '-of', 'json', path], { signal, timeout: 60000 })
  let data
  try { data = JSON.parse(output) } catch { throw Error('TRANSCODE_INPUT_INVALID') }
  const video = data.streams?.find(s => s.codec_type === 'video'), duration = Number(data.format?.duration)
  if (!video || !Number.isFinite(duration) || duration <= 0 || duration > 14400 || !Number.isSafeInteger(video.width) || !Number.isSafeInteger(video.height) || video.width < 1 || video.height < 1 || video.width > 4096 || video.height > 2160) throw Error('TRANSCODE_INPUT_LIMIT')
  return { duration, video, audio: data.streams.filter(s => s.codec_type === 'audio') }
}
export async function runVideo(request, signal, update, run = processRun) {
  const directory = jobDirectory(request.id), input = join(directory, 'source.bin'), output = join(directory, 'compatible.mp4')
  const source = await safeFile(input, MEDIA_LIMIT)
  if (source.size !== request.size) throw Error('LOCAL_FILE_CHANGED')
  await update({ stage: 'inspecting' })
  const before = await probe(input, signal, run)
  await space(videoOutputBudget(before.duration))
  try { await safeFile(output, MEDIA_LIMIT); await unlink(output) } catch (e) { if (e.code !== 'ENOENT') throw e }
  const args = compatibleVideoArgs(directory, before.duration, source.size)
  args.splice(args.indexOf('-i'), 0, '-format_whitelist', FORMATS, '-max_alloc', '33554432')
  await update({ stage: 'transcoding', duration: before.duration })
  await run('/usr/bin/ffmpeg', args, { signal, timeout: 24 * 3600000, maxOutput: 262144 })
  await update({ stage: 'verifying' })
  const after = await probe(output, signal, run), stat = await safeFile(output, MEDIA_LIMIT)
  if (stat.size >= videoOutputBudget(before.duration)) throw Error('TRANSCODE_VERIFY_FAILED')
  verifyCompatibleVideo({ inputDuration: before.duration, outputDuration: after.duration, outputSize: stat.size,
    videoCodec: after.video.codec_name, pixelFormat: after.video.pix_fmt, audioCodecs: after.audio.map(a => a.codec_name) })
  await rename(output, join(directory, 'result.bin'))
  return { state: 'complete', size: stat.size }
}

export async function main(kind) {
  if (!['bt', 'video'].includes(kind) || process.platform !== 'linux' || process.getuid() !== 65532) throw Error('INVALID_MEDIA_RUNTIME')
  process.umask(0o077); await safeDirectory(SPOOL)
  let stopping = false, current
  const heartbeat = () => atomicJson(join(SPOOL, kind + '-ready.json'), { version: 1, kind, at: Date.now() })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopping = true; current?.abort() })
  const readyTimer = setInterval(() => heartbeat().catch(() => { stopping = true; current?.abort() }), 5000)
  try {
    await heartbeat()
    while (!stopping) {
      try {
        const lease = await readJson(join(SPOOL, 'active.json'), 1024)
        if (!jobId(lease.id) || !jobId(lease.attempt) || lease.until < Date.now() || lease.until > Date.now() + 30000) { await delay(1000); continue }
        const directory = jobDirectory(lease.id); await safeDirectory(directory)
        const request = await readJson(join(directory, 'request.json'))
        if (request.id !== lease.id || request.attempt !== lease.attempt || (request.kind === 'video') !== (kind === 'video')) { await delay(1000); continue }
        const statusPath = join(directory, 'status.json')
        let previous
        try { previous = await readJson(statusPath) } catch (e) { if (e.code !== 'ENOENT') throw e }
        if (previous?.attempt === lease.attempt && ['complete', 'selecting', 'error', 'stopped'].includes(previous.state)) { await delay(1000); continue }
        current = new AbortController(); let busy = false
        const timer = setInterval(async () => {
          if (busy) return; busy = true
          try { const fresh = await readJson(join(SPOOL, 'active.json'), 1024)
            if (fresh.id !== lease.id || fresh.attempt !== lease.attempt || fresh.until < Date.now()) throw Error('EXPIRED')
            await space()
          } catch { current?.abort() } finally { busy = false }
        }, 1000)
        const update = value => atomicJson(statusPath, { attempt: lease.attempt, state: 'running', ...value })
        try {
          try { await lstat(join(directory, 'result.bin')); throw Error('MEDIA_RESULT_REQUIRES_REVIEW') } catch (e) { if (e.code !== 'ENOENT') throw e }
          const result = await (kind === 'bt' ? runBt : runVideo)(request, current.signal, update)
          await update(result)
        } catch (error) { await update({ state: current.signal.aborted ? 'stopped' : 'error', error: /^[A-Z_]{1,64}$/.test(error.message) ? error.message : 'MEDIA_FAILED' }) }
        finally { clearInterval(timer); current = null }
      } catch (error) { if (error.code !== 'ENOENT') console.error('MEDIA_STATE_REQUIRES_REVIEW') }
      await delay(1000)
    }
  } finally { clearInterval(readyTimer) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv[2]).catch(() => { console.error('MEDIA_RUNTIME_START_FAILED'); process.exitCode = 1 })
