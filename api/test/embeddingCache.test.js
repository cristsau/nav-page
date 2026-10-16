import test from 'node:test'
import assert from 'node:assert/strict'
import { createCachedEmbeddingExtractor, loadPinnedFeatureExtractor } from '../src/lib/localEmbeddings.js'

const options = { revision: 'fixed-revision', dtype: 'q8', device: 'cpu' }
test('public model and tokenizer components receive the exact revision and offline flag', async () => {
  const calls = [], tokenizer = {}, encoder = {}, pinned = { ...options, local_files_only: true }
  class FeatureExtractionPipeline { constructor(value) { Object.assign(this, value) } }
  const runtime = { FeatureExtractionPipeline,
    AutoTokenizer: { from_pretrained: async (...args) => { calls.push(args); return tokenizer } },
    AutoModel: { from_pretrained: async (...args) => { calls.push(args); return encoder } } }
  const result = await loadPinnedFeatureExtractor(runtime, 'feature-extraction', 'fixed-model', pinned,
    { tokenizerDirectory: async () => '/fixed-pinned-cache' })
  assert.deepEqual(calls, [['/fixed-pinned-cache', pinned], ['fixed-model', pinned]])
  assert.equal(result.model, encoder)
  assert.equal(result.tokenizer, tokenizer)
})
test('warm model never attempts remote optional-file probes', async () => {
  const calls = [], extractor = () => {}
  assert.equal(await createCachedEmbeddingExtractor(async (...args) => { calls.push(args); return extractor }, 'fixed-model', options), extractor)
  assert.deepEqual(calls, [['feature-extraction', 'fixed-model', { ...options, local_files_only: true }]])
})
test('missing local model downloads only the same pinned CPU model once', async () => {
  const calls = [], extractor = () => {}
  const result = await createCachedEmbeddingExtractor(async (...args) => {
    calls.push(args)
    if (calls.length === 1) throw Object.assign(new Error('missing'), { name: 'ModelFileNotFoundError' })
    return extractor
  }, 'fixed-model', options)
  assert.equal(result, extractor)
  assert.deepEqual(calls.map(c => c[2]), [{ ...options, local_files_only: true }, { ...options, local_files_only: false }])
})
test('corrupt model or runtime failure does not trigger network fallback', async () => {
  let calls = 0
  const failure = new Error('synthetic native failure')
  await assert.rejects(createCachedEmbeddingExtractor(async () => { calls++; throw failure }, 'fixed-model', options), error => error === failure)
  assert.equal(calls, 1)
})
