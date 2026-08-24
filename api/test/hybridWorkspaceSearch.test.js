import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateBm25Scores } from '../src/lib/hybridWorkspaceSearch.js'
import { cosineSimilarity } from '../src/lib/localEmbeddings.js'
import { tokenizeWorkspaceText } from '../src/lib/workspaceSearchIndex.js'

test('multilingual tokenizer keeps Latin terms and overlapping Chinese grams', () => {
  const tokens = tokenizeWorkspaceText('  ＮＡＶ 部署恢复  API  ')
  assert.ok(tokens.includes('nav'))
  assert.ok(tokens.includes('api'))
  assert.ok(tokens.includes('部署'))
  assert.ok(tokens.includes('恢复'))
  assert.ok(tokens.includes('部署恢'))
})

test('BM25 ranks the document with stronger weighted term frequency first', () => {
  const documents = [
    { id: 'weak', document_length: 20, term_frequencies: { 部署: 1 } },
    { id: 'strong', document_length: 20, term_frequencies: { 部署: 5 } },
    { id: 'other', document_length: 20, term_frequencies: { 恢复: 3 } }
  ]
  const scores = calculateBm25Scores(documents, ['部署'])
  assert.ok(scores.get('strong') > scores.get('weak'))
  assert.equal(scores.has('other'), false)
})

test('cosine similarity rejects invalid vectors and preserves semantic ordering', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([1], [1, 2]), null)
  assert.equal(cosineSimilarity([], []), null)
})
