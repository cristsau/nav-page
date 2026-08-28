# DOMO NAV operations completion candidate (2026-08-28)

Status: `LOCAL_DONE / READY_FOR_CI / NOT_DEPLOYED`

The latest independently recorded production baseline is commit
`15fd83e3f197afb7a03fe119ce118feae26ab10f` in
`/opt/nav-stack/releases/20260827-231729-15fd83e`. Re-read OVH, GitHub and both
domains before a later release; this document is not production authorization.

## What this candidate closes

### Bounded application maintenance

Application defaults remain fail-closed. The non-secret
`ops/env/nav-production-maintenance.env` profile explicitly opts in only:

- hourly bookmark health checks: 20 stale bookmarks, two probes at a time;
- daily AI usage retention: 400 days, at most four 500-row batches per run.

Both jobs already use PostgreSQL advisory locks and the bounded
`maintenance_job_status` record. The administrator maintenance endpoint reports
whether each job is enabled, its interval, last result, bounded failure count
and sanitized error code. The profile contains no credential or endpoint.

### Atomic release pointer

`scripts/nav-release-link.sh` owns the release pointers:

```text
/opt/nav-stack/current  -> releases/<accepted-release>
/opt/nav-stack/rollback -> releases/<previous-accepted-release>
```

It accepts only direct release children named
`YYYYmmdd-HHMMSS-<7..40 lowercase hex>`, replaces each symlink atomically and
serializes changes on `/run/lock/nav-release-link.lock`. The canonical backup
holds the same release lock for its full run, so a backup and release switch
cannot resolve files from two releases. Rollback swaps the two verified
pointers; it never changes a database or starts a container.

### Local backup automation, without a false offsite claim

The three installed systemd candidates now perform only:

1. daily local canonical backup;
2. weekly bounded local retention;
3. weekly isolated PostgreSQL restore of the newest eligible local backup.

`scripts/enable-nav-local-backup-timers.sh --check` is read-only. It refuses
enablement unless the root-owned mode-600 config uses `/opt/nav-stack/current`,
local retention is at least seven days/two backups, isolated restore is enabled,
the pinned PostgreSQL image is already present, and every cloud upload/restore/
forget gate is false. `--enable` first runs one backup and one isolated restore,
then enables the timers. It does not configure or advertise offsite storage.

S3-compatible restic support remains a manual, separately gated capability.
Until a user-selected provider, scoped credentials, restic password custody,
first encrypted snapshot and exact-ID recovery rehearsal exist, offsite status
is `USER_CONFIG_LATER / NOT_CONFIGURED / NOT_ENABLED`.

### Controlled disk cleanup

`scripts/nav-controlled-cleanup.sh` is dry-run by default. Apply mode requires
root and preserves the verified `current` and `rollback` releases. It invokes
the existing 30-day log-retention policy, prunes Docker dangling layers, and
considers only unreferenced NAV API images carrying a trustworthy 40-character
revision label that does not match either retained release. Unknown/unlabelled
images are preserved. It never prunes containers, networks, volumes, build
cache or non-NAV images.

No cleanup, timer enablement, backup, restore, release switch, container change
or production write was executed while preparing this candidate.

## Later release gates

1. Merge only after GitHub Linux shellcheck, systemd verification and the full
   application/PostgreSQL suites pass.
2. Re-read the exact OVH release, current/rollback state, disk usage and running
   container/image identities.
3. Back up and prove an isolated PostgreSQL 16 restore.
4. Install the scripts/units, create the atomic pointers, and run
   `enable-nav-local-backup-timers --check` without enabling anything.
5. Merge the reviewed maintenance profile into the release-local API environment,
   rebuild only the authorized services, then verify both jobs in the admin
   maintenance panel.
6. Enable local timers only in a separately authorized maintenance action, after
   the manual backup and isolated restore pass.
7. Review `nav-controlled-cleanup --dry-run`; a later explicit deletion
   authorization is required before `--apply`.

External store credentials, OAuth/provider consent, extension-store signing and
marketplace review remain external/user actions. Their absence must not be
represented as a completed feature or successful backup destination.
