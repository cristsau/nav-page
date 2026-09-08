-- Separate browser completion from the initiating Home Screen application's session.
-- No OAuth tokens, PKCE verifiers, session tokens or plaintext claim secrets are stored.
CREATE TABLE auth_oauth_handoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('google','wechat')),
  origin TEXT NOT NULL CHECK (origin IN ('https://nav.skrskr.net','https://nav.cristsau.cn')),
  claim_digest CHAR(64) NOT NULL UNIQUE CHECK (claim_digest ~ '^[0-9a-f]{64}$'),
  launch_digest CHAR(64) NOT NULL UNIQUE CHECK (launch_digest ~ '^[0-9a-f]{64}$'),
  return_path TEXT NOT NULL CHECK (return_path LIKE '/%' AND return_path NOT LIKE '//%' AND length(return_path)<=1000 AND return_path !~ '[[:cntrl:]]'),
  trust_device BOOLEAN NOT NULL DEFAULT FALSE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  identity_id UUID REFERENCES oauth_identities(id) ON DELETE CASCADE,
  credential_version BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  launch_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '1 minute',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '10 minutes',
  launched_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ,
  CHECK (launch_expires_at>created_at AND expires_at>created_at),
  CHECK ((approved_at IS NULL AND user_id IS NULL AND identity_id IS NULL AND credential_version IS NULL)
    OR (approved_at IS NOT NULL AND launched_at IS NOT NULL AND user_id IS NOT NULL AND identity_id IS NOT NULL AND credential_version IS NOT NULL))
);
CREATE INDEX idx_auth_oauth_handoff_expiry ON auth_oauth_handoffs(expires_at,id);
CREATE INDEX idx_auth_oauth_handoff_user ON auth_oauth_handoffs(user_id) WHERE user_id IS NOT NULL;
ALTER TABLE oauth_authorization_requests
  ADD COLUMN handoff_id UUID REFERENCES auth_oauth_handoffs(id) ON DELETE CASCADE,
  ADD COLUMN trust_device BOOLEAN NOT NULL DEFAULT FALSE;
