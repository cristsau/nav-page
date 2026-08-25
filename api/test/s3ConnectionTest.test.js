import test from 'node:test'
import assert from 'node:assert/strict'
import { buildS3ListRequest, verifyS3Connection } from '../src/lib/s3ConnectionTest.js'

const connection = Object.freeze({
  endpoint: 'https://account.r2.cloudflarestorage.com',
  bucket: 'nav-backup',
  region: 'auto',
  addressingStyle: 'path',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  sessionToken: ''
})

test('S3 connection probe signs a bounded read-only list request', () => {
  const request = buildS3ListRequest(connection, new Date('2026-08-25T08:00:00.000Z'))
  assert.equal(request.url, 'https://account.r2.cloudflarestorage.com/nav-backup/?list-type=2&max-keys=1')
  assert.match(request.headers.authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\/20260825\/auto\/s3\/aws4_request/)
  assert.doesNotMatch(request.url, /test-access-key|test-secret-key/)
  assert.doesNotMatch(JSON.stringify(request.headers), /test-secret-key/)
})

test('S3 verification rejects redirects and accepts only a successful probe', async () => {
  let requested = null
  const result = await verifyS3Connection(connection, {
    now: new Date('2026-08-25T08:00:00.000Z'),
    assertEndpointImpl: async (value) => new URL(value),
    assertHostImpl: async () => [{ address: '203.0.113.10', family: 4 }],
    fetchImpl: async (url, options) => {
      requested = { url, options }
      return { ok: true, status: 200, headers: new Headers() }
    }
  })
  assert.equal(result.ok, true)
  assert.equal(requested.options.method, 'GET')
  assert.equal(requested.options.redirect, 'error')
})
