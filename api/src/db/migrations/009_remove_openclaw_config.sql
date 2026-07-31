-- OpenClaw was retired from DOMO NAV. Remove its stored destination and
-- credential before the application stops treating it as an active provider.
UPDATE user_settings
SET value = value #- '{search,providers,openclaw}',
    updated_at = NOW()
WHERE key = 'appConfig'
  AND value #> '{search,providers,openclaw}' IS NOT NULL;

UPDATE user_settings
SET value = jsonb_set(value, '{searchEngine}', '"baidu"'::jsonb, TRUE),
    updated_at = NOW()
WHERE key = 'appConfig'
  AND value ->> 'searchEngine' = 'openclaw';

UPDATE user_settings
SET value = jsonb_set(
      value,
      '{search,quickAccessEngineIds}',
      (value #> '{search,quickAccessEngineIds}') - 'openclaw',
      FALSE
    ),
    updated_at = NOW()
WHERE key = 'appConfig'
  AND jsonb_typeof(value #> '{search,quickAccessEngineIds}') = 'array'
  AND (value #> '{search,quickAccessEngineIds}') ? 'openclaw';

UPDATE user_settings
SET value = jsonb_set(
      value,
      '{search,hiddenEngineIds}',
      (value #> '{search,hiddenEngineIds}') - 'openclaw',
      FALSE
    ),
    updated_at = NOW()
WHERE key = 'appConfig'
  AND jsonb_typeof(value #> '{search,hiddenEngineIds}') = 'array'
  AND (value #> '{search,hiddenEngineIds}') ? 'openclaw';

UPDATE user_settings
SET value = jsonb_set(
      value,
      '{search,aggregate,engines}',
      (value #> '{search,aggregate,engines}') - 'openclaw',
      FALSE
    ),
    updated_at = NOW()
WHERE key = 'appConfig'
  AND jsonb_typeof(value #> '{search,aggregate,engines}') = 'array'
  AND (value #> '{search,aggregate,engines}') ? 'openclaw';
