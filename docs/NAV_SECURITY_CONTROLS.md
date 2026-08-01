# NAV shared rate limiting and security audit

## Scope

Migration `016_security_controls.sql` adds two additive PostgreSQL tables:

- `rate_limit_buckets` provides one fixed-window counter shared by every API replica.
- `security_events` records a minimal audit trail for authentication and critical account operations.

The migration does not modify or delete existing user data. An older API can continue to run with the new tables present, so application rollback normally leaves migration 016 in place.

## Persistent rate limiting

Public login, registration, account recovery, authenticated writes and AI requests use an atomic PostgreSQL `INSERT ... ON CONFLICT DO UPDATE`. The database clock defines the window and the primary key serializes concurrent increments for the same scope and identity.

Only an HMAC-SHA-256 digest is written to `rate_limit_buckets`. The raw client IP, username and user ID used to derive a bucket are never included in the SQL parameters. In production, configure a stable random secret of at least 32 characters:

```dotenv
NAV_RATE_LIMIT_KEY_SECRET=<owner-only random secret>
```

Generate and store this value on the server; never commit it to GitHub. All replicas must use the same value. Rotating it intentionally starts new logical buckets and changes future audit fingerprints.

Expired buckets are deleted opportunistically in bounded batches with `FOR UPDATE SKIP LOCKED`. Cleanup failure does not undo a counter that was already consumed, but it is logged for operations review.

### Failure policy

NAV does not fall back to an in-process counter. A missing/short production digest secret prevents the API process from starting. If PostgreSQL is unavailable or the atomic result is invalid while the API is running:

- public authentication returns `503`;
- authenticated writes return `503`;
- AI requests return `503`;
- a successfully consumed limit still returns `429` with `Retry-After` when exhausted.

This fail-closed policy prevents restarts or multiple API replicas from bypassing security and AI usage limits. Read-only authenticated endpoints do not consume the write bucket.

The bookmark health checker keeps its separate process-local limiter because that control bounds outbound probe concurrency inside one API process; it is not used as an authentication, account-write or AI usage security boundary.

## Security audit

The audit records these event families:

- login success, invalid credentials and denied unapproved/rate-limited attempts;
- logout and individual/bulk session revocation;
- recovery-code rotation and account recovery;
- registration approval/rejection, including Telegram-driven decisions;
- administrator Telegram configuration updates.

Events store only structured fields: event type, outcome, actor/subject user UUID when known, resource UUID when applicable, affected count and HMAC fingerprints for client IP/User-Agent. Passwords, recovery codes, session tokens, usernames, raw IP addresses, raw User-Agent values, request bodies and note content are never audit fields.

Administrators can query the newest events with:

```text
GET /api/admin/security-events?page=1&pageSize=50
GET /api/admin/security-events?eventType=auth.login&outcome=failure
```

The endpoint requires `requireAdmin`, caps pages at 200 events and exposes only 16-character correlation fingerprints rather than full digests.

## Release checks

Before a production switch:

1. Add `NAV_RATE_LIMIT_KEY_SECRET` to the owner-readable production `api/.env` used by every API replica.
2. Run the normal database backup and isolated restore rehearsal.
3. Let migrations run and execute `npm run verify:migrations` in the isolated release/CI environment.
4. Confirm unauthenticated `/api/admin/security-events` returns `401`.
5. Confirm an administrator can page the endpoint without seeing raw IP/User-Agent values.
6. Exercise a disposable failed login and a successful login; confirm both events appear.
7. Confirm an exhausted test bucket returns `429` plus `Retry-After`, while a deliberately unavailable database returns `503` rather than silently using local memory.

Do not test production limits by locking out the primary administrator account. Use a disposable approved account and restore normal rate-limit settings after acceptance.
