-- New opt-in protocol. Retired /auth/passkeys endpoints and historical tables stay retired.
ALTER TABLE users ADD COLUMN auth_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE FUNCTION nav_stamp_auth_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
    OR NEW.email IS DISTINCT FROM OLD.email
    OR NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at
    OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.auth_changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nav_stamp_auth_change BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION nav_stamp_auth_change();

CREATE TABLE auth_device_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE CHECK (length(credential_id) BETWEEN 1 AND 2048),
  public_key BYTEA NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0 CHECK(counter>=0),
  rp_id TEXT NOT NULL DEFAULT 'nav.skrskr.net' CHECK(rp_id='nav.skrskr.net'),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
  transports JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(transports)='array'),
  device_type TEXT NOT NULL CHECK(device_type IN('singleDevice','multiDevice')),
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);
CREATE INDEX idx_auth_device_keys_user ON auth_device_keys(user_id,created_at,id);
ALTER TABLE sessions ADD COLUMN device_key_id UUID REFERENCES auth_device_keys(id) ON DELETE CASCADE;

CREATE TABLE auth_device_key_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL CHECK(kind IN('register','login')),
  challenge_digest CHAR(64) NOT NULL CHECK(challenge_digest ~ '^[0-9a-f]{64}$'),
  flow_digest CHAR(64) NOT NULL CHECK(flow_digest ~ '^[0-9a-f]{64}$'),
  origin TEXT NOT NULL CHECK(origin='https://nav.skrskr.net'),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  credential_version BIGINT,
  label TEXT,
  trust_device BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '5 minutes',
  CHECK(expires_at>created_at),
  CHECK((kind='register' AND user_id IS NOT NULL AND session_id IS NOT NULL AND credential_version IS NOT NULL AND label IS NOT NULL)
    OR (kind='login' AND user_id IS NULL AND session_id IS NULL AND credential_version IS NULL AND label IS NULL))
);
CREATE INDEX idx_auth_device_key_challenge_expiry ON auth_device_key_challenges(expires_at,id);
CREATE INDEX idx_auth_device_key_challenge_flow ON auth_device_key_challenges(flow_digest,kind);
