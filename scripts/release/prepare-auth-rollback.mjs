// Generate, never modify, the frozen pre-PWA application plus additive-schema safety.
// This is a separately verified rollback variant, not the unmodified old image.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const base = '6952684221e401eb0d41cc6aa9d53dfe8bab6377'
const repo = execFileSync('git', ['rev-parse', '--show-toplevel'], {encoding:'utf8'}).trim()
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim()
assert.match(revision, /^[a-f0-9]{40}$/)
execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], {cwd:repo})
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-auth-rollback-'))
const archive = path.join(root, 'base.tar')
execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, base], {cwd:repo})
execFileSync('tar', ['-xf', archive, '-C', root])
await fs.unlink(archive)
const read = relative => fs.readFile(path.join(root, relative), 'utf8')
const write = (relative, value) => fs.writeFile(path.join(root, relative), value)
function replaceOnce(value, from, to) {
  assert.equal(value.split(from).length, 2, 'Frozen rollback source no longer matches the reviewed patch')
  return value.replace(from, to)
}
for (const relative of [
  'api/src/db/migrations/048_pwa_oauth_handoffs.sql',
  'api/src/db/migrations/049_optional_device_keys.sql',
  'api/src/db/verifyMigrations.js',
  'api/src/lib/accountPasswordEffects.js'
]) await fs.copyFile(path.join(repo, relative), path.join(root, relative))

let source = await read('api/src/lib/authEmailChallenges.js')
const revokeSessions = "  await client.query('UPDATE users SET password_hash=$2,password_changed_at=NOW(),updated_at=NOW() WHERE id=$1',[user.id,await hashPassword(body.newPassword)])\n  await client.query('DELETE FROM sessions WHERE user_id=$1',[user.id])"
source = replaceOnce(source, revokeSessions, `${revokeSessions}
  if(challenge.purpose==='password_reset')await client.query('DELETE FROM auth_device_keys WHERE user_id=$1',[user.id])
  await client.query('DELETE FROM auth_oauth_handoffs WHERE user_id=$1',[user.id])
  await client.query('DELETE FROM auth_device_key_challenges WHERE user_id=$1',[user.id])`)
await write('api/src/lib/authEmailChallenges.js', source)
source = await read('api/src/routes/auth.js')
source = replaceOnce(source, "        [match.user_id]\n      )\n\n      await recordSecurityEvent", "        [match.user_id]\n      )\n      const removedDeviceKeys = await client.query('DELETE FROM auth_device_keys WHERE user_id=$1', [match.user_id])\n\n      await recordSecurityEvent")
source = replaceOnce(source, '          + (removedPasskeys.rowCount || 0)', '          + (removedPasskeys.rowCount || 0)\n          + (removedDeviceKeys.rowCount || 0)')
source = replaceOnce(source, 'removedPasskeyCount: removedPasskeys.rowCount || 0', 'removedPasskeyCount: (removedPasskeys.rowCount || 0) + (removedDeviceKeys.rowCount || 0)')
await write('api/src/routes/auth.js', source)

// Run the frozen baseline's full email/transaction suite and new recovery regressions.
source = await read('api/integration/authEmailPostgres.integration.js')
source = replaceOnce(source, "entry.name!=='047_auth_email_challenges.sql'", 'Number(entry.name.slice(0,3))<47')
source += '\n' + await fs.readFile(path.join(repo, 'scripts/release/auth-rollback-cases.js.txt'), 'utf8')
await write('api/integration/authEmailPostgres.integration.js', source)
await fs.writeFile(path.join(root, 'ROLLBACK_VARIANT.json'), JSON.stringify({base,revision,variant:'pre-pwa-auth-schema-compatible',features:'PWA handoff and device-key routes absent; legacy passkeys and mailbox remain retired'},null,2)+'\n')
process.stdout.write(JSON.stringify({root,base,revision})+'\n')
