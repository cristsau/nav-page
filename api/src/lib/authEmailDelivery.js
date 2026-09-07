import { config } from '../config.js'
import { pool } from '../db/index.js'
import { createSmtpTransport, normalizeEmailAddress } from './mailOutbox.js'
import { loadAuthEmailKeys, authEmailKeyVersion, authEmailJobContext, decryptAuthPayload } from './authEmailCrypto.js'
import { assertSafeOutboundHost } from './outboundEndpoints.js'

const LOCK='nav_auth_email_delivery'
const VALID_CHALLENGE=`c.consumed_at IS NULL AND c.revoked_at IS NULL AND c.failed_attempts<5
  AND c.expires_at>NOW()+INTERVAL '60 seconds' AND u.status='approved'
  AND c.credential_version=u.auth_version`

export function classifyAuthSmtpFailure(error) {
  const response=Number(error?.responseCode)
  if(response>=500)return {state:'failed',code:'SMTP_REJECTED'}
  // Only failures conclusively before DATA, or explicit temporary rejections, are retryable.
  if(response>=400 && response<500)return {state:'pending',code:'SMTP_TEMPORARY'}
  if(['CONN','EHLO','HELO','STARTTLS','AUTH','MAIL FROM','RCPT TO'].includes(error?.command)) {
    return {state:'pending',code:'SMTP_PRE_DATA_FAILURE'}
  }
  return {state:'unknown',code:'SMTP_OUTCOME_UNKNOWN'}
}

export async function deliverAuthEmails({
  poolInstance=pool,runtimeConfig=config,transportFactory=createSmtpTransport,
  loadKeys=loadAuthEmailKeys,assertHost=assertSafeOutboundHost
}={}) {
  const client=await poolInstance.connect()
  let locked=false,transport=null,releaseError
  const stats={accepted:0,failed:0,unknown:0,cancelled:0}
  try {
    locked=(await client.query('SELECT pg_try_advisory_lock(hashtext(current_database()),hashtext($1)) AS acquired',[LOCK])).rows[0].acquired
    if(!locked)return {...stats,skipped:'busy'}
    await client.query(`UPDATE auth_email_challenges SET revoked_at=NOW() WHERE id IN(
      SELECT id FROM auth_email_challenges WHERE revoked_at IS NULL AND consumed_at IS NULL AND (
        (purpose='login' AND NOT $1) OR (purpose IN('password_reset','password_change') AND NOT $2)
        OR (purpose IN('email_bind','email_change') AND NOT($1 OR $2))) ORDER BY created_at LIMIT 100)`,
      [Boolean(runtimeConfig.emailLoginEnabled),Boolean(runtimeConfig.emailPasswordResetEnabled)])
    // A previous owner died mid-send. Never replay a potentially accepted SMTP DATA.
    await client.query(`UPDATE auth_email_delivery_jobs SET state='unknown',encrypted_payload=NULL,error_code='SMTP_INTERRUPTED',updated_at=NOW()
      WHERE id IN(SELECT id FROM auth_email_delivery_jobs WHERE state='sending' ORDER BY created_at LIMIT 100)`)
    await client.query(`UPDATE auth_email_delivery_jobs j SET state='cancelled',encrypted_payload=NULL,updated_at=NOW()
      WHERE j.id IN(SELECT x.id FROM auth_email_delivery_jobs x
        LEFT JOIN auth_email_challenges c ON c.id=x.challenge_id LEFT JOIN users u ON u.id=c.user_id
        WHERE x.state='pending' AND (x.expires_at<=NOW() OR (x.challenge_id IS NOT NULL AND NOT(COALESCE((${VALID_CHALLENGE}),FALSE))))
        ORDER BY x.created_at LIMIT 100)`)
    await client.query(`UPDATE auth_email_delivery_jobs SET encrypted_payload=NULL,
      state=CASE WHEN state IN('pending','sending') THEN 'cancelled' ELSE state END,updated_at=NOW()
      WHERE id IN(SELECT id FROM auth_email_delivery_jobs WHERE encrypted_payload IS NOT NULL
        AND (state IN('accepted','failed','unknown','cancelled') OR expires_at<NOW()-INTERVAL '15 minutes') ORDER BY expires_at LIMIT 100)`)
    await client.query(`DELETE FROM auth_email_challenges WHERE id IN(
      SELECT id FROM auth_email_challenges WHERE expires_at<NOW()-INTERVAL '24 hours' ORDER BY expires_at LIMIT 100)`)
    await client.query(`DELETE FROM auth_reauth_grants WHERE id IN(
      SELECT id FROM auth_reauth_grants WHERE expires_at<NOW() ORDER BY expires_at LIMIT 100)`)
    await client.query(`DELETE FROM auth_action_grants WHERE token_digest IN(
      SELECT token_digest FROM auth_action_grants WHERE expires_at<NOW() ORDER BY expires_at LIMIT 100)`)
    await client.query(`DELETE FROM auth_email_delivery_jobs WHERE id IN(
      SELECT id FROM auth_email_delivery_jobs WHERE expires_at<NOW()-INTERVAL '24 hours' ORDER BY expires_at LIMIT 100)`)
    if(!runtimeConfig.mailDeliveryEnabled || (!runtimeConfig.emailLoginEnabled && !runtimeConfig.emailPasswordResetEnabled))return {...stats,skipped:'disabled'}
    const keys=await loadKeys(runtimeConfig)
    const jobs=(await client.query(`SELECT id FROM auth_email_delivery_jobs WHERE state='pending'
      AND next_attempt_at<=NOW() AND expires_at>NOW() ORDER BY created_at LIMIT 5`)).rows
    if(!jobs.length)return stats
    await assertHost(runtimeConfig.smtpHost,{label:'SMTP '})
    transport=await transportFactory(runtimeConfig)
    for(const selected of jobs) {
      // This UPDATE commits before network I/O; no user/challenge row lock is held during SMTP.
      const claimed=await client.query(`UPDATE auth_email_delivery_jobs j SET state='sending',attempts=attempts+1,updated_at=NOW()
        WHERE j.id=$1 AND j.state='pending' AND j.attempts<3 AND j.expires_at>NOW()
        AND (j.challenge_id IS NULL OR EXISTS(SELECT 1 FROM auth_email_challenges c JOIN users u ON u.id=c.user_id
          WHERE c.id=j.challenge_id AND ${VALID_CHALLENGE})) RETURNING j.*`,[selected.id])
      const job=claimed.rows[0]
      if(!job)continue
      let payload
      try {
        payload=decryptAuthPayload(job.encrypted_payload,authEmailJobContext(job),authEmailKeyVersion(keys,job.key_version))
        normalizeEmailAddress(payload.recipient)
        if(typeof payload.text!=='string' || typeof payload.subject!=='string')throw new Error('PAYLOAD_INVALID')
      } catch {
        await client.query(`UPDATE auth_email_delivery_jobs SET state='failed',encrypted_payload=NULL,error_code='PAYLOAD_UNAVAILABLE',updated_at=NOW() WHERE id=$1`,[job.id])
        stats.failed++; continue
      }
      try {
        const sent=await transport.sendMail({
          from:{name:String(runtimeConfig.smtpFromName || 'DOMO NAV').replace(/[\r\n]/g,'').slice(0,120),address:normalizeEmailAddress(runtimeConfig.smtpFromAddress)},
          to:payload.recipient,subject:payload.subject,text:payload.text,
          messageId:`<nav-auth-${job.id}@nav.skrskr.net>`,disableFileAccess:true,disableUrlAccess:true
        })
        const accepted=Array.isArray(sent.accepted) && sent.accepted.length>0 && !sent.rejected?.length
        await client.query(`UPDATE auth_email_delivery_jobs SET state=$2,encrypted_payload=NULL,
          accepted_at=CASE WHEN $2='accepted' THEN NOW() ELSE NULL END,error_code=$3,updated_at=NOW() WHERE id=$1`,
        [job.id,accepted?'accepted':'failed',accepted?null:'SMTP_REJECTED'])
        stats[accepted?'accepted':'failed']++
      } catch(error) {
        // Do not let a DB failure after send turn into a retry; state remains sending/unknown.
        if(!error?.command && !error?.responseCode && !['ETIMEDOUT','ECONNECTION','ESOCKET'].includes(error?.code))throw error
        let {state,code}=classifyAuthSmtpFailure(error)
        if(state==='pending' && job.attempts>=3)state='failed'
        await client.query(`UPDATE auth_email_delivery_jobs SET state=$2,error_code=$3,
          encrypted_payload=CASE WHEN $2='pending' THEN encrypted_payload ELSE NULL END,
          next_attempt_at=NOW()+($4 || ' seconds')::interval,updated_at=NOW() WHERE id=$1`,[job.id,state,code,job.attempts===1?'10':'30'])
        if(state!=='pending')stats[state]++
      } finally { payload=null }
    }
    return stats
  } finally {
    try { transport?.close?.() } catch {}
    if(locked) {
      try { await client.query('SELECT pg_advisory_unlock(hashtext(current_database()),hashtext($1))',[LOCK]) }
      catch(error) { releaseError=error }
    }
    client.release(releaseError)
  }
}

export function startAuthEmailDeliveryScheduler({poolInstance=pool,runtimeConfig=config,logger}={}) {
  let stopped=false,pending=null,lastErrorAt=0
  const tick=()=>{
    if(stopped || pending)return
    pending=deliverAuthEmails({poolInstance,runtimeConfig}).catch(()=>{
      if(Date.now()-lastErrorAt>=60000) {
        lastErrorAt=Date.now()
        logger?.error({event:'auth_email_delivery_unavailable'},'Authentication email delivery unavailable')
      }
    }).finally(()=>{pending=null})
  }
  const timer=setInterval(tick,2000)
  timer.unref?.()
  tick()
  return async()=>{stopped=true;clearInterval(timer);if(pending)await pending}
}
