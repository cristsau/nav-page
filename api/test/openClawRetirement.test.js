import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

async function read(relativePath) {
  return fs.readFile(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8')
}

test('OpenClaw retirement migration removes provider secrets and saved engine references', async () => {
  const sql = await read('../src/db/migrations/009_remove_openclaw_config.sql')

  assert.match(sql, /value #- '\{search,providers,openclaw\}'/)
  assert.match(sql, /searchEngine[\s\S]*baidu/)
  assert.match(sql, /quickAccessEngineIds[\s\S]*- 'openclaw'/)
  assert.match(sql, /hiddenEngineIds[\s\S]*- 'openclaw'/)
  assert.match(sql, /aggregate,engines[\s\S]*- 'openclaw'/)
})

test('settings writes and legacy imports sanitize retired provider config', async () => {
  const [settings, migration] = await Promise.all([
    read('../src/routes/settings.js'),
    read('../src/routes/migration.js')
  ])
  const sanitizeIndex = settings.indexOf(
    'sanitizeRetiredSearchProviders(requestedValue)'
  )
  const validateIndex = settings.indexOf(
    'validateAppConfigModelIds(sanitizedRequestedValue)'
  )

  assert.ok(sanitizeIndex >= 0)
  assert.ok(validateIndex > sanitizeIndex)
  assert.match(
    migration,
    /sanitizeSettingForBackendExport[\s\S]*sanitizeRetiredSearchProviders\(record\.value\)/
  )
  assert.match(
    migration,
    /setting\.id === 'appConfig'[\s\S]*mergeAppConfigSecrets\(/
  )
})

test('retired provider has no frontend entry or backend execution branch', async () => {
  const [aiSearch, noteAi, useConfig, searchSettings] = await Promise.all([
    read('../src/routes/aiSearch.js'),
    read('../src/lib/noteAi.js'),
    read('../../app/src/shared/composables/useConfig.js'),
    read('../../app/src/modules/settings/components/SearchSettings.vue')
  ])

  assert.doesNotMatch(
    aiSearch,
    /runOpenClawSearch|engineId === 'openclaw'|provider === 'openclaw'/
  )
  assert.doesNotMatch(
    noteAi,
    /resolveOpenClawEndpoint|providerRecord\.id === 'openclaw'/
  )
  assert.doesNotMatch(useConfig, /openclaw:\s*\{\s*id:|providers\?\.openclaw/)
  assert.match(useConfig, /sanitizeRetiredSearchConfig/)
  assert.doesNotMatch(searchSettings, /OpenClaw 接入|providers\.openclaw/)
})
