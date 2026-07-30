import dns from 'node:dns/promises'
import net from 'node:net'
import { config } from '../config.js'

function isBlockedIpv4(address) {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return true
  }

  const [a, b] = parts
  return (
    a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224
  )
}

function isBlockedIpv6(address) {
  const normalized = address.toLowerCase().split('%')[0]
  if (normalized === '::' || normalized === '::1') return true
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true
  if (/^fe[89ab]/.test(normalized)) return true

  const mappedIpv4 = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1]
  return mappedIpv4 ? isBlockedIpv4(mappedIpv4) : false
}

export function isBlockedNetworkAddress(address) {
  const family = net.isIP(String(address || ''))
  if (family === 4) return isBlockedIpv4(address)
  if (family === 6) return isBlockedIpv6(address)
  return true
}

export function parseOutboundEndpoint(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error('接口地址格式无效')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('接口地址只支持 HTTP 或 HTTPS')
  }

  if (url.username || url.password) {
    throw new Error('接口地址不能包含用户名或密码')
  }

  if (url.protocol !== 'https:' && !config.allowInsecureAiEndpoints) {
    throw new Error('AI 接口必须使用 HTTPS')
  }

  return url
}

export async function assertSafeOutboundEndpoint(value) {
  const url = parseOutboundEndpoint(value)
  const hostname = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '')

  if (
    !config.allowPrivateAiEndpoints
    && (
      hostname === 'localhost'
      || hostname.endsWith('.localhost')
      || hostname.endsWith('.local')
    )
  ) {
    throw new Error('AI 接口不能指向本机或私有网络')
  }

  if (net.isIP(hostname)) {
    if (!config.allowPrivateAiEndpoints && isBlockedNetworkAddress(hostname)) {
      throw new Error('AI 接口不能指向本机或私有网络')
    }
    return url
  }

  let addresses
  try {
    addresses = await dns.lookup(hostname, {
      all: true,
      verbatim: true
    })
  } catch {
    throw new Error('AI 接口域名无法解析')
  }

  if (
    !config.allowPrivateAiEndpoints
    && addresses.some(({ address }) => isBlockedNetworkAddress(address))
  ) {
    throw new Error('AI 接口不能指向本机或私有网络')
  }

  return url
}
