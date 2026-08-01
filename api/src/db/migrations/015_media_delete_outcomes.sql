ALTER TABLE media_assets
  ADD COLUMN deletion_disposition TEXT,
  ADD COLUMN deletion_source_deleted BOOLEAN,
  ADD COLUMN deletion_detached BOOLEAN,
  ADD COLUMN deletion_legacy BOOLEAN,
  ADD COLUMN deletion_already_missing BOOLEAN,
  ADD COLUMN deletion_cache_invalidated BOOLEAN,
  ADD COLUMN deletion_cache_purge_configured BOOLEAN,
  ADD COLUMN deletion_cache_purge_attempted BOOLEAN,
  ADD COLUMN deletion_cache_purge_succeeded BOOLEAN,
  ADD COLUMN deletion_local_cache_invalidated BOOLEAN;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_deletion_disposition_check CHECK (
    deletion_disposition IS NULL
    OR deletion_disposition IN (
      'source_deleted',
      'detached',
      'legacy_detached',
      'already_missing'
    )
  ),
  ADD CONSTRAINT media_assets_deletion_outcome_check CHECK (
    (
      deletion_disposition IS NULL
      AND deletion_source_deleted IS NULL
      AND deletion_detached IS NULL
      AND deletion_legacy IS NULL
      AND deletion_already_missing IS NULL
      AND deletion_cache_invalidated IS NULL
      AND deletion_cache_purge_configured IS NULL
      AND deletion_cache_purge_attempted IS NULL
      AND deletion_cache_purge_succeeded IS NULL
      AND deletion_local_cache_invalidated IS NULL
    )
    OR (
      deletion_disposition IS NOT NULL
      AND deletion_source_deleted IS NOT NULL
      AND deletion_detached IS NOT NULL
      AND deletion_legacy IS NOT NULL
      AND deletion_already_missing IS NOT NULL
      AND deletion_cache_invalidated IS NOT NULL
      AND deletion_cache_purge_configured IS NOT NULL
      AND deletion_cache_purge_attempted IS NOT NULL
      AND deletion_cache_purge_succeeded IS NOT NULL
      AND deletion_local_cache_invalidated IS NOT NULL
      AND (
        (
          deletion_disposition = 'source_deleted'
          AND deletion_source_deleted = TRUE
          AND deletion_detached = FALSE
          AND deletion_legacy = FALSE
          AND deletion_already_missing = FALSE
        )
        OR (
          deletion_disposition = 'detached'
          AND deletion_source_deleted = FALSE
          AND deletion_detached = TRUE
          AND deletion_legacy = FALSE
          AND deletion_already_missing = FALSE
        )
        OR (
          deletion_disposition = 'legacy_detached'
          AND deletion_source_deleted = FALSE
          AND deletion_detached = TRUE
          AND deletion_legacy = TRUE
          AND deletion_already_missing = FALSE
        )
        OR (
          deletion_disposition = 'already_missing'
          AND deletion_source_deleted = FALSE
          AND deletion_detached = FALSE
          AND deletion_legacy = FALSE
          AND deletion_already_missing = TRUE
        )
      )
    )
  ),
  ADD CONSTRAINT media_assets_deletion_cache_check CHECK (
    deletion_disposition IS NULL
    OR (
      (deletion_cache_purge_attempted = FALSE OR deletion_cache_purge_configured = TRUE)
      AND (
        deletion_cache_purge_succeeded = FALSE
        OR (
          deletion_cache_purge_configured = TRUE
          AND deletion_cache_purge_attempted = TRUE
          AND deletion_cache_invalidated = TRUE
        )
      )
      AND (
        deletion_local_cache_invalidated = FALSE
        OR deletion_cache_invalidated = TRUE
      )
      AND deletion_cache_invalidated = (
        deletion_cache_purge_succeeded OR deletion_local_cache_invalidated
      )
    )
  );
