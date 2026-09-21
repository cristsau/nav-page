import { spawn } from 'node:child_process'
export const delay = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(Error('MEDIA_INTERRUPTED'))
  const timer = setTimeout(done, ms)
  function done() { signal?.removeEventListener('abort', abort); resolve() }
  function abort() { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(Error('MEDIA_INTERRUPTED')) }
  signal?.addEventListener('abort', abort, { once: true })
})
// No shell, no inherited secrets, bounded output, deadline and process-group stop.
export function processRun(command, args, { signal, timeout = 60000, maxOutput = 262144, cwd } = {}) {
  if (!['/usr/bin/ffmpeg', '/usr/bin/ffprobe', '/usr/bin/aria2c'].includes(command)) throw Error('MEDIA_COMMAND_INVALID')
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Error('MEDIA_INTERRUPTED'))
    const child = spawn(command, args, { shell: false, detached: true, cwd,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/tmp', OMP_NUM_THREADS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let failure, total = 0, output = [], killTimer
    const stop = code => { if (failure) return; failure = code; try { process.kill(-child.pid, 'SIGTERM') } catch {};
      killTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 1500) }
    const abort = () => stop('MEDIA_INTERRUPTED'), timer = setTimeout(() => stop('MEDIA_TIMEOUT'), timeout)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', value => { total += value.length; if (total > maxOutput) stop('MEDIA_OUTPUT_LIMIT'); else output.push(value) })
    // Never log untrusted stderr (paths, tracker data, file content).
    child.stderr.on('data', value => { total += value.length; if (total > maxOutput) stop('MEDIA_OUTPUT_LIMIT') })
    child.on('error', () => { failure = 'MEDIA_PROCESS_FAILED' })
    child.on('close', code => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort)
      if (failure || code !== 0) reject(Error(failure || 'MEDIA_PROCESS_FAILED')); else resolve(Buffer.concat(output).toString()) })
  })
}
