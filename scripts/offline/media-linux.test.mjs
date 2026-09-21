// Execute only in the disposable, credential-free image with network:none.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { writeFile, readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { runVideo, probe } from './media-runner.mjs'
import { processRun } from './media-process.mjs'
import { safeDirectory, jobDirectory, removeJob } from './media-fs.mjs'
const enabled = process.env.NAV_MEDIA_DISPOSABLE_TEST === '1' && process.platform === 'linux'
test('real FFmpeg creates verified compatible copy, no credential mount, original stays unchanged', { skip: !enabled }, async () => {
  process.umask(0o077)
  await assert.rejects(lstat('/etc/nav-offline/worker.json'), { code: 'ENOENT' })
  const id = randomBytes(16).toString('hex'), dir = jobDirectory(id); await safeDirectory(dir, true)
  try {
    const input = join(dir, 'source.bin')
    await processRun('/usr/bin/ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '2', '-threads', '1', '-c:v', 'libx264', '-c:a', 'aac', '-f', 'matroska', input])
    const before = await readFile(input), stages = []
    const result = await runVideo({ id, size: before.length }, new AbortController().signal, async s => stages.push(s.stage))
    assert.equal(result.state, 'complete'); assert.deepEqual(await readFile(input), before)
    const output = await probe(join(dir, 'result.bin'))
    assert.equal(output.video.codec_name, 'h264'); assert.equal(output.video.pix_fmt, 'yuv420p'); assert.ok(result.size > 0)
    assert.deepEqual(stages, ['inspecting', 'transcoding', 'verifying'])
  } finally { await removeJob(id) }
})
test('playlist/external-reference input is rejected before any transcode', { skip: !enabled }, async () => {
  const id = randomBytes(16).toString('hex'), dir = jobDirectory(id); await safeDirectory(dir, true)
  try {
    const data = Buffer.from('#EXTM3U\n#EXTINF:10,\nfile:///etc/passwd\nhttp://169.254.169.254/latest/meta-data/\n')
    await writeFile(join(dir, 'source.bin'), data, { mode: 0o600 })
    await assert.rejects(runVideo({ id, size: data.length }, new AbortController().signal, async () => {}))
    await assert.rejects(lstat(join(dir, 'result.bin')), { code: 'ENOENT' })
  } finally { await removeJob(id) }
})
test('real subprocess timeout and cancellation stop the process group', { skip: !enabled }, async () => {
  const args = ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc2=size=16x16:rate=1', '-t', '30', '-f', 'null', '-']
  await assert.rejects(processRun('/usr/bin/ffmpeg', args, { timeout: 200 }), /MEDIA_TIMEOUT/)
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 200)
  try { await assert.rejects(processRun('/usr/bin/ffmpeg', args, { signal: controller.signal }), /MEDIA_INTERRUPTED/) } finally { clearTimeout(timer) }
})
