# DOMO NAV backup and restore-rehearsal runbook

This runbook covers the NAV PostgreSQL database, deployed frontend, Nginx and
Compose configuration, selected environment files, runtime versions and image
identifiers, and the note-attachment URL inventory.

It deliberately does **not** automate a production restore or service switch.
Those operations require a fresh production-change authorization, a
last-minute backup, a maintenance window, rollback preparation, and acceptance
checks.

## Safety properties

- Backups are written under a mode-`700` local root with `umask 077`.
- A long-lived `REPEATABLE READ READ ONLY` transaction exports one PostgreSQL
  snapshot. `pg_dump --snapshot`, the complete `public` ordinary/partitioned
  table set, every table row count, `schema_migrations` content, and attachment
  URL inventory all use that same snapshot.
- PostgreSQL is exported with
  `pg_dump -Fc --no-owner --no-acl --snapshot=<exported-id>`.
- Every backup contains an exact type/mode/path/symlink-target tree,
  `manifest.sha256`, and a successful `pg_restore -l` catalog. Restore
  validation rejects extra as well as missing files, directories, and
  symlinks before checksum verification.
- Environment-file contents are copied but never printed. Every configured
  environment input must have no group/world permissions.
- Telegram token and chat ID are accepted only from a regular, non-symlink
  file owned by the invoking user with exact mode `600`. The bot-token URL is
  passed to curl through an ephemeral stdin-backed curl config, so the token
  is not visible in curl's process argv.
- Cloud export is implemented only through restic. Restic encrypts and
  authenticates repository objects before upload; the scripts contain no
  plaintext `aws s3 cp`, `rclone copy`, or archive-upload path.
- Local deletion, cloud upload, and cloud retention each have both a config
  gate and an explicit command-line gate. All are disabled in the example.
- Restore rehearsal uses a newly named, labeled PostgreSQL container with no
  network, no published ports, a read-only root filesystem, and temporary
  filesystems only. It never connects that container to the production network
  or volume.
- Restore images are never pulled implicitly.

## Backup contents

Each completed directory is named:

```text
nav-YYYYmmddTHHMMSSZ-<git-commit>
```

It contains:

```text
database/nav.dump
database/pg_restore.list
database/postgresql-version.txt
database/snapshot-id.txt
database/public-tables.txt
database/table-counts.tsv
database/schema-migrations.tsv
frontend/
config/compose/
config/nginx/
config/environment/
config/extra/
metadata/inventory.tsv
metadata/runtime.tsv
metadata/container-images.tsv
metadata/tree.tsv
attachments/urls.txt
manifest.sha256
```

The attachment inventory records URLs stored by NAV. The image bytes remain in
the separately operated image-bed/R2 service. A complete two-system disaster
recovery plan must also protect that R2 bucket; the NAV backup must not pretend
that a URL list is an image-object backup.

Likewise, `NAV_NGINX_PATHS` covers only files visible on the host running this
script. If `nav.cristsau.cn` continues to use a separate Nginx Proxy Manager
host, export and protect that proxy-host configuration separately. Do not label
the source-host backup a complete dual-domain proxy backup until both pieces
have recovery evidence.

Short-lived tables such as `sessions` are no longer excluded from verification:
their row counts and the dump are taken from the same exported snapshot. A
table-set, row-count, or migration-content mismatch is a failed rehearsal, not
an ignorable warning.

## Initial installation

Copy the example on the current OVH host and adjust every path to the active
`/opt/nav-stack/releases/<timestamp>-<short-sha>` layout. Oracle-JP is not the
current production target, and historical Oracle paths must not be reused:

```bash
sudo install -d -m 700 /etc/nav
sudo install -m 600 scripts/nav-backup.env.example /etc/nav/nav-backup.env
sudo editor /etc/nav/nav-backup.env
```

Do not copy TLS private keys or the entire `/etc/letsencrypt` tree into
`NAV_NGINX_PATHS`. Back up only the explicitly required Nginx configuration;
certificates need their own protected recovery process.

The scripts require GNU userland tools, Docker access, and the PostgreSQL client
utilities present in `nav-postgres`. The account running the scripts must own
the config and secret files. Root is the expected scheduled-run identity.

Before the first real backup, run:

```bash
sudo bash scripts/nav-backup.sh \
  --config /etc/nav/nav-backup.env \
  --dry-run
```

Dry-run performs no dump, file copy, restore container start, Telegram call,
cloud write, or deletion.

## Local backup

Run:

```bash
sudo bash scripts/nav-backup.sh --config /etc/nav/nav-backup.env
```

Acceptance evidence:

1. Exit code is `0`.
2. A new `nav-*` directory exists under `NAV_BACKUP_ROOT`.
3. `database/nav.dump` is non-empty.
4. `database/pg_restore.list` is non-empty.
5. `database/public-tables.txt`, `table-counts.tsv`, and
   `schema-migrations.tsv` came from the exported snapshot recorded in
   `snapshot-id.txt`.
6. `metadata/tree.tsv` describes every file, directory, and symlink except the
   checksum manifest itself.
7. `manifest.sha256` covers exactly every regular file except itself.
8. Runtime/image inventory and attachment URL inventory are present.

The backup uses a lock and an atomic final-directory rename. A failed partial
run is removed only when its resolved path is a verified
`NAV_BACKUP_ROOT/.nav-backup.*` staging directory.

## Failure alert

Create a dedicated Telegram credential file:

```text
TELEGRAM_BOT_TOKEN=<dedicated-backup-alert-bot-token>
TELEGRAM_CHAT_ID=<numeric-chat-id>
```

Then:

```bash
sudo chown root:root /etc/nav/backup-telegram.env
sudo chmod 600 /etc/nav/backup-telegram.env
```

Set these values in `/etc/nav/nav-backup.env`:

```text
NAV_ENABLE_TELEGRAM_ALERTS=true
NAV_TELEGRAM_CREDENTIAL_FILE=/etc/nav/backup-telegram.env
```

The token and chat ID must not be placed directly in the general config,
systemd unit, command line, Git repository, or logs. If Telegram itself is
unreachable, the script still exits non-zero and logs that alert delivery
failed.

The in-script Telegram call is only the first alert layer. Add an independent
second layer:

- Put `OnFailure=nav-backup-failure@%n.service` in the backup service's
  `[Unit]` section. The failure unit should invoke a small root-owned notifier
  with its own mode-`600` credential file; do not repeat a token in
  `ExecStart=`.
- Configure an external dead-man monitor whose heartbeat is sent only after a
  successful backup (and, on the separate rehearsal schedule, after a
  successful isolated restore). Set its grace period longer than the normal
  maximum job duration.

`OnFailure` covers an observed non-zero service exit but cannot report a dead
host, broken timer, or disabled unit. The external dead-man covers a missing
success heartbeat. Keep the two mechanisms independent and test both failure
paths; neither changes the script's non-zero exit semantics.

## Encrypted Cloudflare R2/S3 export

Use a dedicated bucket and a dedicated restic credential. Do not reuse the
image-bed upload-only token. The backup credential should be scoped only to the
backup bucket. `restic forget --prune` additionally requires delete access.

Create `/etc/nav/restic-r2.env` with raw, unquoted values:

```text
RESTIC_REPOSITORY=s3:https://<account-id>.r2.cloudflarestorage.com/<bucket>/<prefix>
RESTIC_PASSWORD_FILE=/etc/nav/restic-password
AWS_ACCESS_KEY_ID=<scoped-key-id>
AWS_SECRET_ACCESS_KEY=<scoped-secret>
AWS_DEFAULT_REGION=auto
```

Secure both files:

```bash
sudo chown root:root /etc/nav/restic-r2.env /etc/nav/restic-password
sudo chmod 600 /etc/nav/restic-r2.env /etc/nav/restic-password
```

Repository initialization is intentionally not automatic. After a separate
review of the bucket, endpoint, scope, and recovery-password custody, initialize
it once with restic. Preserve the restic password in an independent secure
recovery location; losing it makes the cloud backup unusable.

Enable the config gate:

```text
NAV_ENABLE_CLOUD_UPLOAD=true
```

Then explicitly request an encrypted upload:

```bash
sudo bash scripts/nav-backup.sh \
  --config /etc/nav/nav-backup.env \
  --cloud-upload
```

The workflow captures `restic backup --json`, requires exactly one 64-character
snapshot ID from that invocation, looks up that exact ID, verifies its recorded
source path, reads `manifest.sha256` back from that exact snapshot and compares
it byte-for-byte, and optionally runs `restic check`. It does not accept
"latest tagged snapshot" as proof because another concurrent job could change
what `latest` means.

Successful verification evidence is written atomically below
`NAV_RESTIC_EVIDENCE_DIR` (default
`/var/backups/nav-restic-evidence`). Each mode-`700` evidence directory contains
the captured JSONL, the exact snapshot metadata, a one-object summary,
verification fields, and checksums. Evidence files are mode `600`; they contain
paths and statistics but no restic password or S3 secret.

There is no plaintext bundle upload fallback. If restic or its encrypted
repository is unavailable, cloud export fails closed and the completed local
backup remains available.

## Retention

Local pruning requires:

```text
NAV_ENABLE_LOCAL_PRUNE=true
```

and:

```bash
sudo bash scripts/nav-backup.sh \
  --config /etc/nav/nav-backup.env \
  --prune-local
```

A local candidate is deleted only when it:

- resolves beneath `NAV_BACKUP_ROOT`;
- is a non-symlink directory with the expected `nav-*` name;
- is outside the newest `NAV_LOCAL_KEEP_COUNT` backups; and
- is older than `NAV_LOCAL_KEEP_DAYS`.

Remote restic retention requires `NAV_ENABLE_RESTIC_FORGET=true` plus both
`--cloud-upload` and `--forget-cloud`. Review the daily, weekly and monthly
values before each first use. Do not enable local and remote deletion until at
least one isolated restore rehearsal has passed.

## Read-only dump validation

This validates the exact filesystem tree, checksum coverage/checksums, and the
PostgreSQL archive catalog without restoring:

```bash
sudo bash scripts/nav-restore-rehearsal.sh \
  --config /etc/nav/nav-backup.env \
  --backup /var/backups/nav/nav-YYYYmmddTHHMMSSZ-<commit>
```

It uses a host `pg_restore` when present; otherwise it streams the dump into
`pg_restore -l` inside the existing PostgreSQL tool container. It does not
connect to or write the production database.

## Isolated restore rehearsal

First ensure the configured PostgreSQL image already exists locally:

```bash
sudo docker image inspect postgres:16-alpine
```

Automatic image pulls are forbidden so a rehearsal cannot unexpectedly change
the host or use an unreviewed image.

Set:

```text
NAV_ENABLE_RESTORE_CONTAINER=true
```

Then run:

```bash
sudo bash scripts/nav-restore-rehearsal.sh \
  --config /etc/nav/nav-backup.env \
  --backup /var/backups/nav/nav-YYYYmmddTHHMMSSZ-<commit> \
  --run-isolated
```

Acceptance criteria:

1. The actual type/mode/path/symlink-target tree exactly equals
   `metadata/tree.tsv`; no extra entry is tolerated.
2. The checksum manifest covers the exact regular-file set and all checksums
   pass.
3. `pg_restore -l` accepts the archive.
4. The isolated PostgreSQL container becomes ready.
5. `pg_restore --exit-on-error` completes.
6. The restored `public` ordinary/partitioned table set exactly equals
   `database/public-tables.txt`.
7. Every public-table row count equals the same-snapshot count.
8. The ordered `schema_migrations` rows (ID, name, UTC execution timestamp)
   match byte-for-byte.
9. The report records the exact matches and `restore rehearsal passed`.
10. The labeled temporary container is removed.
11. No production container, network, volume, database or frontend is changed.

Reports are mode `600` files under `NAV_REHEARSAL_REPORT_DIR`. A rehearsal
failure returns non-zero and sends the same opt-in Telegram alert.

## Cloud recovery rehearsal

Cloud recovery should be tested separately:

1. Create a mode-`700` temporary directory on a non-production host.
2. Load the mode-`600` restic environment and password files.
3. List snapshots and select the intended immutable snapshot ID.
4. Run `restic restore <snapshot-id> --target <secure-temp-directory>`.
5. Locate the restored `nav-*` directory.
6. Run `nav-restore-rehearsal.sh` against a copy placed under the configured
   rehearsal `NAV_BACKUP_ROOT`.
7. Remove the temporary plaintext restore only after verifying its exact
   resolved path and recording the rehearsal result.

Never download or upload a decrypted backup through a public object URL.

## Current non-database recovery gap

The frontend, Compose, Nginx, environment, and selected configuration assets
currently have **integrity evidence only**: exact tree entries and checksums
prove what was captured, but the rehearsal does not install those files into a
clean host, run `nginx -t`, recreate the Compose stack, validate environment
ownership/modes at the destination, or perform a user-visible frontend
acceptance test. They must not yet be described as restore-tested.

Close this gap with a separate disposable-host rehearsal: restore into new
paths, compare ownership and modes, validate Compose rendering, validate Nginx
syntax without switching traffic, serve the frontend on an isolated port, and
record acceptance evidence. The outer Nginx Proxy Manager configuration and
image-bed object bucket remain separate recovery scopes.

## Production recovery boundary

These assets stop before production restore. A real recovery must separately
authorize and document:

1. incident scope and data-loss objective;
2. final pre-change dump when the source remains readable;
3. API write freeze or maintenance mode;
4. restoration into a new database/volume rather than overwriting the only
   copy;
5. schema, row-count, login, navigation, notes, share and attachment checks;
6. connection switch and service reload;
7. rollback to the untouched original database/volume; and
8. post-recovery credential/session revocation where appropriate.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Success |
| `64` | Invalid command-line usage |
| `69` | Required command, image or tool container unavailable |
| `70` | Backup/restore command failed |
| `73` | Secure output could not be created |
| `75` | Lock contention or temporary readiness failure |
| `78` | Unsafe or invalid configuration |
| `80` | Checksum, archive, restore or row-count verification failed |
| `130` | Interrupted |

Schedulers must treat every non-zero exit as a failure. A passing backup job
does not replace periodic restore rehearsals.
