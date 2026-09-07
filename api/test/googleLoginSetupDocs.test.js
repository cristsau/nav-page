import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('Google login runbook keeps identity scopes separate from Gmail OAuth', async () => {
  const runbook = await readFile(
    new URL('../../docs/NAV_GOOGLE_LOGIN_SETUP.md', import.meta.url),
    'utf8'
  )
  assert.match(runbook, /`openid`、`email`、`profile`/)
  assert.match(runbook, /不读取 Gmail、Google Drive、联系人或日历/)
  assert.match(runbook, /https:\/\/nav\.skrskr\.net\/api\/auth\/oauth\/google\/callback/)
  assert.match(runbook, /https:\/\/nav\.cristsau\.cn\/api\/auth\/oauth\/google\/callback/)
  assert.match(runbook, /保持“允许 Google 已验证邮箱自动匹配……”关闭/)
  assert.match(runbook, /不需要“已获授权的 JavaScript/)
})
