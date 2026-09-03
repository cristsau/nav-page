import { createHash } from 'node:crypto'
import { query } from '../db/index.js'
import { config } from '../config.js'
import {
  sendWebPush,
  verifiedWebPushConfigurationStatus
} from '../lib/webPush.js'

const MAX_ENDPOINT_LENGTH = 2_048
const MAX_DEVICE_LABEL_LENGTH = 80
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+={0,2}$/
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

function digest(value) {
  return createHash('sha256').update(String(value || '')).digest('hex')
}

function isAllowedPushHost(hostname) {
  const host = String(hostname || '').toLowerCase()
  return config.webPushAllowedEndpointHosts.some((allowed) => (
    host === allowed || host.endsWith(`.${allowed}`)
  ))
}

export function normalizeSubscription(input) {
  const endpoint = String(input?.endpoint || '').trim()
  let url
  try {
    url = new URL(endpoint)
  } catch {
    throw new TypeError('Push endpoint is invalid')
  }
  if (url.protocol !== 'https:' || endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new TypeError('Push endpoint must use HTTPS')
  }
  if (url.username || url.password || !isAllowedPushHost(url.hostname)) {
    throw new TypeError('Push endpoint provider is not allowed')
  }
  const p256dh = String(input?.keys?.p256dh || '').trim()
  const auth = String(input?.keys?.auth || '').trim()
  if (
    !BASE64_URL_PATTERN.test(p256dh)
    || !BASE64_URL_PATTERN.test(auth)
    || p256dh.length < 16
    || p256dh.length > 512
    || auth.length < 8
    || auth.length > 256
  ) {
    throw new TypeError('Push subscription keys are invalid')
  }
  return { endpoint, p256dh, auth }
}

function mapSubscription(row) {
  return {
    id: row.id,
    deviceLabel: row.device_label || '',
    active: !row.disabled_at,
    lastSuccessAt: row.last_success_at || null,
    failureCount: Number(row.failure_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export default async function webPushRoutes(fastify) {
  fastify.get('/web-push/status', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    reply.header('Cache-Control', 'private, no-store')
    const subscriptions = await query(
      `
        SELECT id, device_label, failure_count, last_success_at,
               disabled_at, created_at, updated_at
        FROM web_push_subscriptions
        WHERE user_id = $1
        ORDER BY disabled_at NULLS FIRST, updated_at DESC, id ASC
      `,
      [request.currentUser.id]
    )
    return {
      ...(await verifiedWebPushConfigurationStatus()),
      subscriptions: subscriptions.rows.map(mapSubscription)
    }
  })

  fastify.post('/web-push/subscriptions', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const status = await verifiedWebPushConfigurationStatus()
    if (!status.configured) {
      reply.code(503)
      return { error: 'Web Push 尚未由服务器管理员配置' }
    }

    let subscription
    try {
      subscription = normalizeSubscription(request.body?.subscription)
    } catch (error) {
      reply.code(400)
      return { error: error.message }
    }
    const deviceLabel = String(request.body?.deviceLabel || '')
      .normalize('NFKC')
      .trim()
      .slice(0, MAX_DEVICE_LABEL_LENGTH)
    const userAgent = String(request.headers['user-agent'] || '')
    const endpointHash = digest(subscription.endpoint)
    const { rows } = await query(
      `
        INSERT INTO web_push_subscriptions (
          user_id, endpoint, endpoint_hash, p256dh, auth,
          user_agent_digest, device_label
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (user_id, endpoint_hash)
        DO UPDATE SET
          endpoint = EXCLUDED.endpoint,
          p256dh = EXCLUDED.p256dh,
          auth = EXCLUDED.auth,
          user_agent_digest = EXCLUDED.user_agent_digest,
          device_label = EXCLUDED.device_label,
          failure_count = 0,
          disabled_at = NULL,
          updated_at = NOW()
        RETURNING id, device_label, failure_count, last_success_at,
                  disabled_at, created_at, updated_at
      `,
      [
        request.currentUser.id,
        subscription.endpoint,
        endpointHash,
        subscription.p256dh,
        subscription.auth,
        userAgent ? digest(userAgent) : null,
        deviceLabel
      ]
    )
    reply.code(201)
    return { ok: true, subscription: mapSubscription(rows[0]) }
  })

  fastify.delete('/web-push/subscriptions/:subscriptionId', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    if (!UUID_PATTERN.test(String(request.params.subscriptionId || ''))) {
      reply.code(400)
      return { error: 'Invalid subscription id' }
    }
    const result = await query(
      `DELETE FROM web_push_subscriptions WHERE id = $1 AND user_id = $2`,
      [request.params.subscriptionId, request.currentUser.id]
    )
    if (!result.rowCount) {
      reply.code(404)
      return { error: 'Push subscription not found' }
    }
    return { ok: true }
  })

  fastify.post('/web-push/test', async (request, reply) => {
    await fastify.requireAuth(request, reply)
    const requestedSubscriptionId = String(request.body?.subscriptionId || '')
    if (requestedSubscriptionId && !UUID_PATTERN.test(requestedSubscriptionId)) {
      reply.code(400)
      return { error: 'Invalid subscription id' }
    }
    const { rows } = await query(
      `
        SELECT id, endpoint, p256dh, auth
        FROM web_push_subscriptions
        WHERE user_id = $1
          AND disabled_at IS NULL
          AND ($2::uuid IS NULL OR id = $2)
        ORDER BY updated_at DESC, id ASC
        LIMIT 1
      `,
      [request.currentUser.id, requestedSubscriptionId || null]
    )
    if (!rows[0]) {
      reply.code(404)
      return { error: '请先在当前设备启用后台通知' }
    }
    try {
      await sendWebPush(rows[0], {
        title: 'DOMO NAV',
        body: '后台通知已连接；关闭网页后也能收到到期提醒。',
        tag: 'domo-nav-test',
        url: '/settings?category=integrations',
        icon: '/icons/cristsau-mark-192-v2.png',
        badge: '/icons/cristsau-badge-96-v2.png'
      })
      await query(
        `
          UPDATE web_push_subscriptions
          SET last_success_at = NOW(), failure_count = 0, updated_at = NOW()
          WHERE id = $1 AND user_id = $2
        `,
        [rows[0].id, request.currentUser.id]
      )
      return { ok: true }
    } catch (error) {
      const statusCode = Number(error?.statusCode || 0)
      const disableEndpoint = statusCode === 404 || statusCode === 410
      await query(
        `
          UPDATE web_push_subscriptions
          SET failure_count = failure_count + 1,
              last_failure_at = NOW(),
              disabled_at = CASE WHEN $3 THEN NOW() ELSE disabled_at END,
              updated_at = NOW()
          WHERE id = $1 AND user_id = $2
        `,
        [rows[0].id, request.currentUser.id, disableEndpoint]
      )
      request.log?.warn?.(
        { statusCode },
        'web push test delivery failed'
      )
      reply.code(502)
      return {
        error: disableEndpoint
          ? '通知订阅已失效，请在当前设备重新启用'
          : '测试通知发送失败，请稍后重试'
      }
    }
  })
}
