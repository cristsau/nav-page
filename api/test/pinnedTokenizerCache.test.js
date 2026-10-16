import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pinnedTokenizerDirectory } from '../src/lib/pinnedTokenizerCache.js'
const revision = 'a'.repeat(40)
test('cold tokenizer fetches only pinned JSON; warm/offline load makes no request', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nav-tokenizer-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const urls = []
  const fetchImpl = async url => { urls.push(url); return new Response('{"synthetic":true}') }
  await assert.rejects(pinnedTokenizerDirectory(root, 'fixture/model', revision, { localOnly: true, fetchImpl }), { name: 'ModelFileNotFoundError' })
  assert.equal(urls.length, 0)
  const directory = await pinnedTokenizerDirectory(root, 'fixture/model', revision, { fetchImpl })
  assert.deepEqual(urls, ['tokenizer.json','tokenizer_config.json'].map(name => `https://huggingface.co/fixture/model/resolve/${revision}/${name}`))
  assert.equal(await readFile(join(directory, 'tokenizer.json'), 'utf8'), '{"synthetic":true}')
  assert.equal(await pinnedTokenizerDirectory(root, 'fixture/model', revision, { localOnly: true, fetchImpl: () => { throw new Error('network forbidden') } }), directory)
  await writeFile(join(directory, 'tokenizer.json'), 'broken')
  await assert.rejects(pinnedTokenizerDirectory(root, 'fixture/model', revision, { fetchImpl }), SyntaxError)
  assert.equal(urls.length, 2)
})
test('unfixed revisions and path escape are rejected before IO', async () => {
  for (const [model, rev] of [['fixture/model','main'],['../escape',revision],['fixture/../../escape',revision]]) {
    await assert.rejects(pinnedTokenizerDirectory('/unused', model, rev), /immutable/)
  }
})
test('failed download never installs a tokenizer cache file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nav-tokenizer-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await assert.rejects(pinnedTokenizerDirectory(root, 'fixture/model', revision, { fetchImpl: async () => new Response('denied', { status: 403 }) }), /download failed/)
  await assert.rejects(readFile(join(root, 'fixture/model', revision, 'tokenizer.json')), { code: 'ENOENT' })
})
