import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../src/config.js'
import {
  applyManagedIntegrationsToRuntime,
  getManagedIntegrationsState,
  markManagedCloudVerified,
  markManagedMailVerified,
  saveManagedCloudBackupConfig,
  saveManagedMailConfig,
  withManagedIntegrationMutation
} from '../src/lib/managedIntegrations.js'

async function withManagedDirectory(callback) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nav-integrations-'))
  const original = { ...config }
  config.managedIntegrationsDir = directory
  try {
    return await callback(directory)
  } finally {
    Object.assign(config, original)
    await fs.rm(directory, { recursive: true, force: true })
  }
}

const baseMail = Object.freeze({
  deliveryEnabled: false,
  registrationEnabled: false,
  ingestEnabled: false,
  digestEnabled: false,
  smtpHost: 'mail.example.com',
  smtpPort: 465,
  smtpUsername: 'nav@example.com',
  smtpFromAddress: 'nav@example.com',
  smtpFromName: 'DOMO NAV',
  adminRecipients: ['admin@example.com'],
  ownerUsername: 'owner',
  imapHost: 'mail.example.com',
  imapPort: 993,
  imapUsername: 'nav@example.com',
  imapMailbox: 'INBOX',
  digestHours: [12, 20],
  digestTimeZone: 'Asia/Shanghai'
})

test('managed integration mutations are serialized across settings tabs', async () => {
  const order = []
  const first = withManagedIntegrationMutation(async () => {
    order.push('first-start')
    await new Promise((resolve) => setTimeout(resolve, 10))
    order.push('first-end')
  })
  const second = withManagedIntegrationMutation(async () => {
    order.push('second-start')
    order.push('second-end')
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'])
})

test('managed mail secrets are write-only and verified settings can be enabled', async () => {
  await withManagedDirectory(async (directory) => {
    const saved = await saveManagedMailConfig({
      ...baseMail,
      smtpPassword: 'smtp-test-password',
      imapPassword: 'imap-test-password'
    })
    assert.equal(saved.secrets.smtpPasswordConfigured, true)
    assert.equal(saved.secrets.imapPasswordConfigured, true)
    assert.equal(saved.secrets.encryptionConfigured, true)
    assert.equal(JSON.stringify(saved).includes('smtp-test-password'), false)
    assert.equal(JSON.stringify(saved).includes('imap-test-password'), false)

    const smtpSecret = await fs.readFile(path.join(directory, 'smtp-password'), 'utf8')
    assert.equal(smtpSecret.trim(), 'smtp-test-password')
    await markManagedMailVerified('smtp')
    await markManagedMailVerified('imap')
    await saveManagedMailConfig({
      ...baseMail,
      deliveryEnabled: true,
      registrationEnabled: true,
      ingestEnabled: true,
      digestEnabled: true
    })
    const state = await getManagedIntegrationsState()
    assert.equal(state.mail.config.deliveryEnabled, true)
    assert.equal(state.mail.config.registrationEnabled, true)
    assert.equal(state.mail.config.ingestEnabled, true)
    assert.equal(state.mail.verification.smtpVerified, true)
    assert.equal(state.mail.verification.imapVerified, true)
    assert.equal(config.smtpPasswordFile, path.join(directory, 'smtp-password'))
    assert.equal(config.imapPasswordFile, path.join(directory, 'imap-password'))
  })
})

test('changing a verified SMTP destination invalidates activation', async () => {
  await withManagedDirectory(async () => {
    await saveManagedMailConfig({ ...baseMail, smtpPassword: 'smtp-test-password' })
    await markManagedMailVerified('smtp')
    await assert.rejects(
      saveManagedMailConfig({
        ...baseMail,
        smtpHost: 'changed.example.com',
        deliveryEnabled: true
      }),
      /通过连接测试/
    )
  })
})

test('a rejected mail activation does not overwrite the working SMTP secret', async () => {
  await withManagedDirectory(async (directory) => {
    await saveManagedMailConfig({ ...baseMail, smtpPassword: 'working-password' })
    await markManagedMailVerified('smtp')
    await assert.rejects(
      saveManagedMailConfig({
        ...baseMail,
        smtpPassword: 'unverified-password',
        deliveryEnabled: true
      }),
      /通过连接测试/
    )
    const smtpSecret = await fs.readFile(path.join(directory, 'smtp-password'), 'utf8')
    assert.equal(smtpSecret.trim(), 'working-password')
  })
})

test('managed cloud backup writes restic files only after write-only credentials exist', async () => {
  await withManagedDirectory(async (directory) => {
    await saveManagedCloudBackupConfig({
      enabled: false,
      providerLabel: 'Cloudflare R2',
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucket: 'domo-nav-backup',
      region: 'auto',
      prefix: 'nav',
      addressingStyle: 'path',
      accessKeyId: 'access-key-id',
      secretAccessKey: 'secret-access-key'
    })
    await markManagedCloudVerified()
    await saveManagedCloudBackupConfig({ enabled: true })
    const state = await getManagedIntegrationsState()
    assert.equal(state.cloudBackup.config.enabled, true)
    assert.equal(state.cloudBackup.verification.verified, true)
    assert.equal(JSON.stringify(state).includes('secret-access-key'), false)
    const resticEnvironment = await fs.readFile(path.join(directory, 'restic-offsite.env'), 'utf8')
    const cloudEnvironment = await fs.readFile(path.join(directory, 'cloud-backup.env'), 'utf8')
    assert.match(resticEnvironment, /RESTIC_REPOSITORY=s3:https:\/\/account\.r2\.cloudflarestorage\.com\/domo-nav-backup\/nav/)
    assert.match(resticEnvironment, /AWS_ACCESS_KEY_ID=access-key-id/)
    assert.match(cloudEnvironment, /NAV_ENABLE_CLOUD_UPLOAD=true/)
    assert.match(cloudEnvironment, /NAV_RESTIC_ENV_FILE=/)
    await applyManagedIntegrationsToRuntime()
  })
})

test('a rejected cloud activation does not overwrite verified storage credentials', async () => {
  await withManagedDirectory(async (directory) => {
    await saveManagedCloudBackupConfig({
      endpoint: 'https://account.r2.cloudflarestorage.com',
      bucket: 'domo-nav-backup',
      accessKeyId: 'working-access-key',
      secretAccessKey: 'working-secret-key'
    })
    await markManagedCloudVerified()
    await assert.rejects(
      saveManagedCloudBackupConfig({
        enabled: true,
        accessKeyId: 'unverified-access-key'
      }),
      /通过只读连接测试/
    )
    const accessKey = await fs.readFile(path.join(directory, 's3-access-key-id'), 'utf8')
    assert.equal(accessKey.trim(), 'working-access-key')
  })
})
