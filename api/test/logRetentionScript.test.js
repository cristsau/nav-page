import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('daily log retention is bounded to journald and the exact CLIProxy log mount', async () => {
  const [script, installer] = await Promise.all([
    readFile(new URL('../../ops/cron/nav-log-retention', import.meta.url), 'utf8'),
    readFile(new URL('../../scripts/install-nav-backup-systemd.sh', import.meta.url), 'utf8')
  ])
  assert.match(script, /--vacuum-time=30d/)
  assert.match(script, /com\.docker\.compose\.service=cliproxy/)
  assert.match(script, /\/CLIProxyAPI\/logs/)
  assert.match(script, /\/opt\/nav-stack\/releases\/\*\/cliproxy\/logs/)
  assert.match(script, /-type f -mtime \+30 -delete/)
  assert.doesNotMatch(script, /docker\s+(?:system|image|container)\s+prune/)
  assert.doesNotMatch(script, /rm\s+-rf/)
  assert.match(installer, /\/etc\/cron\.daily\/nav-log-retention/)
})
