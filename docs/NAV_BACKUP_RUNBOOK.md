# DOMO NAV backup and restore-rehearsal runbook

This runbook covers the NAV PostgreSQL database, deployed frontend, Nginx and
Compose configuration, selected environment files, runtime versions and image
identifiers, and the note-attachment URL inventory.

It deliberately does **not** automate a production restore or service switch.
Those operations require a fresh production-change authorization, a
last-minute backup, a maintenance window, rollback preparation, and acceptance
checks.

Repository automation status on 2026-08-23: the systemd units, success
heartbeat, independent `OnFailure` notifier, latest-backup selector and
installer are source-controlled candidates. The installer does not enable or
start timers. Until the production host is separately configured and accepted,
the presence of these files must not be described as automatic offsite backup.

## Safety properties

- Backups are written under a mode-`700` local root with `umask 077`.
- A long-lived `REPEATABLE READ READ ONLY` transaction exports one PostgreSQL
  snapshot. `pg_dump --snapshot`, the complete `public` ordinary/partitioned
  table set, every table row count, `schema_migrations` content, and attachment
  URL inventory all use that same snapshot.
- Before exporting that snapshot, the same transaction acquires the
  `nav_release_acceptance_account` advisory lock and proves that both the
  `release_acceptance_account:` marker prefix and `nav_release_accept_` user
  prefix have zero rows. Any residue exits with a temporary failure before
  `pg_dump`, so a crashed release-acceptance account cannot enter a recoverable
  backup.
- The release-acceptance wrapper holds this script's canonical
  `/run/lock/nav-backup.lock` for the complete create/accept/cleanup lifecycle.
  Both entrypoints reject any other lock path; the backup script creates/opens
  the root-owned non-symlink lock without truncation. Backups must remain outside
  that wrapper; release-specific scripts must call this canonical entry instead
  of duplicating a direct `pg_dump` path.
- PostgreSQL is exported with
  `pg_dump -Fc --no-owner --no-acl --snapshot=<exported-id>`.
- GitHub CI's isolated PostgreSQL 16 gate executes this canonical script against
  a real database. It proves a clean backup, marker and username residue refusal
  before `pg_dump`, and waiting behind the same advisory lock while a provision
  transaction remains open.
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

### Install the scheduler files without enabling them

The repository provides:

```text
scripts/install-nav-backup-systemd.sh
ops/systemd/nav-backup.service
ops/systemd/nav-backup.timer
ops/systemd/nav-backup-retention.service
ops/systemd/nav-backup-retention.timer
ops/systemd/nav-restore-rehearsal.service
ops/systemd/nav-restore-rehearsal.timer
ops/systemd/nav-scheduled-failure@.service
```

After reviewing the exact release and paths, install them from a clean, locked
merge SHA:

```bash
sudo bash scripts/install-nav-backup-systemd.sh
```

This copies scripts and units, creates only the bounded backup/report
directories, runs `systemd-analyze verify` when available, and reloads systemd.
It deliberately does **not** create credentials, initialize restic, enable a
timer, start a job, alter containers, or delete a backup.

The example release paths contain `REPLACE_WITH_RELEASE` and the runtime
container names contain `REPLACE_*`. Replace them with the currently accepted
OVH release and exact `docker ps` names. Every later NAV release must update and
dry-run these paths before the previous release is eligible for removal.

### Scheduler layout

| Unit | Default schedule | Mutation gate | Success signal |
| --- | --- | --- | --- |
| `nav-backup.service` | daily at 03:17 UTC plus 0–15 min jitter | encrypted upload only | backup heartbeat |
| `nav-backup-retention.service` | Sunday 05:17 UTC plus 0–20 min jitter | cloud upload plus separately enabled local/remote retention | backup heartbeat |
| `nav-restore-rehearsal.service` | Wednesday 04:47 UTC plus 0–20 min jitter | isolated, network-less temporary PostgreSQL only | restore heartbeat |

All timers use `Persistent=true`. The backup scripts share a nonblocking lock;
an accidental overlap fails rather than running two snapshots concurrently.
The rehearsal selector accepts only a regular `nav-*` directory directly below
`NAV_BACKUP_ROOT` and refuses to send a success signal for a backup older than
`NAV_REHEARSAL_MAX_BACKUP_AGE_HOURS`.

The units use a read-only system view plus narrow write paths under
`/var/backups` and `/run/lock`, resource deprioritization, `UMask=0077`,
`NoNewPrivileges`, private devices/tmp, and kernel/control-group protections.
They still need the Docker socket and outbound HTTPS for PostgreSQL tools,
restic, Telegram and the external heartbeat.

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

The supplied `nav-scheduled-failure@.service` calls
`/usr/local/sbin/nav-job-failure-notify`. It reads the same strict two-key,
mode-`600` Telegram credential file and reports only host, unit and UTC time;
it never copies journal output, environment values or exception payloads into
Telegram. It is intentionally separate from the backup process so early config
or dependency failures still have a notification path.

## External success heartbeat and uptime monitor

Create two independent dead-man checks outside OVH: one for daily backup and
one for weekly restore. Store their bearer-like ping URLs only in
`/etc/nav/nav-heartbeat.env`:

```text
NAV_BACKUP_HEARTBEAT_URL=https://<external-monitor>/<secret-backup-id>
NAV_RESTORE_HEARTBEAT_URL=https://<external-monitor>/<secret-restore-id>
NAV_HEARTBEAT_TIMEOUT_SECONDS=10
```

Set owner `root:root` and mode `600`. `nav-heartbeat` rejects non-HTTPS URLs,
passes the URL to curl through stdin rather than argv, and exits non-zero if the
external service does not acknowledge it. systemd invokes it only through
`ExecStartPost`, so a failed backup or failed restore can never create a false
success heartbeat.

Recommended external policies:

- daily backup check: expected every 24 hours, grace at least 6 hours beyond
  the longest observed backup and restic-check duration;
- weekly restore check: expected every 7 days, grace at least 24 hours;
- independent HTTPS uptime checks for both `nav.skrskr.net/api/health` and
  `nav.cristsau.cn/api/health`, from outside OVH, every 5 minutes with an alert
  only after multiple consecutive failures.

The dead-man provider must not run on OVH. A provider-hosted monitor is the
simplest option; a later self-hosted monitor belongs on another retained node
and requires its own authorization. Never put a real heartbeat URL in Git,
chat, a systemd unit, process arguments or logs.

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

The minimum production inputs that cannot be committed are:

1. one dedicated R2/S3 bucket and bucket-scoped access key;
2. one randomly generated restic repository password, preserved independently
   from OVH in a recoverable password vault;
3. the backup and restore dead-man URLs;
4. a dedicated Telegram bot token/chat target or an explicitly accepted reuse
   of the existing administrator alert channel.

Enter them only on the server or the provider's own consent page. The key ID,
secret, password and heartbeat URLs must not be pasted into an issue, PR,
documentation, terminal transcript or Codex message.

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

For the scheduled path, test the selector before enabling its timer:

```bash
sudo /usr/local/sbin/nav-restore-latest --config /etc/nav/nav-backup.env
```

It chooses only the newest eligible local backup and then delegates to the same
isolated rehearsal script. It does not restore production or switch traffic.

## First production enablement gate

Do not enable timers immediately after file installation. Complete this order
in one authorized maintenance window:

1. verify current release/container paths and file ownership/modes without
   printing contents;
2. initialize the dedicated restic repository once and record its repository
   ID without recording credentials;
3. run the backup script manually with `--cloud-upload`, then verify the exact
   restic snapshot and manifest evidence;
4. run one full `nav-restore-latest` isolated restore and confirm table set,
   row counts and migration rows;
5. send clearly labelled manual backup/restore heartbeat tests and confirm the
   provider deadlines;
6. run each systemd service manually and review its exit status/journal;
7. inject a harmless preflight failure to prove `OnFailure`, then restore the
   valid config;
8. enable only the three timers and inspect their next-run times:

   ```bash
   sudo systemctl enable --now \
     nav-backup.timer \
     nav-backup-retention.timer \
     nav-restore-rehearsal.timer
   systemctl list-timers --all 'nav-*'
   ```

9. recheck NAV/CLIProxyAPI/PostgreSQL/NPM/Vaultwarden/Komari health and restart
   counts; scheduler enablement must not rebuild or restart them.

Rollback disables the three timers and stops only a currently running backup
or rehearsal after confirming its stage. Keep completed local/cloud snapshots,
restic password, evidence and config files intact; rollback must not delete the
only recovery copy.

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
