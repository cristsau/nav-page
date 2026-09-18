// Synthetic test helper: produce the same tree/sha256 manifest structure as nav-backup.sh.
import { lstat, readdir, readFile, writeFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export async function sealFixture(snapshot) {
  const treeFile = join(snapshot, 'metadata/tree.tsv')
  await writeFile(treeFile, '', { mode: 0o600 })
  const rows = [], files = []
  async function walk(relative) {
    for (const name of await readdir(join(snapshot, relative))) {
      const path = relative ? `${relative}/${name}` : name
      if (path === 'manifest.sha256') continue
      const full = join(snapshot, path), s = await lstat(full)
      const type = s.isSymbolicLink() ? 'l' : s.isDirectory() ? 'd' : 'f'
      rows.push(`${type}\t${(s.mode & 0o7777).toString(8)}\t${path}\t${type === 'l' ? await readlink(full) : ''}`)
      if (type === 'd') await walk(path)
      if (type === 'f') files.push(path)
    }
  }
  await walk('')
  await writeFile(treeFile, rows.sort().join('\n') + '\n')
  const manifest = []
  for (const path of files.sort()) manifest.push(`${createHash('sha256').update(await readFile(join(snapshot, path))).digest('hex')}  ./${path}`)
  await writeFile(join(snapshot, 'manifest.sha256'), manifest.join('\n') + '\n', { mode: 0o600 })
}
