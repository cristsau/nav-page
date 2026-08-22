import { config } from '../config.js'
import { query } from '../db/index.js'
import { MAINTENANCE_JOB_NAMES } from '../lib/maintenanceJobStatus.js'

const JOB_DEFINITIONS = Object.freeze([
  {
    name: MAINTENANCE_JOB_NAMES.SECURITY_EVENT_RETENTION,
    label: '安全审计定期清理',
    enabled: () => config.securityEventRetentionEnabled,
    intervalSeconds: () => config.securityEventRetentionIntervalSeconds
  },
  {
    name: MAINTENANCE_JOB_NAMES.MEDIA_DELETE_RETRY,
    label: '图床删除失败重试',
    enabled: () => config.mediaDeleteRetryEnabled,
    intervalSeconds: () => config.mediaDeleteRetryIntervalSeconds
  }
])

function mapState(row = {}) {
  return {
    lastStartedAt: row.last_started_at || null,
    lastSucceededAt: row.last_succeeded_at || null,
    lastFailedAt: row.last_failed_at || null,
    lastDurationMs: row.last_duration_ms === null || row.last_duration_ms === undefined
      ? null
      : Number(row.last_duration_ms),
    lastOutcome: row.last_outcome || 'idle',
    lastResult: row.last_result && typeof row.last_result === 'object'
      ? row.last_result
      : {},
    consecutiveFailures: Number(row.consecutive_failures || 0),
    lastErrorCode: row.last_error_code || null,
    alertOpen: row.alert_open === true,
    lastAlertAt: row.last_alert_at || null,
    lastNotificationKind: row.last_notification_kind || null,
    lastNotificationStatus: row.last_notification_status || null,
    lastNotificationAt: row.last_notification_at || null,
    lastNotificationErrorCode: row.last_notification_error_code || null,
    updatedAt: row.updated_at || null
  }
}
export default async function maintenanceRoutes(fastify, options = {}) {
  const queryFn = typeof options.queryFn === 'function' ? options.queryFn : query

  fastify.get('/admin/maintenance/status', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store')
    await fastify.requireAdmin(request, reply)

    const { rows } = await queryFn(
      `
        SELECT
          job_name,
          last_started_at,
          last_succeeded_at,
          last_failed_at,
          last_duration_ms,
          last_outcome,
          last_result,
          consecutive_failures,
          last_error_code,
          alert_open,
          last_alert_at,
          last_notification_kind,
          last_notification_status,
          last_notification_at,
          last_notification_error_code,
          updated_at
        FROM maintenance_job_status
        WHERE job_name = ANY($1::text[])
      `,
      [JOB_DEFINITIONS.map((job) => job.name)]
    )
    const states = new Map(rows.map((row) => [row.job_name, row]))

    return {
      jobs: JOB_DEFINITIONS.map((job) => ({
        name: job.name,
        label: job.label,
        enabled: job.enabled(),
        intervalSeconds: job.intervalSeconds(),
        ...mapState(states.get(job.name))
      })),
      alerts: {
        enabled: config.maintenanceAlertsEnabled,
        failureThreshold: config.maintenanceAlertFailureThreshold,
        cooldownSeconds: config.maintenanceAlertCooldownSeconds,
        channel: 'telegram'
      }
    }
  })
}
