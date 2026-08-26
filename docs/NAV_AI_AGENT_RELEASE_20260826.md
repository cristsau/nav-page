# NAV AI agent and Service Worker v5 release gate

Status: release candidate. Production state must be verified again at execution time.

## Scope

- Add a server-authorized assistant tool layer for ordinary conversation, local retrieval, email retrieval, web research, and low-risk create operations.
- Persist idempotent assistant operation receipts through migration `033_assistant_agent_operations.sql`.
- Upgrade the NAV shell Service Worker cache to v5 and make activation recovery resilient to WebKit lifecycle gaps.
- Rebuild only `nav-api` and `nav-web`.

## Safety boundary

- Write tools require an explicit user command and are allowlisted per request.
- Tutorial, capability, and explanatory prompts do not trigger private retrieval or writes.
- The server revalidates the user, group ownership, URL provenance, abort state, and operation idempotency inside the write path.
- Update, delete, share, send-mail, and other destructive or externally visible actions remain unavailable.
- Migration 033 is additive. Normal application rollback retains the table and migration ledger; destructive database rollback is permitted only in an isolated rehearsal database.

## Release gates

1. Branch, pull request, and merged-master GitHub checks all pass.
2. A canonical production backup passes an isolated PostgreSQL 16 restore.
3. In an isolated PostgreSQL 16 clone, apply migration 033, run the current migration verifier, then rehearse removal of only the 033 table/ledger entry and run the `ff31262` verifier.
4. Candidate API image revision and release directory match the exact merge SHA.
5. Candidate `nav-web` passes `nginx -t` and serves Service Worker v5.
6. Switch only `nav-api` and `nav-web`; keep PostgreSQL, CLIProxyAPI, NPM, Vaultwarden, Komari, and all unrelated services unchanged.
7. Run dual-origin authenticated assistant and PWA checks, followed by a post-release canonical backup and isolated restore.

## Rollback

- Roll back the application to the exact pre-release API and Web release.
- Keep additive migration 033 in production during normal application rollback.
- Never overwrite the live database with the pre-release backup after post-release user writes.
- Use the backup only for an independently authorized data-corruption recovery into a new isolated database/volume.
