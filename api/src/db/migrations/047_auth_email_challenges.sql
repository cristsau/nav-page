ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version BIGINT NOT NULL DEFAULT 0;

CREATE TABLE auth_reauth_grants (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL DEFAULT 'email_identity' CHECK(purpose='email_identity'),
  flow_digest CHAR(64) NOT NULL,
  credential_version BIGINT NOT NULL,
  old_email_verified_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);

CREATE TABLE auth_email_challenges (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('login','password_reset','password_change','email_bind','email_change')),
  email_key_digest CHAR(64) NOT NULL,
  email_ciphertext TEXT NOT NULL,
  origin TEXT NOT NULL,
  flow_digest CHAR(64) NOT NULL,
  code_mac CHAR(64) NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  credential_version BIGINT NOT NULL,
  grant_id UUID REFERENCES auth_reauth_grants(id) ON DELETE CASCADE,
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
  consumed_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '5 minutes',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (expires_at > created_at)
);
CREATE INDEX idx_auth_email_challenge_expiry ON auth_email_challenges(expires_at,id);
CREATE INDEX idx_auth_email_challenge_user ON auth_email_challenges(user_id,purpose,created_at);
CREATE INDEX idx_auth_email_grant_expiry ON auth_reauth_grants(expires_at,id);

CREATE TABLE auth_action_grants (
  token_digest CHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN('GET','POST','PUT','DELETE','PATCH')),
  action_path TEXT NOT NULL CHECK(length(action_path) BETWEEN 1 AND 160),
  credential_version BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '5 minutes',
  CHECK(expires_at>created_at)
);
CREATE INDEX idx_auth_action_grants_expiry ON auth_action_grants(expires_at);

CREATE TABLE auth_email_delivery_jobs (
  id UUID PRIMARY KEY,
  challenge_id UUID UNIQUE REFERENCES auth_email_challenges(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL CHECK (message_type IN ('auth.email.login','auth.password.reset','auth.password.change.verify','auth.email.bind','auth.email.change.verify','auth.password.changed','auth.email.changed')),
  dedupe_key TEXT NOT NULL UNIQUE,
  encrypted_payload TEXT,
  key_version INTEGER NOT NULL CHECK (key_version > 0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','accepted','failed','unknown','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  error_code TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK(expires_at>created_at),
  CHECK(message_type IN('auth.password.changed','auth.email.changed') OR challenge_id IS NOT NULL),
  CHECK(state NOT IN('pending','sending') OR encrypted_payload IS NOT NULL)
);
CREATE INDEX idx_auth_email_delivery_pending ON auth_email_delivery_jobs(next_attempt_at,id) WHERE state='pending';
CREATE INDEX idx_auth_email_delivery_expiry ON auth_email_delivery_jobs(expires_at,id);

-- Existing password / recovery / admin paths also invalidate outstanding proofs.
CREATE FUNCTION nav_auth_identity_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.password_hash IS DISTINCT FROM OLD.password_hash
     OR NEW.email IS DISTINCT FROM OLD.email
     OR NEW.email_verified_at IS DISTINCT FROM OLD.email_verified_at
     OR NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.auth_version := OLD.auth_version + 1;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER nav_auth_identity_version BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION nav_auth_identity_version();
