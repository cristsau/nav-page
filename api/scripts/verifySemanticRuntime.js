import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { env } from '@huggingface/transformers'
import { config } from '../src/config.js'
import { embedWorkspaceTexts, embeddingModelIdentity, cosineSimilarity } from '../src/lib/localEmbeddings.js'

// Fixed synthetic text only; the release image uses the existing pinned model.
// CI first warms an ephemeral cache, then repeats with --network none/read-only.
const originalFetch = env.fetch
const requests = []
env.fetch = async (...args) => {
  const url = new URL(String(args[0]))
  requests.push(url.hostname + url.pathname)
  return originalFetch(...args)
}
let vectors
try { vectors = await embedWorkspaceTexts([
  'A cat is sleeping on the sofa.',
  'A cat is sleeping on the sofa.',
  'The database transaction was committed.'
]) } catch (error) {
  console.error(JSON.stringify({ stage: 'model-load', error: error?.name,
    requests, cachedFiles: await readdir(config.embeddingCacheDir, { recursive: true }) }))
  throw error
} finally { env.fetch = originalFetch }
assert.equal(vectors.length, 3)
for (const vector of vectors) {
  assert.equal(vector.length, 384)
  assert.ok(vector.every(Number.isFinite))
  assert.ok(Math.abs(Math.hypot(...vector) - 1) < 0.01)
}
assert.ok(cosineSimilarity(vectors[0], vectors[1]) > 0.999)
assert.ok(cosineSimilarity(vectors[0], vectors[2]) < 0.95)
console.log(JSON.stringify({ status: 'PASS', model: embeddingModelIdentity(), dimensions: 384, samples: 3 }))
