import test from 'node:test'
import assert from 'node:assert/strict'
import { buildApiRequestOptions } from '../../app/src/shared/services/apiClient.js'

test('bodyless API requests do not advertise an empty JSON document', () => {
  const options = buildApiRequestOptions({
    method: 'DELETE'
  })

  assert.equal(options.credentials, 'include')
  assert.equal(options.headers['Content-Type'], undefined)
})

test('API requests with a body default to JSON content type', () => {
  const options = buildApiRequestOptions({
    method: 'POST',
    body: JSON.stringify({ name: 'Personal' })
  })

  assert.equal(options.headers['Content-Type'], 'application/json')
})

test('API requests preserve an explicit content type header', () => {
  const options = buildApiRequestOptions({
    method: 'POST',
    body: 'name=Personal',
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    }
  })

  assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(options.headers['Content-Type'], undefined)
})
