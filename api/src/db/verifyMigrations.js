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
    'remind_before_minutes_snapshot',
    'reminder_at_snapshot',
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

async function verifyProductivityCompletionSchema() {
  const noteColumns = await query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'notes'
        AND column_name = ANY($1::text[])
    `,
    [['remind_before_minutes', 'revision']]
  )
  assertExactSet(
    'productivity note columns',
    noteColumns.rows.map((row) => row.column_name),
    ['remind_before_minutes', 'revision']
  )

  const expectedVersionColumns = [
    'id',
    'user_id',
    'note_id',
    'revision',
    'type',
    'title',
    'content',
    'content_format',
    'content_json',
    'content_json_encrypted',
    'encrypted',
    'password_hash',
    'pinned',
    'tags',
    'entry_date',
    'mood',
    'due_at',
    'remind_before_minutes',
    'completed',
    'created_at'
  ]
  const versionColumns = await query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'note_versions'
    `
  )
  assertExactSet(
    'note version columns',
    versionColumns.rows.map((row) => row.column_name),
    expectedVersionColumns
  )

  const expectedConstraints = [
    'notes_remind_before_minutes_check',
    'notes_revision_check',
    'note_reminders_advance_minutes_check',
    'note_versions_revision_check',
    'note_versions_remind_before_check',
    'note_versions_note_revision_unique',
    'note_versions_user_id_fkey',
    'note_versions_note_id_fkey'
  ]
  const constraints = await query(
    `
      SELECT
        constraint_row.conname,
        constraint_row.contype,
        constraint_row.confdeltype,
        constraint_row.convalidated,
        CASE constraint_row.conrelid
          WHEN 'notes'::regclass THEN 'notes'
          WHEN 'note_reminders'::regclass THEN 'note_reminders'
          WHEN 'note_versions'::regclass THEN 'note_versions'
          ELSE constraint_row.conrelid::regclass::text
        END AS table_name,
        CASE constraint_row.confrelid
          WHEN 0 THEN NULL
          WHEN 'users'::regclass THEN 'users'
          WHEN 'notes'::regclass THEN 'notes'
          ELSE constraint_row.confrelid::regclass::text
        END AS referenced_table,
        ARRAY(
          SELECT attribute.attname
          FROM generate_subscripts(constraint_row.conkey, 1) AS key(ordinal)
          JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.conrelid
           AND attribute.attnum = constraint_row.conkey[key.ordinal]
          ORDER BY key.ordinal
        ) AS columns,
        ARRAY(
          SELECT attribute.attname
          FROM generate_subscripts(constraint_row.confkey, 1) AS key(ordinal)
          JOIN pg_attribute AS attribute
            ON attribute.attrelid = constraint_row.confrelid
           AND attribute.attnum = constraint_row.confkey[key.ordinal]
          ORDER BY key.ordinal
        ) AS referenced_columns,
        pg_get_constraintdef(constraint_row.oid, FALSE) AS definition
      FROM pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = ANY($1::regclass[])
        AND constraint_row.conname = ANY($2::text[])
    `,
    [
      ['notes', 'note_reminders', 'note_versions'],
      expectedConstraints
    ]
  )
  assertExactSet(
    'productivity constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )

  const canonicalDefinition = (value) => String(value || '')
    .toLowerCase()
    .replace(/public\./g, '')
    .replace(/[\s()]/g, '')
  const expectedConstraintShape = {
    notes_remind_before_minutes_check: {
      tableName: 'notes',
      type: 'c',
      columns: ['remind_before_minutes'],
      definition: 'checkremind_before_minutes>=0andremind_before_minutes<=43200'
    },
    notes_revision_check: {
      tableName: 'notes',
      type: 'c',
      columns: ['revision'],
      definition: 'checkrevision>=1'
    },
    note_reminders_advance_minutes_check: {
      tableName: 'note_reminders',
      type: 'c',
      columns: ['remind_before_minutes_snapshot'],
      definition: 'checkremind_before_minutes_snapshot>=0andremind_before_minutes_snapshot<=43200'
    },
    note_versions_revision_check: {
      tableName: 'note_versions',
      type: 'c',
      columns: ['revision'],
      definition: 'checkrevision>=1'
    },
    note_versions_remind_before_check: {
      tableName: 'note_versions',
      type: 'c',
      columns: ['remind_before_minutes'],
      definition: 'checkremind_before_minutes>=0andremind_before_minutes<=43200'
    },
    note_versions_note_revision_unique: {
      tableName: 'note_versions',
      type: 'u',
      columns: ['note_id', 'revision'],
      definition: 'uniquenote_id,revision'
    },
    note_versions_user_id_fkey: {
      tableName: 'note_versions',
      type: 'f',
      columns: ['user_id'],
      referencedTable: 'users',
      referencedColumns: ['id'],
      deleteAction: 'c',
      definition: 'foreignkeyuser_idreferencesusersidondeletecascade'
    },
    note_versions_note_id_fkey: {
      tableName: 'note_versions',
      type: 'f',
      columns: ['note_id'],
      referencedTable: 'notes',
      referencedColumns: ['id'],
      deleteAction: 'c',
      definition: 'foreignkeynote_idreferencesnotesidondeletecascade'
    }
  }

  for (const row of constraints.rows) {
    const expected = expectedConstraintShape[row.conname]
    if (
      !expected
      || row.table_name !== expected.tableName
      || row.contype !== expected.type
      || row.convalidated !== true
      || canonicalDefinition(row.definition) !== expected.definition
    ) {
      throw new Error(`${row.conname} definition mismatch`)
    }
    // pg_get_constraintdef is compared as an exact canonical expression. It
    // therefore validates the local key order for CHECK, UNIQUE and FK
    // constraints even on PostgreSQL builds that omit conkey in this query.

    if (expected.type === 'f') {
      if (
        row.referenced_table !== expected.referencedTable
        || row.confdeltype !== expected.deleteAction
      ) {
        throw new Error(`${row.conname} foreign key mismatch`)
      }
      // referenced_table and confdeltype are checked independently above;
      // referenced column order is also part of the exact FK definition.
    }
  }

  const indexes = await query(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = ANY($1::text[])
    `,
    [['idx_notes_reminder_generation', 'idx_note_versions_owner_note_created']]
  )
  assertExactSet(
    'productivity indexes',
    indexes.rows.map((row) => row.indexname),
    ['idx_notes_reminder_generation', 'idx_note_versions_owner_note_created']
  )
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
    [
      'ai_usage_retention',
      'bookmark_health_check',
      'media_delete_retry',
      'note_reminder_generation',
      'search_embedding_index',
      'web_push_delivery',
      'security_event_retention'
    ]
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

async function verifyHybridWorkspaceSearchSchema() {
  const expectedColumns = [
    'id', 'user_id', 'bookmark_id', 'note_id', 'kind', 'title', 'body', 'url',
    'tags', 'lexical_tokens', 'term_frequencies', 'document_length', 'source_hash',
    'source_updated_at', 'indexed_at', 'embedding', 'embedding_model',
    'embedding_dimensions', 'embedding_updated_at'
  ]
  const columns = await query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'workspace_search_documents'
  `)
  assertExactSet(
    'hybrid workspace search columns',
    columns.rows.map((row) => row.column_name),
    expectedColumns
  )

  const stateColumns = await query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'workspace_search_index_state'
  `)
  assertExactSet(
    'workspace search index state columns',
    stateColumns.rows.map((row) => row.column_name),
    ['user_id', 'dirty', 'changed_at', 'indexed_at']
  )

  const expectedConstraints = [
    'workspace_search_documents_pkey',
    'workspace_search_documents_user_id_fkey',
    'workspace_search_documents_bookmark_id_fkey',
    'workspace_search_documents_note_id_fkey',
    'workspace_search_documents_kind_check',
    'workspace_search_documents_source_check',
    'workspace_search_documents_tags_check',
    'workspace_search_documents_term_frequencies_check',
    'workspace_search_documents_length_check',
    'workspace_search_documents_hash_check',
    'workspace_search_documents_embedding_check'
  ]
  const constraints = await query(`
    SELECT conname, contype, confdeltype, convalidated
    FROM pg_constraint
    WHERE conrelid = 'workspace_search_documents'::regclass
  `)
  assertExactSet(
    'hybrid workspace search constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )
  if (constraints.rows.some((row) => row.convalidated !== true)) {
    throw new Error('hybrid workspace search constraints must be validated')
  }
  const foreignKeys = constraints.rows.filter((row) => row.contype === 'f')
  if (foreignKeys.length !== 3 || foreignKeys.some((row) => row.confdeltype !== 'c')) {
    throw new Error('hybrid workspace search foreign keys must use ON DELETE CASCADE')
  }

  const stateConstraints = await query(`
    SELECT conname, contype, confdeltype, convalidated
    FROM pg_constraint
    WHERE conrelid = 'workspace_search_index_state'::regclass
  `)
  assertExactSet(
    'workspace search index state constraints',
    stateConstraints.rows.map((row) => row.conname),
    [
      'workspace_search_index_state_pkey',
      'workspace_search_index_state_user_id_fkey'
    ]
  )
  const stateForeignKey = stateConstraints.rows.find((row) => row.contype === 'f')
  if (
    !stateForeignKey
    || stateForeignKey.confdeltype !== 'c'
    || stateForeignKey.convalidated !== true
  ) {
    throw new Error('workspace search index state user foreign key must be a validated cascade')
  }

  const triggers = await query(`
    SELECT trigger_row.tgname, trigger_row.tgenabled, function_row.proname
    FROM pg_trigger AS trigger_row
    JOIN pg_proc AS function_row ON function_row.oid = trigger_row.tgfoid
    WHERE trigger_row.tgrelid IN ('nav_bookmarks'::regclass, 'notes'::regclass)
      AND trigger_row.tgname = ANY($1::text[])
      AND NOT trigger_row.tgisinternal
  `, [[
    'nav_bookmarks_workspace_search_dirty',
    'notes_workspace_search_dirty'
  ]])
  assertExactSet(
    'workspace search dirty triggers',
    triggers.rows.map((row) => row.tgname),
    [
      'nav_bookmarks_workspace_search_dirty',
      'notes_workspace_search_dirty'
    ]
  )
  if (triggers.rows.some((row) => (
    row.tgenabled !== 'O' || row.proname !== 'nav_mark_workspace_search_dirty'
  ))) {
    throw new Error('workspace search dirty triggers must be enabled and use the canonical function')
  }

  const expectedIndexes = [
    'idx_workspace_search_documents_bookmark',
    'idx_workspace_search_documents_note',
    'idx_workspace_search_documents_user_kind',
    'idx_workspace_search_documents_lexical_tokens',
    'idx_workspace_search_documents_pending_embedding'
  ]
  const indexes = await query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'workspace_search_documents'
      AND indexname = ANY($1::text[])
  `, [expectedIndexes])
  assertExactSet(
    'hybrid workspace search indexes',
    indexes.rows.map((row) => row.indexname),
    expectedIndexes
  )
}

async function verifyWebPushSchema() {
  const expectedTables = new Map([
    ['web_push_subscriptions', [
      'id', 'user_id', 'endpoint', 'endpoint_hash', 'p256dh', 'auth',
      'user_agent_digest', 'device_label', 'failure_count', 'last_success_at',
      'last_failure_at', 'disabled_at', 'created_at', 'updated_at'
    ]],
    ['note_reminder_push_deliveries', [
      'reminder_id', 'subscription_id', 'status', 'attempt_count',
      'last_attempt_at', 'delivered_at', 'last_error_code', 'updated_at'
    ]]
  ])
  for (const [tableName, expectedColumns] of expectedTables) {
    const columns = await query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
    `, [tableName])
    assertExactSet(
      `${tableName} columns`,
      columns.rows.map((row) => row.column_name),
      expectedColumns
    )
  }

  const expectedConstraints = [
    'web_push_subscriptions_pkey',
    'web_push_subscriptions_user_id_fkey',
    'web_push_subscriptions_endpoint_hash_check',
    'web_push_subscriptions_key_check',
    'web_push_subscriptions_device_label_check',
    'web_push_subscriptions_failure_count_check',
    'web_push_subscriptions_user_agent_digest_check',
    'web_push_subscriptions_user_endpoint_unique',
    'note_reminder_push_deliveries_pkey',
    'note_reminder_push_deliveries_reminder_id_fkey',
    'note_reminder_push_deliveries_subscription_id_fkey',
    'note_reminder_push_deliveries_status_check',
    'note_reminder_push_deliveries_attempt_count_check',
    'note_reminder_push_deliveries_error_code_check'
  ]
  const constraints = await query(`
    SELECT conname, contype, confdeltype, convalidated
    FROM pg_constraint
    WHERE conrelid IN (
      'web_push_subscriptions'::regclass,
      'note_reminder_push_deliveries'::regclass
    )
  `)
  assertExactSet(
    'Web Push constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )
  if (constraints.rows.some((row) => row.convalidated !== true)) {
    throw new Error('Web Push constraints must be validated')
  }
  const foreignKeys = constraints.rows.filter((row) => row.contype === 'f')
  if (foreignKeys.length !== 3 || foreignKeys.some((row) => row.confdeltype !== 'c')) {
    throw new Error('Web Push foreign keys must use ON DELETE CASCADE')
  }

  const expectedIndexes = [
    'idx_web_push_subscriptions_user_active',
    'idx_note_reminder_push_deliveries_pending'
  ]
  const indexes = await query(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND indexname = ANY($1::text[])
  `, [expectedIndexes])
  assertExactSet(
    'Web Push indexes',
    indexes.rows.map((row) => row.indexname),
    expectedIndexes
  )
}

async function verifyBlockEditorSchema() {
  const richColumns = await query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name IN ('notes', 'note_versions')
      AND column_name IN ('content_format', 'content_json', 'content_json_encrypted')
  `)
  for (const tableName of ['notes', 'note_versions']) {
    assertExactSet(
      `${tableName} rich content columns`,
      richColumns.rows
        .filter((row) => row.table_name === tableName)
        .map((row) => row.column_name),
      ['content_format', 'content_json', 'content_json_encrypted']
    )
  }

  const expectedConstraints = [
    'notes_content_format_check',
    'notes_content_json_object_check',
    'notes_rich_content_privacy_check',
    'notes_rich_content_state_check',
    'note_versions_content_format_check',
    'note_versions_content_json_object_check',
    'note_versions_rich_content_privacy_check',
    'note_versions_rich_content_state_check'
  ]
  const constraints = await query(`
    SELECT conname, convalidated
    FROM pg_constraint
    WHERE conrelid IN ('notes'::regclass, 'note_versions'::regclass)
      AND conname = ANY($1::text[])
  `, [expectedConstraints])
  assertExactSet(
    'block editor constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )
  if (constraints.rows.some((row) => row.convalidated !== true)) {
    throw new Error('block editor constraints must be validated')
  }
}

async function verifyCollaborationOfflineSchema() {
  const expectedColumns = new Map([
    ['note_collaborators', [
      'note_id', 'user_id', 'role', 'invited_by', 'created_at', 'updated_at'
    ]],
    ['note_comments', [
      'id', 'note_id', 'user_id', 'parent_id', 'block_id', 'selection', 'body',
      'status', 'resolved_by', 'resolved_at', 'edited_at', 'created_at', 'updated_at'
    ]],
    ['note_crdt_documents', [
      'note_id', 'state', 'state_vector', 'update_count', 'compacted_through', 'updated_at'
    ]],
    ['note_crdt_updates', [
      'id', 'note_id', 'actor_user_id', 'update', 'update_hash', 'created_at'
    ]],
    ['note_sync_events', [
      'id', 'note_id', 'actor_user_id', 'event_kind', 'entity_id', 'revision',
      'audience_user_ids', 'payload', 'created_at'
    ]],
    ['offline_mutation_receipts', [
      'user_id', 'operation_id', 'mutation_kind', 'request_hash', 'response_status',
      'response_payload', 'created_at', 'expires_at'
    ]],
    ['note_sync_devices', [
      'user_id', 'device_id', 'label', 'last_cursor', 'last_sync_at', 'created_at', 'updated_at'
    ]]
  ])
  const tableNames = [...expectedColumns.keys()]
  const columns = await query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
    `,
    [tableNames]
  )
  for (const [tableName, names] of expectedColumns) {
    assertExactSet(
      `${tableName} columns`,
      columns.rows
        .filter((row) => row.table_name === tableName)
        .map((row) => row.column_name),
      names
    )
  }

  const expectedConstraints = [
    'note_collaborators_role_check',
    'note_comments_body_check',
    'note_comments_selection_object_check',
    'note_comments_status_check',
    'note_comments_resolution_state_check',
    'note_crdt_documents_update_count_check',
    'note_crdt_documents_compacted_through_check',
    'note_crdt_updates_payload_check',
    'note_crdt_updates_hash_check',
    'note_crdt_updates_note_hash_key',
    'note_sync_events_kind_check',
    'note_sync_events_audience_check',
    'note_sync_events_payload_object_check',
    'offline_mutation_receipts_request_hash_check',
    'offline_mutation_receipts_response_status_check',
    'offline_mutation_receipts_expiry_check',
    'note_sync_devices_cursor_check'
  ]
  const constraints = await query(
    `
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conname = ANY($1::text[])
    `,
    [expectedConstraints]
  )
  assertExactSet(
    'collaboration/offline constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )
  if (constraints.rows.some((row) => row.convalidated !== true)) {
    throw new Error('collaboration/offline constraints must be validated')
  }

  const expectedIndexes = [
    'idx_note_collaborators_user_note',
    'idx_note_comments_note_created',
    'idx_note_comments_note_open',
    'idx_note_crdt_updates_note_id',
    'idx_note_sync_events_audience_id',
    'idx_note_sync_events_created',
    'idx_offline_mutation_receipts_expiry'
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
    'collaboration/offline indexes',
    indexes.rows.map((row) => row.indexname),
    expectedIndexes
  )

  const expectedTriggers = [
    'trg_note_collaborators_validate_target',
    'trg_note_collaborators_sync_event',
    'trg_note_comments_validate_target',
    'trg_note_comments_sync_event',
    'trg_note_crdt_documents_validate_target',
    'trg_note_crdt_updates_validate_target',
    'trg_note_sync_events_notify',
    'trg_notes_sync_event_upsert',
    'trg_notes_sync_event_delete'
  ]
  const triggers = await query(
    `
      SELECT tgname, tgenabled
      FROM pg_trigger
      WHERE NOT tgisinternal
        AND tgname = ANY($1::text[])
    `,
    [expectedTriggers]
  )
  assertExactSet(
    'collaboration/offline triggers',
    triggers.rows.map((row) => row.tgname),
    expectedTriggers
  )
  if (triggers.rows.some((row) => row.tgenabled !== 'O')) {
    throw new Error('collaboration/offline triggers must be enabled')
  }

  const notifyFunctions = await query(
    `
      SELECT p.proname, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace namespace ON namespace.oid = p.pronamespace
      WHERE namespace.nspname = current_schema()
        AND p.proname = 'nav_notify_note_sync_event'
        AND p.prorettype = 'trigger'::regtype
        AND p.proargtypes = ''::oidvector
    `
  )
  assertExactSet(
    'collaboration realtime notification functions',
    notifyFunctions.rows.map((row) => row.proname),
    ['nav_notify_note_sync_event']
  )
  const notifyDefinition = String(notifyFunctions.rows[0]?.definition || '')
  if (
    !/pg_notify\('nav_note_sync_events'/.test(notifyDefinition)
    || !/eventId/.test(notifyDefinition)
    || !/eventKind/.test(notifyDefinition)
    || !/comment\.upsert/.test(notifyDefinition)
    || !/member\.delete/.test(notifyDefinition)
  ) {
    throw new Error('collaboration realtime notification function definition mismatch')
  }
}

async function verifyStreamingDataRestoreSchema() {
  const expectedColumns = new Map([
    ['data_restore_stream_uploads', [
      'id', 'user_id', 'session_id', 'status', 'backup_header', 'counts',
      'payload_sha256', 'payload_bytes', 'created_at', 'expires_at'
    ]],
    ['data_restore_stream_records', [
      'upload_id', 'collection', 'ordinal', 'record'
    ]]
  ])
  const columns = await query(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
    `,
    [[...expectedColumns.keys()]]
  )
  for (const [tableName, names] of expectedColumns) {
    assertExactSet(
      `${tableName} columns`,
      columns.rows
        .filter((row) => row.table_name === tableName)
        .map((row) => row.column_name),
      names
    )
  }

  const expectedConstraints = [
    'data_restore_stream_uploads_status_check',
    'data_restore_stream_uploads_header_check',
    'data_restore_stream_uploads_counts_check',
    'data_restore_stream_uploads_digest_check',
    'data_restore_stream_uploads_bytes_check',
    'data_restore_stream_uploads_expiry_check',
    'data_restore_stream_records_collection_check',
    'data_restore_stream_records_ordinal_check',
    'data_restore_stream_records_record_check'
  ]
  const constraints = await query(
    `
      SELECT conname, convalidated
      FROM pg_constraint
      WHERE conname = ANY($1::text[])
    `,
    [expectedConstraints]
  )
  assertExactSet(
    'streaming data restore constraints',
    constraints.rows.map((row) => row.conname),
    expectedConstraints
  )
  if (constraints.rows.some((row) => row.convalidated !== true)) {
    throw new Error('streaming data restore constraints must be validated')
  }

  const expectedIndexes = [
    'idx_data_restore_stream_uploads_expiry',
    'idx_data_restore_stream_uploads_user_session',
    'idx_data_restore_stream_records_upload_order'
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
    'streaming data restore indexes',
    indexes.rows.map((row) => row.indexname),
    expectedIndexes
  )
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
  await verifyProductivityCompletionSchema()
  await verifyMediaLibrarySchema()
  await verifySecurityControlsSchema()
  await verifyWebAuthnSchema()
  await verifyMaintenanceObservabilitySchema()
  await verifyWorkspaceSearchSchema()
  await verifyHybridWorkspaceSearchSchema()
  await verifyWebPushSchema()
  await verifyBlockEditorSchema()
  await verifyCollaborationOfflineSchema()
  await verifyStreamingDataRestoreSchema()
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
