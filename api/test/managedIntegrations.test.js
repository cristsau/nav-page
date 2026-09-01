import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { config } from '../src/config.js'
import {
  applyManagedIntegrationsToRuntime,
  createManagedMailAccount,
  getManagedIntegrationsState,
  markManagedCloudVerified,
  markManagedMailAccountVerified,
  markManagedMailVerified,
  saveManagedCloudBackupConfig,
  saveManagedMailAccount,
  saveManagedMailConfig,
  managedMailRuntimeConfigs,
  withManagedIntegrationMutation
} from '../src/lib/managedIntegrations.js'
import { resolveImapAuth, resolveSmtpAuth } from '../src/lib/emailOauth2.js'

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

test('one secondary mailbox keeps stable identity, isolated secrets and write-only public state', async () => {
  await withManagedDirectory(async (directory) => {
    await saveManagedMailConfig({
      ...baseMail,
      smtpPassword: 'primary-smtp-password',
      imapPassword: 'primary-imap-password'
    })
    const created = await createManagedMailAccount({
      ...baseMail,
      label: '工作邮箱',
      smtpUsername: 'work@example.com',
      smtpFromAddress: 'work@example.com',
      imapUsername: 'work@example.com',
      smtpPassword: 'secondary-smtp-password',
      imapPassword: 'secondary-imap-password'
    })
    assert.match(created.id, /^[a-f0-9]{24}$/)
    assert.equal(created.sourceKey, `managed.${created.id}`)
    assert.equal(created.label, '工作邮箱')
    assert.equal(created.secrets.smtpPasswordConfigured, true)
    assert.equal(created.secrets.imapPasswordConfigured, true)
    assert.equal(JSON.stringify(created).includes('secondary-smtp-password'), false)
    assert.equal(JSON.stringify(created).includes('secondary-imap-password'), false)

    assert.equal(
      (await fs.readFile(path.join(directory, `mail-account-${created.id}-smtp-password`), 'utf8')).trim(),
      'secondary-smtp-password'
    )
    assert.equal(
      (await fs.readFile(path.join(directory, `mail-account-${created.id}-imap-password`), 'utf8')).trim(),
      'secondary-imap-password'
    )
    await markManagedMailAccountVerified('smtp', created.id)
    await markManagedMailAccountVerified('imap', created.id)
    const enabled = await saveManagedMailAccount(created.id, {
      ...baseMail,
      label: '工作邮箱',
      smtpUsername: 'work@example.com',
      smtpFromAddress: 'work@example.com',
      imapUsername: 'work@example.com',
      deliveryEnabled: true,
      ingestEnabled: true,
      registrationEnabled: true,
      digestEnabled: true
    })
    assert.equal(enabled.id, created.id)
    assert.equal(enabled.sourceKey, created.sourceKey)
    assert.equal(enabled.config.deliveryEnabled, true)
    assert.equal(enabled.config.ingestEnabled, true)
    assert.equal(enabled.config.registrationEnabled, false)
    assert.equal(enabled.config.digestEnabled, false)
    assert.equal(enabled.verification.smtpVerified, true)
    assert.equal(enabled.verification.imapVerified, true)

    const state = await getManagedIntegrationsState()
    assert.equal(state.mailPrimaryManaged, true)
    assert.equal(state.mailAccountLimit, 2)
    assert.equal(state.mailAccounts.length, 1)
    assert.deepEqual(
      Object.keys(state.mailAccounts[0]).sort(),
      ['config', 'id', 'label', 'secrets', 'sourceKey', 'verification'].sort()
    )
    const runtimeConfigs = await managedMailRuntimeConfigs()
    assert.equal(runtimeConfigs.length, 2)
    assert.equal(runtimeConfigs[0].emailPrimaryAccount, true)
    assert.equal(runtimeConfigs[0].emailManagedAccount, true)
    assert.equal(runtimeConfigs[0].emailManagedAccountId, null)
    assert.equal(runtimeConfigs[1].emailPrimaryAccount, false)
    assert.equal(runtimeConfigs[1].emailManagedAccount, true)
    assert.equal(runtimeConfigs[1].emailManagedAccountId, created.id)
    assert.equal(runtimeConfigs[1].emailSourceKey, created.sourceKey)
    assert.equal(runtimeConfigs[1].emailAccountLabel, '工作邮箱')
    assert.equal(
      runtimeConfigs[1].smtpPasswordFile,
      path.join(directory, `mail-account-${created.id}-smtp-password`)
    )
    await assert.rejects(createManagedMailAccount({ label: '第三个邮箱' }), /最多支持两个邮箱账号/)

    const persisted = JSON.parse(await fs.readFile(path.join(directory, 'integrations.json'), 'utf8'))
    assert.equal(persisted.version, 1)
    assert.equal(persisted.mailAccounts.length, 1)
    assert.equal(JSON.stringify(persisted).includes('secondary-smtp-password'), false)
  })
})

test('managed mailbox owner binding cannot be silently reassigned', async () => {
  await withManagedDirectory(async () => {
    await saveManagedMailConfig({
      ...baseMail,
      smtpPassword: 'primary-smtp-password',
      imapPassword: 'primary-imap-password'
    })
    await assert.rejects(
      saveManagedMailConfig({ ...baseMail, ownerUsername: 'different-owner' }),
      /归属用户创建后不可修改/
    )

    const secondary = await createManagedMailAccount({
      ...baseMail,
      label: '工作邮箱',
      smtpUsername: 'work@example.com',
      smtpFromAddress: 'work@example.com',
      imapUsername: 'work@example.com',
      smtpPassword: 'secondary-smtp-password',
      imapPassword: 'secondary-imap-password'
    })
    await assert.rejects(
      saveManagedMailAccount(secondary.id, { ownerUsername: 'different-owner' }),
      /归属用户创建后不可修改/
    )
  })
})

test('primary OAuth never leaks into a secondary password-backed mailbox runtime', async () => {
  await withManagedDirectory(async (directory) => {
    config.smtpOauthProvider = 'google'
    config.imapOauthProvider = 'google'
    await saveManagedMailConfig({
      ...baseMail,
      smtpPassword: 'primary-smtp-password',
      imapPassword: 'primary-imap-password'
    })
    const secondary = await createManagedMailAccount({
      ...baseMail,
      label: '工作邮箱',
      smtpUsername: 'work@example.com',
      smtpFromAddress: 'work@example.com',
      imapUsername: 'work@example.com',
      smtpPassword: 'secondary-smtp-password',
      imapPassword: 'secondary-imap-password'
    })

    const runtimes = await managedMailRuntimeConfigs()
    const primaryRuntime = runtimes.find((item) => item.emailPrimaryAccount === true)
    const secondaryRuntime = runtimes.find((item) => item.emailSourceKey === secondary.sourceKey)
    assert.equal(primaryRuntime.smtpOauthProvider, 'google')
    assert.equal(primaryRuntime.imapOauthProvider, 'google')
    assert.equal(secondaryRuntime.smtpOauthProvider, '')
    assert.equal(secondaryRuntime.imapOauthProvider, '')

    let tokenCalls = 0
    const readSecretImpl = async (file) => {
      assert.match(file, new RegExp(`mail-account-${secondary.id}-(?:smtp|imap)-password$`))
      return (await fs.readFile(file, 'utf8')).trim()
    }
    const tokenProvider = async () => {
      tokenCalls += 1
      return { accessToken: 'must-not-be-used' }
    }
    assert.deepEqual(
      await resolveSmtpAuth(secondaryRuntime, { readSecretImpl, tokenProvider }),
      { user: 'work@example.com', pass: 'secondary-smtp-password' }
    )
    assert.deepEqual(
      await resolveImapAuth(secondaryRuntime, { readSecretImpl, tokenProvider }),
      { user: 'work@example.com', pass: 'secondary-imap-password' }
    )
    assert.equal(tokenCalls, 0)
    assert.equal(directory, config.managedIntegrationsDir)
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
