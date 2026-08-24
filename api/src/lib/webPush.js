import fs from 'node:fs/promises'
import webpush from 'web-push'
import { config } from '../config.js'

let configuredClient = null
let configurationError = null

function normalizeSecret(value) {
  return String(value || '').trim()
}

async function loadPrivateKey() {
  const filePath = normalizeSecret(config.webPushVapidPrivateKeyFile)
  if (!filePath) throw new Error('Web Push VAPID private key file is not configured')
  const value = normalizeSecret(await fs.readFile(filePath, 'utf8'))
  if (!value) throw new Error('Web Push VAPID private key file is empty')
  return value
}

export function webPushConfigurationStatus() {
  return {
    enabled: Boolean(config.webPushEnabled),
    configured: Boolean(
      config.webPushEnabled
      && config.webPushVapidPublicKey
      && config.webPushVapidPrivateKeyFile
    ),
    publicKey: config.webPushEnabled ? config.webPushVapidPublicKey : ''
  }
}

export async function verifiedWebPushConfigurationStatus() {
  const status = webPushConfigurationStatus()
  if (!status.enabled || !status.configured) return status
  try {
    await getWebPushClient()
    return status
  } catch {
    return {
      ...status,
      configured: false,
      publicKey: '',
      configurationError: 'invalid-server-configuration'
    }
  }
}

export async function getWebPushClient() {
  if (!config.webPushEnabled) throw new Error('Web Push is disabled')
  if (configurationError) throw configurationError
  if (!configuredClient) {
    configuredClient = (async () => {
      const privateKey = await loadPrivateKey()
      if (!config.webPushVapidPublicKey) {
        throw new Error('Web Push VAPID public key is not configured')
      }
      webpush.setVapidDetails(
        config.webPushVapidSubject,
        config.webPushVapidPublicKey,
        privateKey
      )
      return webpush
    })().catch((error) => {
      configurationError = error
      throw error
    })
  }
  return configuredClient
}

export async function sendWebPush(subscription, payload) {
  const client = await getWebPushClient()
  return client.sendNotification(
    {
      endpoint: String(subscription.endpoint || ''),
      keys: {
        p256dh: String(subscription.p256dh || ''),
        auth: String(subscription.auth || '')
      }
    },
    JSON.stringify(payload),
    {
      TTL: 24 * 60 * 60,
      urgency: 'normal',
      topic: String(payload?.tag || 'domo-nav-reminder').slice(0, 32)
    }
  )
}

export function resetWebPushClientForTests() {
  configuredClient = null
  configurationError = null
}
