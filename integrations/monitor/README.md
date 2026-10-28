# NAV monitor workspace and carrier sampling

This extends the existing Monitor Hub 1.5.1 / Agent 1.2.3 integration. The Hub and existing Agent binaries are unchanged. The original administration panel remains available from the native NAV overview.

## Behavior

- Owner-admin-only resource, asset, renewal, cost and three-carrier overview; global search and AI use the same ownership boundary.
- Asset changes create a 15-minute preview. Confirmation checks the saved baseline, takes a durable database claim, writes once and verifies the Hub result. Uncertain outcomes require readback, not automatic retry. Undo creates another preview and refuses to overwrite later changes.
- `monitor_changes` covers NAV changes only. Direct changes in the original Hub UI have no atomic compare-and-swap API and cannot be included in NAV's transaction. Avoid editing the same node in both interfaces simultaneously.
- Screenshots are sent only after the user clicks the AI action, to the already configured AI provider. They are not persisted by NAV. Billing and expiry dates are separate. Ambiguous slash dates require manual interpretation; extraction never confirms a change.
- Monthly-equivalent costs remain separated by currency and exclude one-time fees. Missing cost/expiry data is not invented.
- No OVH external availability watcher is included.

## Carrier sampler

`carrier-probe.py` is a Python standard-library oneshot service. It resolves only `cu.skrskr.net` (China Unicom), `cm.skrskr.net` (China Mobile) and `ct.skrskr.net` (China Telecom), then sends five IPv4 ICMP packets to each target once per timer round. Target addresses must be public. Each node sends a signed-in-node report to the existing NAV HTTPS API with its own revocable bearer credential; it never receives commands.

- Timer: 60 seconds plus up to 5 seconds random delay. Three targets run concurrently; nominal traffic is 15 echo requests per node per round.
- ICMP permission: non-root `nav-monitor-agent` user, `CAP_NET_RAW` only, 48 MiB memory / 5% CPU limits. No SSH, Docker socket access, arbitrary targets, proxy credentials or shell evaluation.
- Weighted loss = `(sent - received) / sent`; DNS/permission/parser/interruption errors do not count as packet loss. Failed rounds and gaps remain visible. Data older than 180 seconds is marked stale.
- A target's response does not establish the quality of an entire carrier, nor is it an external availability check of NAV. DNS must remain DNS-only for these destinations to represent the intended hosts.
- Latest-hour summaries and trends; samples retained for 24 hours. At ten nodes, at most about 43,200 rows/day at a 60-second cadence. Storage and retention cost still require live observation.
- Optional `NAV_PROBE_SERVICES` is an operator-configured comma-separated allowlist of at most eight local `.service` units; only `systemctl is-active` is read. Default: `nav-monitor-agent.service`. It is not a container/application health check.

## Release gate — not deployed

Candidate base: `818a5527c14ea5e3599a93ed4f3a42caa0a93299` (live NAV 2026.10.28.1).

1. Obtain approval for this exact batch: publish the candidate test branch and run Linux CI; deploy API/Web on OVH; apply additive migration 051 (four new tables); install the new sampling service/timer and a separate node-bound credential on the ten existing personal nodes: OVH, USPH, SJC, Ali-HK, v.ps-JP, ISJP, 66-JP, 66-US-4837, Bagevm-HK, Onidel-SG.
2. Pass the new PostgreSQL integration job and existing required CI. The new job exercises real JSONB, concurrent confirmations, uncertain-write reconciliation, undo, ownership, report cadence and credential revocation. Local unit SQL fixtures do not replace this job.
3. Recheck the live revision and each named node's resources/services; stop on drift. Preserve original service PIDs/start times, container restart counts and network/DNS settings as the comparison baseline.
4. Before writes, take a PostgreSQL logical backup and a consistent Hub SQLite backup on OVH, retain current API/Web images/source, and record each node's previous sampling-file/unit presence and hashes. Do not export credentials or databases into public artifacts.
5. Apply migration 051; switch only NAV API/Web. Keep PostgreSQL, Hub, existing monitor Agents, download workers, proxies and unrelated services running. A brief NAV interruption is possible.
6. Provision each node using `api/scripts/provisionMonitorProbe.js NODE_ID PRIVATE_OUTPUT_PATH` inside the API environment. The output parent must be private; files are created exclusively. Credentials are hashed in PostgreSQL and transferred only over verified encrypted SSH to root-readable `/etc/nav-monitor-agent/carrier.env`. Never print the file or token. On ambiguous provisioning failure, inspect registration and the output file before retrying; do not rotate blindly.
7. Install the script and units to the paths in the service; validate systemd units before enable/start. Check `python3`, `ping`, the existing service user, strict SSH trust, time sync and destination reachability first. Configure only verified local service names.
8. Verify two successive reports per node, source/destination/protocol, counter math, all-loss vs probe-error distinction, stale handling and retention; compare CPU/memory/service baselines. Test owner/non-owner/anonymous access, dual-domain login and native overview, global search, synthetic asset-change/undo, and the existing Dropbox/video paths. A real model call and real screenshots need separate evidence; mocks do not prove provider image support.

## Rollback

- Stop and disable only the newly added `nav-carrier-probe.timer` / service. Disable the corresponding credentials. Restore preexisting sampling files/units if any; remove only this batch's verified additions.
- Restore the previous NAV API/Web images and source. Migration 051 is additive; old code ignores its four tables. Leave those tables/data in place during application rollback. Do not automatically restore the full database over newer user data or drop audit records.
- Hub binary, existing Agents, download tasks, CF/DNS, domain entries and certificates are outside the change. No recovery rehearsal or OVH external watcher is part of this release.

## Local verification evidence

2026-10-28: related unit suite 69/69 passed; final intent/monitor subset passed after the last intent adjustment; Python parser suite 4/4 passed; frontend production build passed. Desktop and mobile synthetic browser exercises covered filtering, detail trends, light/dark mode, ambiguous-date extraction, preview and confirmation. All preview data/model replies are synthetic. No real PostgreSQL integration, live sampler, real-model call or deployment has run for this batch.

Evidence directory (local only): `D:\DomoCodex\artifacts\nav-monitor-enhancements-20261028`.
Preview: `NAV_MONITOR_PREVIEW_OUTPUT=<private DomoCodex artifacts path> node scripts/monitor-workspace-preview.mjs` (Windows; local-only port 4196).
