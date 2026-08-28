CREATE TABLE IF NOT EXISTS oauth_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider VARCHAR(24) NOT NULL,
  subject_digest CHAR(64) NOT NULL,
  email_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  CONSTRAINT oauth_identities_provider_check
    CHECK (provider IN ('google', 'wechat')),
  CONSTRAINT oauth_identities_subject_digest_check
    CHECK (subject_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oauth_identities_provider_subject_unique
    UNIQUE (provider, subject_digest),
  CONSTRAINT oauth_identities_user_provider_unique
    UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_oauth_identities_user_created
  ON oauth_identities (user_id, created_at DESC, id);

CREATE TABLE IF NOT EXISTS oauth_authorization_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(24) NOT NULL,
  flow VARCHAR(16) NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  state_digest CHAR(64) NOT NULL UNIQUE,
  nonce_digest CHAR(64) NOT NULL,
  origin VARCHAR(255) NOT NULL,
  return_path VARCHAR(1000) NOT NULL DEFAULT '/',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oauth_authorization_requests_provider_check
    CHECK (provider IN ('google', 'wechat')),
  CONSTRAINT oauth_authorization_requests_flow_check
    CHECK (flow IN ('login', 'link')),
  CONSTRAINT oauth_authorization_requests_flow_user_check
    CHECK (
      (flow = 'login' AND user_id IS NULL)
      OR (flow = 'link' AND user_id IS NOT NULL)
    ),
  CONSTRAINT oauth_authorization_requests_state_digest_check
    CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oauth_authorization_requests_nonce_digest_check
    CHECK (nonce_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oauth_authorization_requests_origin_check
    CHECK (origin IN ('https://nav.skrskr.net', 'https://nav.cristsau.cn')),
  CONSTRAINT oauth_authorization_requests_return_path_check
    CHECK (
      return_path LIKE '/%'
      AND return_path NOT LIKE '//%'
      AND return_path !~ '[[:cntrl:]]'
    ),
  CONSTRAINT oauth_authorization_requests_expiry_check
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS idx_oauth_authorization_requests_expiry
  ON oauth_authorization_requests (expires_at, id);

CREATE INDEX IF NOT EXISTS idx_oauth_authorization_requests_user_created
  ON oauth_authorization_requests (user_id, created_at DESC, id)
  WHERE user_id IS NOT NULL;
