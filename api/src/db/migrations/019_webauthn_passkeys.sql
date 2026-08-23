CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,
  public_key BYTEA NOT NULL,
  webauthn_user_id TEXT NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  transports TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  device_type TEXT NOT NULL,
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  display_name TEXT NOT NULL,
  rp_id TEXT NOT NULL DEFAULT 'nav.skrskr.net',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  CONSTRAINT webauthn_credentials_counter_check
    CHECK (counter >= 0),
  CONSTRAINT webauthn_credentials_device_type_check
    CHECK (device_type IN ('singleDevice', 'multiDevice')),
  CONSTRAINT webauthn_credentials_display_name_check
    CHECK (char_length(display_name) BETWEEN 1 AND 128),
  CONSTRAINT webauthn_credentials_rp_id_check
    CHECK (rp_id = 'nav.skrskr.net')
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_created
  ON webauthn_credentials (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user_rp
  ON webauthn_credentials (user_id, rp_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  challenge TEXT NOT NULL UNIQUE,
  webauthn_user_id TEXT,
  rp_id TEXT NOT NULL DEFAULT 'nav.skrskr.net',
  origin TEXT NOT NULL DEFAULT 'https://nav.skrskr.net',
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT webauthn_challenges_kind_check
    CHECK (kind IN ('registration', 'authentication')),
  CONSTRAINT webauthn_challenges_rp_id_check
    CHECK (rp_id = 'nav.skrskr.net'),
  CONSTRAINT webauthn_challenges_origin_check
    CHECK (origin = 'https://nav.skrskr.net'),
  CONSTRAINT webauthn_challenges_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT webauthn_challenges_registration_scope_check
    CHECK (
      kind <> 'registration'
      OR (
        user_id IS NOT NULL
        AND session_id IS NOT NULL
        AND webauthn_user_id IS NOT NULL
      )
    ),
  CONSTRAINT webauthn_challenges_authentication_scope_check
    CHECK (kind <> 'authentication' OR session_id IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires
  ON webauthn_challenges (expires_at);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_unused
  ON webauthn_challenges (kind, expires_at)
  WHERE used_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_registration_session
  ON webauthn_challenges (session_id, user_id, created_at DESC)
  WHERE kind = 'registration' AND used_at IS NULL;
