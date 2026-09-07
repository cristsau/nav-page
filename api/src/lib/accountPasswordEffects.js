import {randomUUID} from 'node:crypto'
import {config} from '../config.js'
import {enqueueMail} from './mailOutbox.js'

// Called inside the same password transaction, including the legacy password/recovery paths.
export async function invalidatePasswordProofs(client,userId) {
 await client.query('UPDATE auth_email_challenges SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1 AND consumed_at IS NULL',[userId])
 await client.query('UPDATE account_recovery_codes SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1',[userId])
 const user=(await client.query('SELECT email,email_verified_at FROM users WHERE id=$1',[userId])).rows[0]
 if(user?.email_verified_at && config.mailDeliveryEnabled) {
   // Metadata-only notice: no OTP or password ever enters the legacy plaintext outbox.
   await enqueueMail({messageType:'auth.password.changed',recipient:user.email,subject:'DOMO NAV · 密码已修改',
     textBody:'您的账号密码已修改，全部设备已退出，旧恢复码已失效。如果不是您本人操作，请立即使用账号恢复流程处理。',
     dedupeKey:`password-change:${randomUUID()}`,queryFn:client.query.bind(client)})
 }
}
