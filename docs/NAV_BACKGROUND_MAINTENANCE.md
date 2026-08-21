# NAV background maintenance

Status: `LOCAL_READY / NOT_PUSHED / NOT_DEPLOYED` on 2026-08-21.

This document covers two bounded workers and the API/container log limits in the
local candidate `codex/nav-unfinished-p1-20260821`. It contains no credentials.

## Safety defaults

Both workers are disabled in `api/.env.example`. Merely deploying the code and
migration does not delete audit rows or retry image deletion:

```dotenv
NAV_SECURITY_EVENT_RETENTION_ENABLED=false
NAV_MEDIA_DELETE_RETRY_ENABLED=false
```

Migration `017_background_maintenance.sql` only creates a partial index for
pending automatic image deletions. It does not update or delete existing rows.

## Security-event retention

The proposed policy is:

| Class | Examples | Online retention |
| --- | --- | ---: |
| Routine | successful login/logout | 90 days |
| Denied | failed or denied login | 180 days |
| Critical | recovery, account changes, administrator operations | 365 days |

The worker uses one database advisory lock across replicas, deletes the oldest
eligible records in batches of 500, runs at most 20 batches per cycle, and waits
for an active cycle during graceful shutdown. It never stores deleted event
payloads in a replacement log.

Before enabling it, run a current PostgreSQL backup and isolated restore. Then
perform a read-only count using the same three policy windows and retain the
result in release evidence. Existing backups still contain their historical
rows; online retention is not backup destruction.

## Security-event export

Administrators can export the current filtered online records as CSV or JSON.
The endpoint is capped at 10,000 records and reports truncation in response
headers and in the UI. It includes only structured IDs, counts, timestamps and
the same 16-character correlation fingerprints shown in settings. Raw IP,
User-Agent, credentials, tokens and request bodies are not exported.

## Image deletion retry

Only rows satisfying all of these conditions are candidates:

- retention is `auto`;
- state is `delete_pending` or `delete_failed`;
- the configured maximum attempt count has not been reached;
- exponential backoff has elapsed.

Each selected row is passed through the existing deletion transaction, which
locks the row and rechecks retention, pending state and live note references
before calling the image-bed delete API. A newly restored reference returns the
asset to active state instead of deleting it. One advisory lock prevents two API
replicas from running the batch together; manual retries remain safe because the
row is revalidated under lock.

Recommended first production settings after the image-library Token is verified:

```dotenv
NAV_MEDIA_DELETE_RETRY_ENABLED=true
NAV_MEDIA_DELETE_RETRY_INTERVAL_SECONDS=3600
NAV_MEDIA_DELETE_RETRY_BATCH_SIZE=10
NAV_MEDIA_DELETE_RETRY_MAX_ATTEMPTS=8
NAV_MEDIA_DELETE_RETRY_BASE_BACKOFF_SECONDS=900
NAV_MEDIA_DELETE_RETRY_MAX_BACKOFF_SECONDS=86400
```

## Logging bounds

The API defaults to `warn` in production and redacts authorization, cookie,
API-key, password and token fields. Source Compose uses Docker's `local` driver
for API and PostgreSQL with `10m × 3` compressed files per container. External
alert delivery is not part of this candidate; worker failures are structured
server errors ready for a later alert collector.

## Release and acceptance

1. Let GitHub CI install dependencies, run the complete API tests and build the
   Vue frontend. Do not replace failed CI with a local unreviewed build.
2. Back up PostgreSQL and complete an isolated restore rehearsal.
3. Deploy the code with both workers disabled; apply and verify migration 017.
4. Confirm both domains can list security events and export narrowly filtered
   CSV/JSON without raw network values.
5. Confirm the image library reports the retry policy and manual retry still
   works.
6. Enable image retry first, observe at least one interval, and verify no image
   with an active note reference is removed.
7. Count retention candidates, approve the result, then enable audit retention
   and verify the first bounded batch and table/index health.

Rollback is configuration-first: set either worker's `ENABLED` value to `false`
and rebuild only `nav-api` from the last known-good release. Migration 017 is an
additive index and can safely remain after application rollback. Do not drop the
index or rewrite migration history during an incident.

## Still outside this batch

- remote/offsite backup scheduling and dead-man alerting;
- external delivery of worker-failure alerts;
- Passkey/WebAuthn;
- offline push reminders and scheduled broken-link scans;
- BM25/fuzzy/vector search, unified sourced AI assistant and cost visibility.
