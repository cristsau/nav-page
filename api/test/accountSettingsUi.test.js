import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const sourceFile = (path) => fs.readFile(
  fileURLToPath(new URL(`../../${path}`, import.meta.url)),
  'utf8'
)

test('account update routes verify the current password and revoke all sessions on password change', async () => {
  const source = await sourceFile('api/src/routes/auth.js')
  const usernameRoute = source.slice(
    source.indexOf("fastify.put('/auth/account/username'"),
    source.indexOf("fastify.put('/auth/account/password'")
  )
  const passwordRoute = source.slice(
    source.indexOf("fastify.put('/auth/account/password'"),
    source.indexOf("fastify.get('/auth/sessions'")
  )

  assert.match(usernameRoute, /verifyPassword\(currentPassword, user\.password_hash\)/)
  assert.match(usernameRoute, /auth\.account\.username\.update/)
  assert.match(usernameRoute, /error\?\.code === '23505'/)
  assert.match(passwordRoute, /validateNewPassword\(newPassword\)/)
  assert.match(passwordRoute, /password_changed_at = NOW\(\)/)
  assert.match(passwordRoute, /DELETE FROM sessions WHERE user_id = \$1/)
  assert.match(passwordRoute, /clearSessionCookie\(reply\)/)
  assert.match(passwordRoute, /auth\.account\.password\.update/)
})

test('settings exposes protected username and password forms without storing credentials', async () => {
  const [component, authService, authComposable, authView] = await Promise.all([
    sourceFile('app/src/modules/settings/components/AccountSecuritySettings.vue'),
    sourceFile('app/src/shared/services/authApi.js'),
    sourceFile('app/src/shared/composables/useAuth.js'),
    sourceFile('app/src/modules/auth/AuthView.vue')
  ])

  assert.match(component, /修改用户名/)
  assert.match(component, /修改密码/)
  assert.match(component, /v-model="usernameCurrentPassword"/)
  assert.match(component, /v-model="passwordCurrentPassword"/)
  assert.match(component, /v-model="newPassword"/)
  assert.match(component, /v-model="confirmPassword"/)
  assert.match(component, /autocomplete="current-password"/)
  assert.match(component, /autocomplete="new-password"/)
  assert.match(component, /所有设备（包括当前设备）会立即退出登录/)
  assert.match(authService, /\/auth\/account\/username/)
  assert.match(authService, /\/auth\/account\/password/)
  assert.match(authComposable, /sessionCoordinator\.accept\(result\.user/)
  assert.match(authComposable, /clearCurrentAuthState\(\)/)
  assert.match(authView, /route\.query\.passwordChanged/)
  assert.match(authView, /密码已修改，所有设备均已退出/)
  assert.doesNotMatch(component, /localStorage|sessionStorage|indexedDB/i)
})
