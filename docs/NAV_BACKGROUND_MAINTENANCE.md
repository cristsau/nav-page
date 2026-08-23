# NAV background maintenance

Status on 2026-08-23:

- bounded security-event retention, image-delete retry, persistent job status and
  in-process Telegram failure/recovery alerts: `VERIFIED_LIVE` in production SHA
  `5a42279e7fba2d9f378ae7e6532f7e1f2464ef6a`;
- migration `018` is applied, the two fixed job rows exist, both workers have a
  successful run, and production alerts are enabled after a labelled Telegram
  target test.

This document contains no credentials, private data or real environment values.

## Existing bounded workers

Security-event retention uses three online windows:

| Class | Examples | Online retention |
| --- | --- | ---: |
| Routine | successful login/logout | 90 days |
| Denied | failed or denied login | 180 days |
| Critical | recovery, account changes, administrator operations | 365 days |

The worker holds one PostgreSQL advisory lock across replicas, deletes the
oldest eligible rows in bounded batches and waits for an active cycle during a
graceful shutdown. Backups retain their historical rows; online retention is not
backup destruction.

The image worker considers only `auto` assets in `delete_pending` or
`delete_failed`, with a bounded attempt count and exponential backoff. Every
candidate is revalidated under a row lock immediately before the upstream
delete. A restored note reference returns the asset to active state instead of
deleting it.

The stricter image-delete alert accounting described below is merged in PR #30
but remains `SOURCE_MERGED / NOT_DEPLOYED` until its exact merge SHA is released
and the live worker status is revalidated.

A completed scheduler cycle is healthy only when the unresolved image-delete
backlog is empty. Upstream delete failures, unexpected per-item errors and
exhausted retries are recorded as bounded maintenance failures and can open the
existing Telegram alert after its threshold. A cycle that has only deferred or
batch-limited work updates bounded progress counters without clearing an open
alert. Recovery is emitted only after the backlog reaches zero. Persisted state
contains counts and a fixed error code, never image URLs, filenames or upstream
response text.

Migration `017_background_maintenance.sql` added only the partial retry index.
It was applied and verified before the workers were enabled in production.

## Persistent status

Migration `018_maintenance_observability.sql` adds
`maintenance_job_status` and seeds these internal jobs:

- `security_event_retention`;
- `media_delete_retry`.

For each completed run it stores only:

- start, success/failure and duration timestamps;
- a small whitelist of numeric counters;
- consecutive failure count;
- a bounded error code such as `ECONNREFUSED`;
- failure-alert reservation and notification-delivery status.

It never stores an exception message, stack, URL, image name, request body,
credential, Token or deleted audit payload. A second replica that skips because
the advisory lock is held does not overwrite the last completed state.

Administrators read the state through:

```text
GET /api/admin/maintenance/status
```

The endpoint is administrator-only and returns `Cache-Control: private,
no-store`. Settings displays `已关闭`, `等待首次运行`, `正常` or `需关注`, plus
last success/failure, duration, counters and notification delivery. The security
audit section remains collapsed and loads both audit rows and task status only
when opened.

## Failure and recovery notifications

The alert settings remain deliberately disabled in the repository example:

```dotenv
NAV_MAINTENANCE_ALERTS_ENABLED=false
NAV_MAINTENANCE_ALERT_FAILURE_THRESHOLD=3
NAV_MAINTENANCE_ALERT_COOLDOWN_SECONDS=21600
```

When enabled, the worker reserves an alert only after the configured consecutive
failure threshold and suppresses repeated alerts during the cooldown. It reuses
each enabled administrator Telegram target and sends only the task label,
failure count, bounded error code and time. The first later successful run sends
one recovery notification. Per-target delivery uses `Promise.allSettled`, so one
invalid administrator target does not prevent delivery to the others.

The current local candidate verifies both the Bot Token and the exact numeric
Chat ID by sending a labelled test message and checking Telegram's bot identity,
message ID and returned target. Each worker cycle makes at most one notification
attempt. Telegram may already have accepted a message when a timeout or
connection error loses the response, so an immediate retry could create a
duplicate alert. If delivery is failed or skipped, the failure remains open but
only the new cooldown reservation is released, so a later worker cycle can try
again; partial or complete delivery keeps the cooldown. This candidate is not
active in production until its exact merge SHA is separately released.

The candidate also adds an isolated PostgreSQL 16 GitHub CI maintenance
exercise using only `nav_maintenance_test`. It fails closed unless
`NODE_ENV=test`, the explicit maintenance test switch, a localhost host and the
exact database name all match.
The exercise covers retry selection/backoff/backlog, advisory locking, failure
threshold/cooldown, concurrent alert reservation, undelivered reservation
release and recovery. It replaces neither the normal API suite nor production
acceptance.

This is **in-process monitoring**. If the host, container, network or scheduler
is completely offline, it cannot notify. Independent off-host health checks and
a dead-man signal remain mandatory.

## Logging bounds

The API defaults to `warn` in production and redacts authorization, cookies,
API keys, passwords and Token fields. Source Compose uses Docker's `local`
driver with `10m × 3` compressed files per API/PostgreSQL container. Persistent
maintenance status is bounded to two rows and is updated in place, so it does
not create an ever-growing event table.

## Release and acceptance for migration 018

The following gate was completed for PR #27 and remains the required pattern
for later releases:

1. Let GitHub CI install dependencies, run the full API suite and build Vue; do
   not install project npm dependencies on the user's computer.
2. Lock the merge SHA, back up PostgreSQL/configuration and prove an isolated
   restore before switching.
3. Apply and verify migration `018`; confirm exactly the two seeded job rows and
   all constraints without modifying worker data.
4. Rebuild only `nav-api` and `nav-web`. Keep PostgreSQL, CLIProxyAPI, NPM and
   unrelated services untouched.
5. With alerts still disabled, confirm both domains can expand Settings →
   Account Security and Audit, read both jobs, refresh, and retain login state.
6. Confirm a normal worker run updates success time and counters without adding
   security-event rows or leaking raw errors.
7. Send and receive the labelled administrator Telegram test message, then
   enable alerts. Use an injected test failure or isolated fixture—not a
   destructive production failure—to prove threshold, cooldown, delivery
   status and recovery once.
8. Confirm health, container restart counts, API logs, dual-domain CORS, image
   library, AI and existing background-worker behavior.

The verified application rollback is to disable
`NAV_MAINTENANCE_ALERTS_ENABLED`, restore the previous release SHA
`369024f9883a87fb0e1bc05a7665cb2e76437ae2`, and rebuild only API/Web. Migration
`018` is additive and may safely remain; do not drop the table or rewrite
migration history during an incident.

## Still outside this batch

- automatic encrypted offsite backup scheduling, restore drills and backup
  failure alerts;
- independent external uptime/dead-man monitoring;
- Passkey/WebAuthn;
- offline push reminders and scheduled broken-link scans;
- BM25/fuzzy/vector search, unified sourced AI assistant and cost visibility.
