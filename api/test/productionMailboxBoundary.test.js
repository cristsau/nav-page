import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const retiredPackages = new Set(['imapflow', 'mailparser', 'pdfjs-dist', 'saxes', 'yauzl'])

test('production API import graph cannot load retired mailbox clients or extractors', async () => {
  const visited = new Set()
  const pending = [resolve(root, 'src/server.js')]
  while (pending.length) {
    const path = pending.pop()
    if (visited.has(path)) continue
    visited.add(path)
    const source = await readFile(path, 'utf8')
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)]
    for (const [, specifier] of imports) {
      const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
      assert.equal(retiredPackages.has(packageName), false, `${path} imports ${specifier}`)
      if (specifier.startsWith('.') && specifier.endsWith('.js')) pending.push(resolve(dirname(path), specifier))
    }
  }
  assert.ok(visited.size > 20)
  assert.equal([...visited].some((path) => path.endsWith('emailRuntimeController.js')), false)
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  for (const name of retiredPackages) {
    assert.equal(Object.hasOwn(packageJson.dependencies, name), false)
    assert.ok(packageJson.devDependencies[name], `${name} retained only for historical recovery tests`)
  }
})
