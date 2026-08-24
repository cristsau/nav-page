import {
  embeddingModelIdentity,
  embedWorkspaceTexts
} from '../src/lib/localEmbeddings.js'

const [vector] = await embedWorkspaceTexts(['DOMO NAV 语义搜索模型预热'])
if (!Array.isArray(vector) || !vector.length) {
  throw new Error('Embedding model prewarm did not return a vector')
}

console.log(JSON.stringify({
  ok: true,
  model: embeddingModelIdentity(),
  dimensions: vector.length
}))
