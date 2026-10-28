# NAV monitor workspace and carrier sampling

This extends the existing Monitor Hub 1.5.1 / Agent 1.2.3 integration. The Hub and existing Agent binaries are unchanged. Daily administration now uses NAV's native, lazy-loaded settings panel; the old embedded frontend is no longer built or linked.

## 2026-10-29 history and native management release

- Carrier ranges: 1 hour, 24 hours, 3 days, 7 days and 30 days. Raw rows remain 3 days, 5-minute aggregates 7 days, hourly aggregates 30 days. Weighted packet counters and latency sums survive aggregation; errors and coverage remain separate. Historical time before collection began is never backfilled.
- Migration 052 adds aggregate, maintenance and native-admin audit tables. A five-minute background job aggregates then prunes atomically under a database advisory lock, independently of browser sessions. Rollback leaves these additive tables in place.
- Overview sends latest carrier snapshots; histories load only for an open detail tab. Owner-scoped coalescing caches, 15-second overview refresh, one-minute carrier-history refresh and hidden-page pauses limit work.
- Native settings cover node CRUD/order/group/notification flags, credentials and temporary registration, traffic limits/corrections, notification settings/test, TCP tasks/assignment/history, database export/retention/vacuum. NAV owns login and appearance. Third-party themes and whole-database restoration remain outside this daily UI.
- Old `/monitor-app` paths redirect to `/monitor`. Hub and Agents remain required; their binaries, DNS, sampling cadence and download tasks do not change. Native writes have a payload-free audit and are not automatically retried after ambiguous failure.
- Deployed NAV API/Web `2026.10.29.1`, runtime commit `06705cf064f098f142ae65304a33adbefd032a5a`. Exact CI `40735719287` passed 13/13 jobs. Dual-origin authenticated reads, anonymous denial, native management reads, all five carrier ranges, background aggregation and all 30 sampling series passed. Existing owner-browser UI was checked; production administration checks were read-only. Native mutations were exercised against the real pinned Hub in CI.
- Pre/post snapshot manifests and the Hub consistent snapshot passed. API/Web are healthy; five unrelated containers and 540 previous hashed assets remain unchanged. This release applies additive migration 052 and rolls back only API/Web to `3a8c29e`; retain the added tables and audit rows. Do not stop existing samplers on this application's rollback.
- Overview JSON shrank from about 116 KB to 21.6 KB. Five requests per origin from OVH measured median 831 to 552 ms (direct) and 803 to 299 ms (CF); this small sample does not establish all-network browser performance. Thirty-day natural history is still accumulating.
- Preview server/tab stopped. Automatic tool policy rejected removal of the obsolete candidate staging and local review/cache files; they remain. Exact retained cleanup paths and full evidence: `D:\DomoCodex\artifacts\nav-monitor-polish-20261029\release-summary.json`. Preserve final artifacts, current/rollback releases and backups.
- Fresh interactive login, physical-phone acceptance, real Dropbox upload/video and recovery rehearsal were not repeated in this batch. The authoritative CURRENT entry retains those boundaries.

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
- ICMP permission: non-root `nav-monitor-agent` user, `CAP_NET_RAW` only, 48 MiB memory / 5% CPU limits. No SSH, Docker socket access, arbitrary targets, proxy credentials or shell evaluation. Use `ping -c 5` without `-w`; the Python process enforces the total timeout. Combining count and deadline waits for replies and can exceed the request budget on a lossy path (iputils documentation: https://github.com/iputils/iputils/blob/master/doc/ping.xml).
- Weighted loss = `(sent - received) / sent`; DNS/permission/parser/interruption errors do not count as packet loss. Failed rounds and gaps remain visible. Data older than 180 seconds is marked stale.
- A target's response does not establish the quality of an entire carrier, nor is it an external availability check of NAV. DNS must remain DNS-only for these destinations to represent the intended hosts.
- At ten nodes, at most about 43,200 raw rows/day at a 60-second cadence. Three days raw plus bounded aggregates replace unbounded history growth. Storage and retention cost still require live observation.
- Optional `NAV_PROBE_SERVICES` is an operator-configured comma-separated allowlist of at most eight local `.service` units; only `systemctl is-active` is read. Default: `nav-monitor-agent.service`. It is not a container/application health check.

## Previous release runbook (051, historical)

Candidate base: `818a5527c14ea5e3599a93ed4f3a42caa0a93299` (live NAV 2026.10.28.1).

1. Obtain approval for this exact batch: publish the candidate test branch and run Linux CI; deploy API/Web on OVH; apply additive migration 051 (four new tables); install the new sampling service/timer and a separate node-bound credential on the ten existing personal nodes: OVH, USPH, SJC, Ali-HK, v.ps-JP, ISJP, 66-JP, 66-US-4837, Bagevm-HK, Onidel-SG.
2. Pass the new PostgreSQL integration job and existing required CI. The new job exercises real JSONB, concurrent confirmations, uncertain-write reconciliation, undo, ownership, report cadence and credential revocation. Local unit SQL fixtures do not replace this job.
3. Recheck the live revision and each named node's resources/services; stop on drift. Preserve original service PIDs/start times, container restart counts and network/DNS settings as the comparison baseline.
4. Before writes, take a PostgreSQL logical backup and a consistent Hub SQLite backup on OVH, retain current API/Web images/source, and record each node's previous sampling-file/unit presence and hashes. Do not export credentials or databases into public artifacts.
5. Apply migration 051; switch only NAV API/Web. Keep PostgreSQL, Hub, existing monitor Agents, download workers, proxies and unrelated services running. A brief NAV interruption is possible.
6. Provision each node using `api/scripts/provisionMonitorProbe.js NODE_ID PRIVATE_OUTPUT_PATH` inside the API environment. The output parent must be private; files are created exclusively. Credentials are hashed in PostgreSQL and transferred only over verified encrypted SSH to root-readable `/etc/nav-monitor-agent/carrier.env`. Never print the file or token. On ambiguous provisioning failure, inspect registration and the output file before retrying; do not rotate blindly.
   Live endpoint decision (2026-10-29): set only `NAV_PROBE_ENDPOINT=https://nav.cristsau.cn/api/monitor/probes/report` in that private file before enabling the timer. The current provisioner emits the CF domain by default; Python reports to that domain returned HTTP 403 in acceptance, while the alternate configured NAV origin reached the API. Do not weaken Cloudflare rules or change DNS to accommodate the sampler. Keep the three carrier destinations unchanged.
7. Install the script and units to the paths in the service; validate systemd units before enable/start. Check `python3`, `ping`, the existing service user, strict SSH trust, time sync and destination reachability first. Configure only verified local service names.
8. Verify two successive reports per node, source/destination/protocol, counter math, all-loss vs probe-error distinction, stale handling and retention; compare CPU/memory/service baselines. Test owner/non-owner/anonymous access, dual-domain login and native overview, global search, synthetic asset-change/undo, and the existing Dropbox/video paths. A real model call and real screenshots need separate evidence; mocks do not prove provider image support.

## Previous release rollback (051 and initial sampler installation, historical)

- Stop and disable only the newly added `nav-carrier-probe.timer` / service. Disable the corresponding credentials. Restore preexisting sampling files/units if any; remove only this batch's verified additions.
- Restore the previous NAV API/Web images and source. Migration 051 is additive; old code ignores its four tables. Leave those tables/data in place during application rollback. Do not automatically restore the full database over newer user data or drop audit records.
- Hub binary, existing Agents, download tasks, CF/DNS, domain entries and certificates are outside the change. No recovery rehearsal or OVH external watcher is part of this release.

## Previous verified release — 2026.10.28.2 (historical)

NAV API/Web version `2026.10.28.2`, commit `3a8c29e`, is deployed. The independent sampler is deployed at commit `16fbb28`; its source bundle and per-node hashes are retained separately. The API was not restarted for the sampler-only correction. Migration 051 added four tables. CI runs 40716928560 and 40722857059 each passed all 13 jobs, including real PostgreSQL. Sampler unit regression checks: 5/5.

All ten nodes reported at least two valid rounds to all three targets after the fixed-count correction; every valid round sent exactly five requests. Existing Agent processes and protected workloads remained unchanged. Dual-origin authenticated endpoints, anonymous denial, global search, preview/confirm/replay/undo, and audit were verified. A synthetic PNG was recognized by the configured real AI model, retaining an ambiguous billing date and not inventing an expiry date. Temporary acceptance sessions were revoked.

Existing owner-session browser acceptance passed on `nav.skrskr.net`. Fresh interactive login on `nav.cristsau.cn` remains pending: the controlled browser showed Turnstile 300030. Do not conflate API session checks with a fresh user login. Real personal bills, phone hardware, long-duration sampling/retention and recovery rehearsal remain separate acceptance.

Pre/post NAV snapshot manifests and a consistent Hub SQLite snapshot passed verification, without restoration. Preserve additive tables/audit on application rollback. No CF/DNS, original Agent, offline queue, certificate or external availability configuration was changed.

Evidence directory (local only): `D:\DomoCodex\artifacts\nav-monitor-enhancements-20261028`, starting at `release-summary.json`. Authoritative project status remains `D:\DomoCodex\projects\NAV-security-first-batch-20260904\CURRENT.md`.
