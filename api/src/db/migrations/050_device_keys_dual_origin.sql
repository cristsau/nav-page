-- Exact per-site RPs. Existing main-domain keys and the default remain unchanged.
-- The old application can still use main-domain keys after an application rollback.
SET LOCAL lock_timeout = '5s';
ALTER TABLE auth_device_keys DROP CONSTRAINT auth_device_keys_rp_id_check;
ALTER TABLE auth_device_keys ADD CONSTRAINT auth_device_keys_rp_id_check
  CHECK (rp_id IN ('nav.skrskr.net', 'nav.cristsau.cn'));
ALTER TABLE auth_device_key_challenges DROP CONSTRAINT auth_device_key_challenges_origin_check;
ALTER TABLE auth_device_key_challenges ADD CONSTRAINT auth_device_key_challenges_origin_check
  CHECK (origin IN ('https://nav.skrskr.net', 'https://nav.cristsau.cn'));
