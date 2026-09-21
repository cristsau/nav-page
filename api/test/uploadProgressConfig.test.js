import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
const module = new URL('../src/config.js', import.meta.url).href
test('upload progress can live outside backed-up integrations without moving OAuth or offline queue', () => {
  for (const [progress, expected] of [['/var/lib/nav-upload-progress', '/var/lib/nav-upload-progress'], ['', '/etc/nav/integrations']]) {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import {config} from ${JSON.stringify(module)};console.log(JSON.stringify([config.uploadProgressDir,config.managedIntegrationsDir]));`], {
      encoding: 'utf8', env: { ...process.env, NAV_UPLOAD_PROGRESS_DIR: progress, NAV_MANAGED_INTEGRATIONS_DIR: '/etc/nav/integrations' }
    })
    assert.equal(r.status, 0); assert.deepEqual(JSON.parse(r.stdout), [expected, '/etc/nav/integrations'])
  }
})
