import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertSafeOutboundEndpoint,
  assertSafeOutboundHost,
  isBlockedNetworkAddress,
  parseOutboundEndpoint
} from '../src/lib/outboundEndpoints.js'

test('AI endpoints require HTTPS and cannot embed credentials', () => {
  assert.equal(
    parseOutboundEndpoint('https://api.example.test/v1/chat/completions').protocol,
    'https:'
  )
  assert.throws(
    () => parseOutboundEndpoint('http://api.example.test/v1/chat/completions'),
    /must use HTTPS|必须使用 HTTPS/
  )
  assert.throws(
    () => parseOutboundEndpoint('https://user:password@api.example.test/'),
    /不能包含用户名或密码/
  )
})

test('private and loopback network addresses are blocked', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.5',
    '172.16.0.1',
    '192.168.1.1',
    '::1',
    'fd00::1'
  ]) {
    assert.equal(isBlockedNetworkAddress(address), true)
  }

  await assert.rejects(
    () => assertSafeOutboundEndpoint('https://127.0.0.1/v1/chat/completions'),
    /不能指向本机或私有网络/
  )
  await assert.rejects(
    () => assertSafeOutboundEndpoint('https://[::1]/v1/chat/completions'),
    /不能指向本机或私有网络/
  )
  await assert.rejects(
    () => assertSafeOutboundHost('127.0.0.1', { label: 'SMTP ' }),
    /不能指向本机或私有网络/
  )
})
