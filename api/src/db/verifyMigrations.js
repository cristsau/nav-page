import fs from 'node:fs/promises'
import { config } from '../config.js'
import { pool, query } from './index.js'

function assertExactSet(label, actualValues, expectedValues) {
  const actual = [...new Set(actualValues)].sort()
  const expected = [...new Set(expectedValues)].sort()

  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${label} mismatch: expected ${expected.join(', ')}, received ${actual.join(', ')}`)
  }
}

function assertExactSequence(label, actualValues, expectedValues) {
  const actual = Array.isArray(actualValues) ? actualValues : []
  const expected = Array.isArray(expectedValues) ? expectedValues : []

  if (
    actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(
      `${label} mismatch: expected ${expected.join(', ')}, received ${actual.join(', ')}`
    )
  }
}

async function migrationFileNames() {
  const entries = await fs.readdir(config.migrationsDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort()
}

async function verifyMigrationLedger() {
  const expected = await migrationFileNames()
  const result = await query(
    `
      SELECT name, COUNT(*)::INTEGER AS executions
      FROM schema_migrations
      GROUP BY name
      ORDER BY name ASC
    `
  )

  assertExactSet('schema_migrations', result.rows.map((row) => row.name), expected)
  if (result.rows.some((row) => Number(row.executions) !== 1)) {
    throw new Error('A migration was recorded more than once')
  }
}

async function verifyNavigationMaintenanceSchema() {
  const expectedColumns = [
    'health_status',
    'health_http_status',
    'health_checked_at',
    'health_failure_count',
    'health_error_code'
  ]
  const columns = await query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'nav_bookmarks'
        AND column_name = ANY($1::text[])
    `,
    [expectedColumns]
  )
  assertExactSet('navigation maintenance columns', columns.rows.map((row) => row.column_name), expectedColumns)

  const expectedConstraints = [
    'nav_bookmarks_health_status_check',
    'nav_bookmarks_health_http_status_check',
    'nav_bookmarks_health_failure_count_check',
    'nav_bookmarks_health_error_code_check'
  ]
  const constraints = await query(
    `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'nav_bookmarks'::regclass
        AND conname = ANY($1::text[])
    `,
    [expectedConstraints]
  )
  assertExactSet(
    'navigation maintenance constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )
}

async function verifyReminderSchema() {
  const expectedColumns = [
    'id',
    'user_id',
    'note_id',
    'due_at_snapshot',
    'triggered_at',
    'read_at',
    'created_at'
  ]
  const columns = await query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'note_reminders'
    `
  )
  assertExactSet('note reminder columns', columns.rows.map((row) => row.column_name), expectedColumns)

  const expectedIndexes = [
    'idx_note_reminders_user_triggered',
    'idx_note_reminders_user_unread'
  ]
  const indexes = await query(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'note_reminders'
        AND indexname = ANY($1::text[])
    `,
    [expectedIndexes]
  )
  assertExactSet('note reminder indexes', indexes.rows.map((row) => row.indexname), expectedIndexes)
}

async function verifyMediaLibrarySchema() {
  const expectedColumns = [
    'id',
    'user_id',
    'upstream_id',
    'url',
    'name',
    'mime',
    'size',
    'source',
    'retention',
    'state',
    'missing_observations',
    'delete_attempts',
    'delete_requested_at',
    'last_delete_attempt_at',
    'last_delete_error',
    'deletion_disposition',
    'deletion_source_deleted',
    'deletion_detached',
    'deletion_legacy',
    'deletion_already_missing',
    'deletion_cache_invalidated',
    'deletion_cache_purge_configured',
    'deletion_cache_purge_attempted',
    'deletion_cache_purge_succeeded',
    'deletion_local_cache_invalidated',
    'deleted_at',
    'created_at',
    'updated_at'
  ]
  const columns = await query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'media_assets'
    `
  )
  assertExactSet('media asset columns', columns.rows.map((row) => row.column_name), expectedColumns)

  const expectedIndexes = [
    'idx_media_assets_delete_retry',
    'idx_media_assets_user_created',
    'idx_media_assets_user_retention',
    'idx_media_assets_user_state'
  ]
  const indexes = await query(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'media_assets'
        AND indexname = ANY($1::text[])
    `,
    [expectedIndexes]
  )
  assertExactSet('media asset indexes', indexes.rows.map((row) => row.indexname), expectedIndexes)

  const expectedConstraints = [
    'media_assets_deletion_disposition_check',
    'media_assets_deletion_outcome_check',
    'media_assets_deletion_cache_check'
  ]
  const constraints = await query(
    `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'media_assets'::regclass
        AND conname = ANY($1::text[])
    `,
    [expectedConstraints]
  )
  assertExactSet(
    'media asset deletion constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )
}

async function verifySecurityControlsSchema() {
  const rateLimitColumns = [
    'scope',
    'key_digest',
    'window_started_at',
    'window_expires_at',
    'request_count',
    'updated_at'
  ]
  const rateLimitColumnResult = await query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'rate_limit_buckets'
    `
  )
  assertExactSet(
    'rate limit bucket columns',
    rateLimitColumnResult.rows.map((row) => row.column_name),
    rateLimitColumns
  )

  const securityEventColumns = [
    'id',
    'event_type',
    'outcome',
    'actor_user_id',
    'subject_user_id',
    'resource_type',
    'resource_id',
    'affected_count',
    'client_ip_digest',
    'user_agent_digest',
    'created_at'
  ]
  const securityEventColumnResult = await query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'security_events'
    `
  )
  assertExactSet(
    'security event columns',
    securityEventColumnResult.rows.map((row) => row.column_name),
    securityEventColumns
  )

  const rateLimitIndexes = [
    'idx_rate_limit_buckets_expires',
  ]
  const rateLimitIndexResult = await query(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'rate_limit_buckets'
        AND indexname = ANY($1::text[])
    `,
    [rateLimitIndexes]
  )
  assertExactSet(
    'rate limit bucket indexes',
    rateLimitIndexResult.rows.map((row) => row.indexname),
    rateLimitIndexes
  )

  const securityEventIndexes = [
    'idx_security_events_created',
    'idx_security_events_type_created',
    'idx_security_events_actor_created'
  ]
  const securityEventIndexResult = await query(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'security_events'
        AND indexname = ANY($1::text[])
    `,
    [securityEventIndexes]
  )
  assertExactSet(
    'security event indexes',
    securityEventIndexResult.rows.map((row) => row.indexname),
    securityEventIndexes
  )

  const rateLimitChecks = [
    'rate_limit_buckets_scope_check',
    'rate_limit_buckets_key_digest_check',
    'rate_limit_buckets_window_check',
    'rate_limit_buckets_request_count_check'
  ]
  const rateLimitCheckResult = await query(
    `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'rate_limit_buckets'::regclass
        AND contype = 'c'
        AND conname = ANY($1::text[])
    `,
    [rateLimitChecks]
  )
  assertExactSet(
    'rate limit bucket checks',
    rateLimitCheckResult.rows.map((row) => row.conname),
    rateLimitChecks
  )

  const rateLimitPrimaryKeyResult = await query(
    `
      SELECT
        constraint_record.conname,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(constraint_record.conkey)
            WITH ORDINALITY AS key_column(attnum, position)
          JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_record.conrelid
           AND attribute.attnum = key_column.attnum
          ORDER BY key_column.position
        ) AS columns
      FROM pg_constraint AS constraint_record
      WHERE constraint_record.conrelid = 'rate_limit_buckets'::regclass
        AND constraint_record.contype = 'p'
    `
  )
  assertExactSet(
    'rate limit bucket primary key',
    rateLimitPrimaryKeyResult.rows.map((row) => row.conname),
    ['rate_limit_buckets_pkey']
  )
  assertExactSequence(
    'rate limit bucket primary key columns',
    rateLimitPrimaryKeyResult.rows[0]?.columns,
    ['scope', 'key_digest']
  )

  const securityEventChecks = [
    'security_events_type_check',
    'security_events_outcome_check',
    'security_events_resource_type_check',
    'security_events_affected_count_check',
    'security_events_client_ip_digest_check',
    'security_events_user_agent_digest_check'
  ]
  const securityEventCheckResult = await query(
    `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'security_events'::regclass
        AND contype = 'c'
        AND conname = ANY($1::text[])
    `,
    [securityEventChecks]
  )
  assertExactSet(
    'security event checks',
    securityEventCheckResult.rows.map((row) => row.conname),
    securityEventChecks
  )

  const securityEventForeignKeyResult = await query(
    `
      SELECT
        constraint_record.conname,
        constraint_record.confdeltype,
        ARRAY(
          SELECT attribute.attname::text
          FROM unnest(constraint_record.conkey)
            WITH ORDINALITY AS key_column(attnum, position)
          JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_record.conrelid
           AND attribute.attnum = key_column.attnum
          ORDER BY key_column.position
        ) AS columns
      FROM pg_constraint AS constraint_record
      WHERE constraint_record.conrelid = 'security_events'::regclass
        AND constraint_record.confrelid = 'users'::regclass
        AND constraint_record.contype = 'f'
    `
  )
  assertExactSet(
    'security event foreign keys',
    securityEventForeignKeyResult.rows.map((row) => row.conname),
    [
      'security_events_actor_user_id_fkey',
      'security_events_subject_user_id_fkey'
    ]
  )

  const expectedForeignKeyColumns = new Map([
    ['security_events_actor_user_id_fkey', ['actor_user_id']],
    ['security_events_subject_user_id_fkey', ['subject_user_id']]
  ])
  for (const foreignKey of securityEventForeignKeyResult.rows) {
    if (foreignKey.confdeltype !== 'n') {
      throw new Error(`${foreignKey.conname} must use ON DELETE SET NULL`)
    }
    assertExactSequence(
      `${foreignKey.conname} columns`,
      foreignKey.columns,
      expectedForeignKeyColumns.get(foreignKey.conname)
    )
  }
}

async function verifyWebAuthnSchema() {
  const credentialColumns = [
    'id',
    'user_id',
    'credential_id',
    'public_key',
    'webauthn_user_id',
    'counter',
    'transports',
    'device_type',
    'backed_up',
    'display_name',
    'rp_id',
    'created_at',
    'last_used_at'
  ]
  const challengeColumns = [
    'id',
    'user_id',
    'session_id',
    'kind',
    'challenge',
    'webauthn_user_id',
    'rp_id',
    'origin',
    'expires_at',
    'used_at',
    'created_at'
  ]
  for (const [tableName, expectedColumns] of [
    ['webauthn_credentials', credentialColumns],
    ['webauthn_challenges', challengeColumns]
  ]) {
    const columns = await query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = $1
      `,
      [tableName]
    )
    assertExactSet(
      `${tableName} columns`,
      columns.rows.map((row) => row.column_name),
      expectedColumns
    )
  }

  const expectedConstraints = [
    'webauthn_challenges_authentication_scope_check',
    'webauthn_challenges_challenge_key',
    'webauthn_challenges_expiry_check',
    'webauthn_challenges_kind_check',
    'webauthn_challenges_origin_check',
    'webauthn_challenges_pkey',
    'webauthn_challenges_registration_scope_check',
    'webauthn_challenges_rp_id_check',
    'webauthn_challenges_session_id_fkey',
    'webauthn_challenges_user_id_fkey',
    'webauthn_credentials_counter_check',
    'webauthn_credentials_credential_id_key',
    'webauthn_credentials_device_type_check',
    'webauthn_credentials_display_name_check',
    'webauthn_credentials_pkey',
    'webauthn_credentials_rp_id_check',
    'webauthn_credentials_user_id_fkey'
  ]
  const constraints = await query(
    `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid IN (
          'webauthn_credentials'::regclass,
          'webauthn_challenges'::regclass
        )
        AND conname = ANY($1::text[])
    `,
    [expectedConstraints]
  )
  assertExactSet(
    'WebAuthn constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )

  const foreignKeys = await query(
    `
      SELECT conname, confdeltype
      FROM pg_constraint
      WHERE conrelid IN (
          'webauthn_credentials'::regclass,
          'webauthn_challenges'::regclass
        )
        AND contype = 'f'
      ORDER BY conname ASC
    `
  )
  assertExactSet(
    'WebAuthn foreign keys',
    foreignKeys.rows.map((row) => row.conname),
    [
      'webauthn_challenges_session_id_fkey',
      'webauthn_challenges_user_id_fkey',
      'webauthn_credentials_user_id_fkey'
    ]
  )
  if (foreignKeys.rows.some((row) => row.confdeltype !== 'c')) {
    throw new Error('WebAuthn foreign keys must use ON DELETE CASCADE')
  }

  const expectedIndexes = [
    'idx_webauthn_challenges_expires',
    'idx_webauthn_challenges_registration_session',
    'idx_webauthn_challenges_unused',
    'idx_webauthn_credentials_user_created',
    'idx_webauthn_credentials_user_rp'
  ]
  const indexes = await query(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = ANY($1::text[])
    `,
    [expectedIndexes]
  )
  assertExactSet(
    'WebAuthn indexes',
    indexes.rows.map((row) => row.indexname),
    expectedIndexes
  )
}

async function verifyMaintenanceObservabilitySchema() {
  const expectedColumns = [
    'job_name',
    'last_started_at',
    'last_succeeded_at',
    'last_failed_at',
    'last_duration_ms',
    'last_outcome',
    'last_result',
    'consecutive_failures',
    'last_error_code',
    'alert_open',
    'last_alert_at',
    'last_notification_kind',
    'last_notification_status',
    'last_notification_at',
    'last_notification_error_code',
    'updated_at'
  ]
  const columns = await query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'maintenance_job_status'
    `
  )
  assertExactSet(
    'maintenance job status columns',
    columns.rows.map((row) => row.column_name),
    expectedColumns
  )

  const expectedConstraints = [
    'maintenance_job_status_job_name_check',
    'maintenance_job_status_duration_check',
    'maintenance_job_status_outcome_check',
    'maintenance_job_status_result_check',
    'maintenance_job_status_failure_count_check',
    'maintenance_job_status_error_code_check',
    'maintenance_job_status_notification_kind_check',
    'maintenance_job_status_notification_status_check',
    'maintenance_job_status_notification_error_check'
  ]
  const constraints = await query(
    `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'maintenance_job_status'::regclass
        AND conname = ANY($1::text[])
    `,
    [expectedConstraints]
  )
  assertExactSet(
    'maintenance job status constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )

  const jobs = await query(
    `
      SELECT job_name
      FROM maintenance_job_status
      ORDER BY job_name ASC
    `
  )
  assertExactSet(
    'maintenance job status seeds',
    jobs.rows.map((row) => row.job_name),
    ['ai_usage_retention', 'media_delete_retry', 'security_event_retention']
  )
}

async function verifyWorkspaceSearchSchema() {
  const expectedIndexes = [
    'idx_nav_bookmarks_user_lower_title',
    'idx_notes_user_lower_title_unencrypted',
    'idx_notes_user_number_unencrypted'
  ]
  const indexes = await query(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = ANY($1::text[])
    `,
    [expectedIndexes]
  )
  assertExactSet(
    'workspace search baseline indexes',
    indexes.rows.map((row) => row.indexname),
    expectedIndexes
  )

  const trgm = await query(
    `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS enabled`
  )
  if (trgm.rows[0]?.enabled === true) {
    const expectedTrgmIndexes = [
      'idx_nav_bookmarks_title_trgm',
      'idx_nav_bookmarks_description_trgm',
      'idx_notes_title_trgm_unencrypted',
      'idx_notes_content_trgm_unencrypted'
    ]
    const trgmIndexes = await query(
      `
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = ANY($1::text[])
      `,
      [expectedTrgmIndexes]
    )
    assertExactSet(
      'workspace search trigram indexes',
      trgmIndexes.rows.map((row) => row.indexname),
      expectedTrgmIndexes
    )
  }
}

async function verifyAiUsageSchema() {
  const expectedColumns = [
    'usage_date',
    'user_id',
    'feature',
    'provider',
    'model',
    'api_mode',
    'request_count',
    'success_count',
    'failure_count',
    'input_tokens',
    'output_tokens',
    'cached_input_tokens',
    'reasoning_tokens',
    'latency_ms_total',
    'estimated_cost_microusd',
    'priced_request_count',
    'updated_at'
  ]
  const columns = await query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'ai_usage_daily'
    `
  )
  assertExactSet(
    'AI usage daily columns',
    columns.rows.map((row) => row.column_name),
    expectedColumns
  )

  const expectedConstraints = [
    'ai_usage_daily_feature_check',
    'ai_usage_daily_provider_check',
    'ai_usage_daily_model_check',
    'ai_usage_daily_api_mode_check',
    'ai_usage_daily_counts_check'
  ]
  const constraints = await query(
    `
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'ai_usage_daily'::regclass
        AND conname = ANY($1::text[])
    `,
    [expectedConstraints]
  )
  assertExactSet(
    'AI usage daily constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )

  const indexes = await query(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'ai_usage_daily'
        AND indexname = 'idx_ai_usage_daily_user_date'
    `
  )
  assertExactSet(
    'AI usage daily indexes',
    indexes.rows.map((row) => row.indexname),
    ['idx_ai_usage_daily_user_date']
  )
}

async function main() {
  await verifyMigrationLedger()
  await verifyNavigationMaintenanceSchema()
  await verifyReminderSchema()
  await verifyMediaLibrarySchema()
  await verifySecurityControlsSchema()
  await verifyWebAuthnSchema()
  await verifyMaintenanceObservabilitySchema()
  await verifyWorkspaceSearchSchema()
  await verifyAiUsageSchema()
  console.log('migration schema verification complete')
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end()
  })
