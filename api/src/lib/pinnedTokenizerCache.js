import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const FILES = ['tokenizer.json', 'tokenizer_config.json']
const MAX_BYTES = 32 * 1024 * 1024
const missing = () => Object.assign(new Error('Pinned tokenizer is not cached'), { name: 'ModelFileNotFoundError' })

export async function pinnedTokenizerDirectory(cacheRoot, model, revision, { localOnly, fetchImpl = fetch } = {}) {
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(model) || !/^[a-f0-9]{40}$/.test(revision)) {
    throw new Error('Embedding model must use an immutable repository revision')
  }
  const directory = join(resolve(cacheRoot), model, revision)
  for (const name of FILES) {
    const target = join(directory, name)
    try {
      const stat = await lstat(target)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid pinned tokenizer cache')
      JSON.parse(await readFile(target, 'utf8'))
      continue
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (localOnly) throw missing()
    const response = await fetchImpl(`https://huggingface.co/${model}/resolve/${revision}/${name}`, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Pinned tokenizer download failed') }
    const reader = response.body.getReader(), chunks = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > MAX_BYTES) throw new Error('Pinned tokenizer exceeds size limit')
        chunks.push(value)
      }
    } finally { await reader.cancel(); reader.releaseLock() }
    const bytes = Buffer.concat(chunks)
    JSON.parse(bytes.toString('utf8'))
    await mkdir(directory, { recursive: true })
    const temporary = join(directory, '.' + name + '.' + randomUUID() + '.tmp')
    const fd = await open(temporary, 'wx', 0o600)
    try {
      await fd.writeFile(bytes); await fd.sync(); await fd.close()
      await rename(temporary, target)
    } finally { await fd.close().catch(() => {}); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  return directory
}
