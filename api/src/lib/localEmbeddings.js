import { config } from '../config.js'

let extractorPromise = null
let extractorError = null

function normalizeVector(value) {
  const vector = Array.from(value || [], Number)
  if (!vector.length || vector.some((item) => !Number.isFinite(item))) {
    throw new Error('Embedding model returned an invalid vector')
  }
  return vector
}

async function createExtractor() {
  const transformers = await import('@huggingface/transformers')
  transformers.env.cacheDir = config.embeddingCacheDir
  transformers.env.allowRemoteModels = true
  return transformers.pipeline('feature-extraction', config.embeddingModel, {
    dtype: 'q8',
    revision: config.embeddingModelRevision
  })
}

export function embeddingModelIdentity() {
  return `${config.embeddingModel}@${config.embeddingModelRevision}`
}

export async function getEmbeddingExtractor() {
  if (extractorError) throw extractorError
  if (!extractorPromise) {
    extractorPromise = createExtractor().catch((error) => {
      extractorError = error
      throw error
    })
  }
  return extractorPromise
}

export async function embedWorkspaceTexts(texts) {
  const input = Array.isArray(texts) ? texts.map((text) => String(text || '')) : []
  if (!input.length) return []
  const extractor = await getEmbeddingExtractor()
  const output = await extractor(input, { pooling: 'mean', normalize: true })
  const values = output.tolist()
  return values.map(normalizeVector)
}

export function cosineSimilarity(left, right) {
  const a = Array.from(left || [], Number)
  const b = Array.from(right || [], Number)
  if (!a.length || a.length !== b.length) return null
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < a.length; index += 1) {
    if (!Number.isFinite(a[index]) || !Number.isFinite(b[index])) return null
    dot += a[index] * b[index]
    leftNorm += a[index] * a[index]
    rightNorm += b[index] * b[index]
  }
  if (!leftNorm || !rightNorm) return null
  return dot / Math.sqrt(leftNorm * rightNorm)
}

export function resetEmbeddingExtractorForTests() {
  extractorPromise = null
  extractorError = null
}
