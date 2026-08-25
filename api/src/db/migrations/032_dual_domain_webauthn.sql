ALTER TABLE webauthn_credentials
  DROP CONSTRAINT IF EXISTS webauthn_credentials_credential_id_key,
  DROP CONSTRAINT IF EXISTS webauthn_credentials_rp_credential_unique,
  ADD CONSTRAINT webauthn_credentials_rp_credential_unique
    UNIQUE (rp_id, credential_id),
  DROP CONSTRAINT IF EXISTS webauthn_credentials_rp_id_check,
  ADD CONSTRAINT webauthn_credentials_rp_id_check
    CHECK (rp_id IN ('nav.skrskr.net', 'nav.cristsau.cn'));

ALTER TABLE webauthn_challenges
  DROP CONSTRAINT IF EXISTS webauthn_challenges_rp_id_check,
  ADD CONSTRAINT webauthn_challenges_rp_id_check
    CHECK (rp_id IN ('nav.skrskr.net', 'nav.cristsau.cn')),
  DROP CONSTRAINT IF EXISTS webauthn_challenges_origin_check,
  ADD CONSTRAINT webauthn_challenges_origin_check
    CHECK (origin IN ('https://nav.skrskr.net', 'https://nav.cristsau.cn')),
  DROP CONSTRAINT IF EXISTS webauthn_challenges_rp_origin_check,
  ADD CONSTRAINT webauthn_challenges_rp_origin_check
    CHECK (
      (rp_id = 'nav.skrskr.net' AND origin = 'https://nav.skrskr.net')
      OR (rp_id = 'nav.cristsau.cn' AND origin = 'https://nav.cristsau.cn')
    );
