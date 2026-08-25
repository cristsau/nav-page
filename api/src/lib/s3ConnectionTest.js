import { createHash, createHmac } from 'node:crypto'
import { assertSafeOutboundEndpoint, assertSafeOutboundHost } from './outboundEndpoints.js'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value).digest(encoding)
}

function amzTimestamp(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value || '')).replace(/[!'()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ))
}

export function buildS3ListRequest(config, now = new Date()) {
  const endpoint = new URL(config.endpoint)
  const bucket = String(config.bucket || '')
  const region = String(config.region || 'auto')
  const virtualHosted = config.addressingStyle === 'virtual'
  if (virtualHosted) endpoint.hostname = `${bucket}.${endpoint.hostname}`
  const basePath = endpoint.pathname.replace(/\/+$/, '')
  endpoint.pathname = virtualHosted
    ? `${basePath || ''}/`
    : `${basePath || ''}/${encodePathSegment(bucket)}/`
  endpoint.search = '?list-type=2&max-keys=1'

  const timestamp = amzTimestamp(now)
  const dateStamp = timestamp.slice(0, 8)
  const payloadHash = sha256('')
  const headers = {
    host: endpoint.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': timestamp
  }
  if (config.sessionToken) headers['x-amz-security-token'] = config.sessionToken
  const signedHeaderNames = Object.keys(headers).sort()
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${String(headers[name]).trim()}\n`).join('')
  const canonicalRequest = [
    'GET',
    endpoint.pathname,
    'list-type=2&max-keys=1',
    canonicalHeaders,
    signedHeaderNames.join(';'),
    payloadHash
  ].join('\n')
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', timestamp, scope, sha256(canonicalRequest)].join('\n')
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, dateStamp)
  const regionKey = hmac(dateKey, region)
  const serviceKey = hmac(regionKey, 's3')
  const signingKey = hmac(serviceKey, 'aws4_request')
  const signature = hmac(signingKey, stringToSign, 'hex')
  return {
    url: endpoint.toString(),
    headers: {
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': timestamp,
      ...(config.sessionToken ? { 'x-amz-security-token': config.sessionToken } : {}),
      authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`
    }
  }
}

export async function verifyS3Connection(
  config,
  { fetchImpl = fetch, now = new Date(), assertEndpointImpl = assertSafeOutboundEndpoint, assertHostImpl = assertSafeOutboundHost } = {}
) {
  const endpoint = await assertEndpointImpl(config.endpoint)
  if (endpoint.protocol !== 'https:') throw new Error('S3 Endpoint 必须使用 HTTPS')
  const request = buildS3ListRequest(config, now)
  await assertHostImpl(new URL(request.url).hostname, { label: '对象存储 ' })
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetchImpl(request.url, {
      method: 'GET',
      headers: request.headers,
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) {
      const code = String(response.headers?.get?.('x-amz-error-code') || `HTTP_${response.status}`).slice(0, 80)
      throw new Error(`对象存储连接测试失败（${code}）`)
    }
    return { ok: true, status: response.status, endpoint: endpoint.origin, bucket: config.bucket }
  } finally {
    clearTimeout(timeout)
  }
}
