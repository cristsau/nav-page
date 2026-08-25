<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  fetchManagedIntegrations,
  saveManagedCloudBackup,
  saveManagedMail,
  testManagedCloudBackup,
  testManagedImap,
  testManagedSmtp
} from '@/shared/services/integrationApi'

const loading = ref(true)
const busyAction = ref('')
const message = ref('')
const error = ref('')
const writable = ref(false)
const updatedAt = ref(null)
const savedSmtpFingerprint = ref('')
const savedImapFingerprint = ref('')
const savedCloudFingerprint = ref('')
const errorNotice = ref(null)
const smtpHostInput = ref(null)
const imapHostInput = ref(null)
const busyActionLabel = computed(() => ({
  'save-mail': '正在安全保存邮件配置…',
  'test-smtp': '正在验证 SMTP 连接…',
  'test-imap': '正在验证 IMAP 连接…',
  'save-cloud': '正在安全保存云备份配置…',
  'test-cloud': '正在验证对象存储连接…'
}[busyAction.value] || '正在处理…'))

const SERVER_HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

const mail = reactive({
  deliveryEnabled: false,
  registrationEnabled: false,
  ingestEnabled: false,
  digestEnabled: false,
  smtpHost: '',
  smtpPort: 465,
  smtpUsername: '',
  smtpFromAddress: '',
  smtpFromName: 'DOMO NAV',
  adminRecipientsText: '',
  ownerUsername: '',
  imapHost: '',
  imapPort: 993,
  imapUsername: '',
  imapMailbox: 'INBOX',
  digestHoursText: '12,20',
  digestTimeZone: 'Asia/Shanghai',
  smtpPassword: '',
  imapPassword: '',
  reuseSmtpPasswordForImap: false,
  smtpPasswordConfigured: false,
  imapPasswordConfigured: false,
  encryptionConfigured: false,
  smtpVerified: false,
  smtpVerifiedAt: null,
  imapVerified: false,
  imapVerifiedAt: null
})

const cloud = reactive({
  enabled: false,
  providerLabel: 'S3 Compatible',
  endpoint: '',
  bucket: '',
  region: 'auto',
  prefix: 'nav',
  addressingStyle: 'path',
  accessKeyId: '',
  secretAccessKey: '',
  sessionToken: '',
  accessKeyConfigured: false,
  secretKeyConfigured: false,
  sessionTokenConfigured: false,
  resticPasswordConfigured: false,
  verified: false,
  verifiedAt: null,
  hostAgentInstalled: false,
  timerEnabled: false,
  hostAgentUpdatedAt: null
})

function smtpFingerprint() {
  return JSON.stringify([
    mail.smtpHost,
    mail.smtpUsername,
    mail.smtpFromAddress,
    Boolean(mail.smtpPassword)
  ])
}

function imapFingerprint() {
  return JSON.stringify([
    mail.ownerUsername,
    mail.imapHost,
    mail.imapUsername,
    mail.imapMailbox,
    mail.reuseSmtpPasswordForImap,
    Boolean(mail.imapPassword)
  ])
}

function cloudFingerprint() {
  return JSON.stringify([
    cloud.endpoint,
    cloud.bucket,
    cloud.region,
    cloud.prefix,
    cloud.addressingStyle,
    Boolean(cloud.accessKeyId),
    Boolean(cloud.secretAccessKey),
    Boolean(cloud.sessionToken)
  ])
}

const smtpHasUnsavedChanges = computed(() => smtpFingerprint() !== savedSmtpFingerprint.value)
const imapHasUnsavedChanges = computed(() => imapFingerprint() !== savedImapFingerprint.value)
const cloudHasUnsavedChanges = computed(() => cloudFingerprint() !== savedCloudFingerprint.value)
const smtpReadyToTest = computed(() => Boolean(
  mail.smtpHost && mail.smtpUsername && mail.smtpFromAddress
  && mail.smtpPasswordConfigured && !smtpHasUnsavedChanges.value
))
const imapReadyToTest = computed(() => Boolean(
  mail.ownerUsername && mail.imapHost && mail.imapUsername
  && (mail.imapPasswordConfigured || (mail.reuseSmtpPasswordForImap && mail.smtpPasswordConfigured))
  && !imapHasUnsavedChanges.value
))
const cloudReadyToTest = computed(() => Boolean(
  cloud.endpoint && cloud.bucket && cloud.accessKeyConfigured && cloud.secretKeyConfigured
  && !cloudHasUnsavedChanges.value
))

function serverHostError(value, label) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '')
  if (!host) return ''
  if (host.includes('@')) {
    return `${label}要填写服务器主机名（例如 mail.example.com），不是邮箱地址。`
  }
  if (!SERVER_HOST_PATTERN.test(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return `${label}格式无效，请填写邮箱服务商提供的服务器主机名。`
  }
  return ''
}

const smtpHostError = computed(() => serverHostError(mail.smtpHost, 'SMTP 主机'))
const imapHostError = computed(() => serverHostError(mail.imapHost, 'IMAP 主机'))

watch(smtpFingerprint, (current) => {
  if (!savedSmtpFingerprint.value || current === savedSmtpFingerprint.value) return
  mail.smtpVerified = false
  mail.smtpVerifiedAt = null
  mail.deliveryEnabled = false
  mail.registrationEnabled = false
})

watch(imapFingerprint, (current) => {
  if (!savedImapFingerprint.value || current === savedImapFingerprint.value) return
  mail.imapVerified = false
  mail.imapVerifiedAt = null
  mail.ingestEnabled = false
  mail.digestEnabled = false
})

watch(cloudFingerprint, (current) => {
  if (!savedCloudFingerprint.value || current === savedCloudFingerprint.value) return
  cloud.verified = false
  cloud.verifiedAt = null
  cloud.enabled = false
})

function formatDate(value) {
  if (!value) return '尚未验证'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

function statusLabel(ok, yes = '已验证', no = '待验证') {
  return ok ? yes : no
}

function applyState(state) {
  writable.value = state.writable === true
  updatedAt.value = state.updatedAt || null
  const mailState = state.mail || {}
  const mailConfig = mailState.config || {}
  Object.assign(mail, {
    ...mailConfig,
    adminRecipientsText: (mailConfig.adminRecipients || []).join(', '),
    digestHoursText: (mailConfig.digestHours || [12, 20]).join(','),
    smtpPassword: '',
    imapPassword: '',
    reuseSmtpPasswordForImap: false,
    smtpPasswordConfigured: mailState.secrets?.smtpPasswordConfigured === true,
    imapPasswordConfigured: mailState.secrets?.imapPasswordConfigured === true,
    encryptionConfigured: mailState.secrets?.encryptionConfigured === true,
    smtpVerified: mailState.verification?.smtpVerified === true,
    smtpVerifiedAt: mailState.verification?.smtpVerifiedAt || null,
    imapVerified: mailState.verification?.imapVerified === true,
    imapVerifiedAt: mailState.verification?.imapVerifiedAt || null
  })
  const cloudState = state.cloudBackup || {}
  const cloudConfig = cloudState.config || {}
  Object.assign(cloud, {
    ...cloudConfig,
    accessKeyId: '',
    secretAccessKey: '',
    sessionToken: '',
    accessKeyConfigured: cloudState.secrets?.accessKeyConfigured === true,
    secretKeyConfigured: cloudState.secrets?.secretKeyConfigured === true,
    sessionTokenConfigured: cloudState.secrets?.sessionTokenConfigured === true,
    resticPasswordConfigured: cloudState.secrets?.resticPasswordConfigured === true,
    verified: cloudState.verification?.verified === true,
    verifiedAt: cloudState.verification?.verifiedAt || null,
    hostAgentInstalled: cloudState.hostAgent?.installed === true,
    timerEnabled: cloudState.hostAgent?.timerEnabled === true,
    hostAgentUpdatedAt: cloudState.hostAgent?.updatedAt || null
  })
  savedSmtpFingerprint.value = smtpFingerprint()
  savedImapFingerprint.value = imapFingerprint()
  savedCloudFingerprint.value = cloudFingerprint()
}

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    applyState(await fetchManagedIntegrations())
  } catch (caught) {
    error.value = caught.message || '无法读取集成配置。'
  } finally {
    loading.value = false
  }
}

function mailPayload() {
  return {
    deliveryEnabled: mail.deliveryEnabled,
    registrationEnabled: mail.registrationEnabled,
    ingestEnabled: mail.ingestEnabled,
    digestEnabled: mail.digestEnabled,
    smtpHost: mail.smtpHost,
    smtpPort: 465,
    smtpUsername: mail.smtpUsername,
    smtpFromAddress: mail.smtpFromAddress,
    smtpFromName: mail.smtpFromName,
    adminRecipients: mail.adminRecipientsText.split(',').map((value) => value.trim()).filter(Boolean),
    ownerUsername: mail.ownerUsername,
    imapHost: mail.imapHost,
    imapPort: 993,
    imapUsername: mail.imapUsername,
    imapMailbox: mail.imapMailbox,
    digestHours: mail.digestHoursText.split(',').map((value) => Number(value.trim())).filter(Number.isInteger),
    digestTimeZone: mail.digestTimeZone,
    ...(mail.smtpPassword ? { smtpPassword: mail.smtpPassword } : {}),
    ...(mail.imapPassword ? { imapPassword: mail.imapPassword } : {}),
    reuseSmtpPasswordForImap: mail.reuseSmtpPasswordForImap
  }
}

async function run(action, successText, callback) {
  busyAction.value = action
  message.value = ''
  error.value = ''
  try {
    const result = await callback()
    message.value = successText
    return result
  } catch (caught) {
    error.value = caught.message || '操作失败，请稍后重试。'
    await nextTick()
    errorNotice.value?.focus({ preventScroll: true })
    errorNotice.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return null
  } finally {
    busyAction.value = ''
  }
}

async function saveMail() {
  const invalidHost = smtpHostError.value
    ? { input: smtpHostInput.value, message: smtpHostError.value }
    : imapHostError.value
      ? { input: imapHostInput.value, message: imapHostError.value }
      : null
  if (invalidHost) {
    message.value = ''
    error.value = invalidHost.message
    await nextTick()
    invalidHost.input?.focus({ preventScroll: true })
    invalidHost.input?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  const result = await run('save-mail', '邮件配置已安全保存并应用。', () => saveManagedMail(mailPayload()))
  if (result?.mail) {
    const current = await fetchManagedIntegrations()
    applyState(current)
  }
}

async function testSmtp() {
  const result = await run('test-smtp', 'SMTP 连接验证成功，现在可以启用邮件发送。', testManagedSmtp)
  if (result?.mail) {
    const current = await fetchManagedIntegrations()
    applyState(current)
  }
}

async function testImap() {
  const result = await run('test-imap', 'IMAP 连接验证成功，现在可以启用智能收件。', testManagedImap)
  if (result?.mail) {
    const current = await fetchManagedIntegrations()
    applyState(current)
  }
}

function cloudPayload() {
  return {
    enabled: cloud.enabled,
    providerLabel: cloud.providerLabel,
    endpoint: cloud.endpoint,
    bucket: cloud.bucket,
    region: cloud.region,
    prefix: cloud.prefix,
    addressingStyle: cloud.addressingStyle,
    ...(cloud.accessKeyId ? { accessKeyId: cloud.accessKeyId } : {}),
    ...(cloud.secretAccessKey ? { secretAccessKey: cloud.secretAccessKey } : {}),
    ...(cloud.sessionToken ? { sessionToken: cloud.sessionToken } : {})
  }
}

async function saveCloud() {
  const result = await run('save-cloud', '云备份配置与 Restic 加密参数已安全保存。', () => saveManagedCloudBackup(cloudPayload()))
  if (result?.cloudBackup) applyState(await fetchManagedIntegrations())
}

async function testCloud() {
  const result = await run('test-cloud', '对象存储只读连接测试成功，现在可以允许云端上传。', testManagedCloudBackup)
  if (result?.cloudBackup) applyState(await fetchManagedIntegrations())
}

onMounted(refresh)
</script>

<template>
  <section class="integration-page" aria-labelledby="system-integrations-title">
    <div class="integration-heading">
      <div>
        <h3 id="system-integrations-title">系统集成</h3>
        <p>自行配置支持标准 SMTP / IMAP 的邮箱和任意 S3 兼容对象存储。Secret 只写入服务器，不会回传到浏览器。</p>
      </div>
      <button class="button button--secondary" type="button" :disabled="loading || busyAction" @click="refresh">
        <Icon name="refresh" :size="16" />
        {{ loading ? '读取中' : '刷新状态' }}
      </button>
    </div>

    <div v-if="!writable && !loading" class="notice notice--warning" role="alert">
      服务器尚未挂载可管理集成目录。当前页面为只读；发布时配置 NAV_MANAGED_INTEGRATIONS_DIR 后即可自助保存。
    </div>
    <p v-if="message" class="notice notice--success" role="status">{{ message }}</p>
    <p v-if="error" ref="errorNotice" class="notice notice--error" role="alert" tabindex="-1">{{ error }}</p>

    <form class="integration-card" novalidate @submit.prevent="saveMail">
      <header class="card-header">
        <div class="card-icon"><Icon name="mail" :size="20" /></div>
        <div>
          <h4>邮件服务（SMTP / IMAP）</h4>
          <p>兼容使用密码或应用专用密码、支持 SMTP 465 与 IMAP 993 隐式 TLS 的邮箱。仅支持 OAuth 登录的邮箱暂未接入。</p>
        </div>
      </header>

      <div class="status-row" aria-label="邮件配置状态">
        <span :class="{ 'is-ok': mail.smtpVerified }">SMTP {{ statusLabel(mail.smtpVerified) }}</span>
        <span :class="{ 'is-ok': mail.imapVerified }">IMAP {{ statusLabel(mail.imapVerified) }}</span>
        <span :class="{ 'is-ok': mail.encryptionConfigured }">正文加密 {{ mail.encryptionConfigured ? '已生成' : '待生成' }}</span>
      </div>

      <fieldset>
        <legend>发送设置</legend>
        <div class="field-grid">
          <label>
            <span>SMTP 主机</span>
            <input
              ref="smtpHostInput"
              v-model.trim="mail.smtpHost"
              type="text"
              autocomplete="off"
              placeholder="mail.example.com"
              :aria-invalid="Boolean(smtpHostError)"
              :aria-describedby="smtpHostError ? 'smtp-host-tip smtp-host-error' : 'smtp-host-tip'"
            >
            <small id="smtp-host-tip" class="field-help">填服务器主机名，不是邮箱地址。可在邮箱服务商的客户端设置或域名主 MX 记录中查看。</small>
            <small v-if="smtpHostError" id="smtp-host-error" class="field-error">{{ smtpHostError }}</small>
          </label>
          <label><span>端口</span><input :value="465" type="number" readonly aria-describedby="smtp-tls-tip"></label>
          <label><span>登录邮箱</span><input v-model.trim="mail.smtpUsername" type="email" autocomplete="username" placeholder="nav@example.com"></label>
          <label><span>SMTP 密码</span><input v-model="mail.smtpPassword" type="password" autocomplete="new-password" :placeholder="mail.smtpPasswordConfigured ? '已安全保存，留空保持不变' : '输入邮箱密码'"></label>
          <label><span>发件地址</span><input v-model.trim="mail.smtpFromAddress" type="email" autocomplete="off" placeholder="nav@example.com"></label>
          <label><span>发件人名称</span><input v-model.trim="mail.smtpFromName" type="text" autocomplete="off"></label>
        </div>
        <p id="smtp-tls-tip" class="field-tip">固定使用 465 / TLS 1.2+，不提供明文或降级连接。</p>
        <label class="field-wide"><span>管理员通知邮箱（逗号分隔）</span><input v-model="mail.adminRecipientsText" type="text" autocomplete="off" placeholder="admin@example.com"></label>
        <div class="action-row">
          <span>{{ smtpHasUnsavedChanges ? '请先保存 SMTP 修改，再进行连接测试。' : `最近验证：${formatDate(mail.smtpVerifiedAt)}` }}</span>
          <button class="button button--secondary" type="button" :disabled="!writable || !smtpReadyToTest || busyAction" @click="testSmtp">
            {{ busyAction === 'test-smtp' ? '测试中' : '测试 SMTP' }}
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>智能收件</legend>
        <div class="field-grid">
          <label><span>归属 NAV 用户名</span><input v-model.trim="mail.ownerUsername" type="text" autocomplete="off" placeholder="cristsau"></label>
          <label>
            <span>IMAP 主机</span>
            <input
              ref="imapHostInput"
              v-model.trim="mail.imapHost"
              type="text"
              autocomplete="off"
              placeholder="mail.example.com"
              :aria-invalid="Boolean(imapHostError)"
              :aria-describedby="imapHostError ? 'imap-host-tip imap-host-error' : 'imap-host-tip'"
            >
            <small id="imap-host-tip" class="field-help">通常与 SMTP 主机相同；这里同样不能填写登录邮箱。</small>
            <small v-if="imapHostError" id="imap-host-error" class="field-error">{{ imapHostError }}</small>
          </label>
          <label><span>登录邮箱</span><input v-model.trim="mail.imapUsername" type="email" autocomplete="off" placeholder="nav@example.com"></label>
          <label><span>IMAP 密码</span><input v-model="mail.imapPassword" type="password" autocomplete="new-password" :disabled="mail.reuseSmtpPasswordForImap" :placeholder="mail.imapPasswordConfigured ? '已安全保存，留空保持不变' : '输入邮箱密码'"></label>
          <label><span>邮箱目录</span><input v-model.trim="mail.imapMailbox" type="text" autocomplete="off"></label>
          <label><span>摘要时间（小时，逗号分隔）</span><input v-model="mail.digestHoursText" type="text" inputmode="numeric" autocomplete="off"></label>
          <label><span>摘要时区</span><input v-model.trim="mail.digestTimeZone" type="text" autocomplete="off"></label>
        </div>
        <label class="check-row"><input v-model="mail.reuseSmtpPasswordForImap" type="checkbox">IMAP 与 SMTP 使用同一个密码</label>
        <div class="action-row">
          <span>{{ imapHasUnsavedChanges ? '请先保存 IMAP 修改，再进行连接测试。' : `最近验证：${formatDate(mail.imapVerifiedAt)}` }}</span>
          <button class="button button--secondary" type="button" :disabled="!writable || !imapReadyToTest || busyAction" @click="testImap">
            {{ busyAction === 'test-imap' ? '测试中' : '测试 IMAP' }}
          </button>
        </div>
      </fieldset>

      <fieldset>
        <legend>功能开关</legend>
        <div class="toggle-grid">
          <label><input v-model="mail.deliveryEnabled" type="checkbox" :disabled="!mail.smtpVerified">邮件发送队列</label>
          <label><input v-model="mail.registrationEnabled" type="checkbox" :disabled="!mail.deliveryEnabled">注册邮箱验证与审批通知</label>
          <label><input v-model="mail.ingestEnabled" type="checkbox" :disabled="!mail.imapVerified">IMAP 智能收件</label>
          <label><input v-model="mail.digestEnabled" type="checkbox" :disabled="!mail.ingestEnabled">每日邮件摘要</label>
        </div>
      </fieldset>

      <footer class="card-footer">
        <p>修改主机名、账号或密码后，原验证自动失效，需重新测试后才能启用。</p>
        <button class="button button--primary" type="button" :disabled="!writable || busyAction" @click="saveMail">
          <Icon name="check" :size="16" />
          {{ busyAction === 'save-mail' ? '保存中' : '保存邮件配置' }}
        </button>
      </footer>
    </form>

    <form class="integration-card" novalidate @submit.prevent="saveCloud">
      <header class="card-header">
        <div class="card-icon"><Icon name="cloud" :size="20" /></div>
        <div>
          <h4>加密云备份</h4>
          <p>支持 Cloudflare R2、Backblaze B2、Wasabi、MinIO 等 S3 兼容存储；上传前由 Restic 本地加密。</p>
        </div>
      </header>

      <div class="status-row" aria-label="云备份状态">
        <span :class="{ 'is-ok': cloud.verified }">存储 {{ statusLabel(cloud.verified) }}</span>
        <span :class="{ 'is-ok': cloud.resticPasswordConfigured }">Restic 密钥 {{ cloud.resticPasswordConfigured ? '已生成' : '待生成' }}</span>
        <span :class="{ 'is-ok': cloud.hostAgentInstalled }">主机任务 {{ cloud.hostAgentInstalled ? (cloud.timerEnabled ? '运行中' : '待启用') : '未安装' }}</span>
      </div>

      <fieldset>
        <legend>对象存储</legend>
        <div class="field-grid">
          <label><span>显示名称</span><input v-model.trim="cloud.providerLabel" type="text" autocomplete="off" placeholder="Cloudflare R2"></label>
          <label><span>Endpoint</span><input v-model.trim="cloud.endpoint" type="url" inputmode="url" autocomplete="off" placeholder="https://account.r2.cloudflarestorage.com"></label>
          <label><span>Bucket</span><input v-model.trim="cloud.bucket" type="text" autocomplete="off"></label>
          <label><span>Region</span><input v-model.trim="cloud.region" type="text" autocomplete="off" placeholder="auto"></label>
          <label><span>备份前缀</span><input v-model.trim="cloud.prefix" type="text" autocomplete="off" placeholder="nav"></label>
          <label><span>寻址方式</span><select v-model="cloud.addressingStyle"><option value="path">Path-style（推荐）</option><option value="virtual">Virtual-hosted</option></select></label>
          <label><span>Access Key ID</span><input v-model="cloud.accessKeyId" type="password" autocomplete="new-password" :placeholder="cloud.accessKeyConfigured ? '已安全保存，留空保持不变' : '输入 Access Key ID'"></label>
          <label><span>Secret Access Key</span><input v-model="cloud.secretAccessKey" type="password" autocomplete="new-password" :placeholder="cloud.secretKeyConfigured ? '已安全保存，留空保持不变' : '输入 Secret Access Key'"></label>
          <label><span>Session Token（可选）</span><input v-model="cloud.sessionToken" type="password" autocomplete="new-password" :placeholder="cloud.sessionTokenConfigured ? '已保存，留空保持不变' : '仅临时凭据需要'"></label>
        </div>
        <div class="action-row">
          <span>{{ cloudHasUnsavedChanges ? '请先保存对象存储修改，再进行只读测试。' : `最近验证：${formatDate(cloud.verifiedAt)}` }}</span>
          <button class="button button--secondary" type="button" :disabled="!writable || !cloudReadyToTest || busyAction" @click="testCloud">
            {{ busyAction === 'test-cloud' ? '测试中' : '只读测试存储' }}
          </button>
        </div>
      </fieldset>

      <label class="enable-card" :class="{ 'is-disabled': !cloud.verified }">
        <input v-model="cloud.enabled" type="checkbox" :disabled="!cloud.verified">
        <span><strong>允许主机任务上传加密备份</strong><small>只有存储验证通过且 OVH 已安装并启用备份 timer 后，才会真正定时上传。</small></span>
      </label>

      <footer class="card-footer">
        <p>页面只配置凭据和上传许可，不会从 Web 进程直接执行 root 备份或恢复。</p>
        <button class="button button--primary" type="button" :disabled="!writable || busyAction" @click="saveCloud">
          <Icon name="check" :size="16" />
          {{ busyAction === 'save-cloud' ? '保存中' : '保存云备份配置' }}
        </button>
      </footer>
    </form>

    <div
      v-if="busyAction || message || error"
      class="integration-toast"
      :class="{ 'is-error': Boolean(error), 'is-busy': Boolean(busyAction) }"
      aria-hidden="true"
    >
      <Icon :name="error ? 'alert' : busyAction ? 'refresh' : 'check'" :size="17" />
      <span>{{ busyAction ? busyActionLabel : error || message }}</span>
    </div>
  </section>
</template>

<style scoped>
.integration-page { display: grid; gap: 20px; }
.integration-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
.integration-heading h3 { margin: 0; color: var(--text-primary); font-size: 1.06rem; }
.integration-heading p { margin: 7px 0 0; color: var(--text-muted); font-size: .8rem; line-height: 1.65; }
.integration-card { display: grid; gap: 20px; padding: clamp(18px, 3vw, 26px); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: var(--radius-lg); box-shadow: var(--shadow-card); }
.card-header { display: grid; grid-template-columns: 46px minmax(0, 1fr); gap: 13px; align-items: center; }
.card-icon { display: grid; width: 46px; height: 46px; place-items: center; color: var(--accent-color); background: color-mix(in srgb, var(--accent-color) 12%, var(--bg-secondary)); border: 1px solid color-mix(in srgb, var(--accent-color) 28%, var(--border-light)); border-radius: 15px; }
.card-header h4 { margin: 0; color: var(--text-primary); font-size: 1rem; }
.card-header p { margin: 5px 0 0; color: var(--text-muted); font-size: .75rem; line-height: 1.55; }
.status-row { display: flex; flex-wrap: wrap; gap: 8px; }
.status-row span { padding: 7px 10px; color: var(--text-muted); font-size: .7rem; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 999px; }
.status-row span.is-ok { color: var(--success-color, #4f8a5b); border-color: color-mix(in srgb, var(--success-color, #4f8a5b) 38%, var(--border-light)); }
fieldset { min-width: 0; margin: 0; padding: 18px; border: 1px solid var(--border-light); border-radius: 17px; }
legend { padding: 0 8px; color: var(--text-primary); font-size: .82rem; font-weight: 700; }
.field-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.field-grid label, .field-wide { display: grid; gap: 7px; min-width: 0; color: var(--text-secondary); font-size: .72rem; }
.field-wide { margin-top: 14px; }
input, select { width: 100%; min-height: 44px; padding: 10px 12px; color: var(--text-primary); font: inherit; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 13px; box-sizing: border-box; }
input:focus-visible, select:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent-color) 28%, transparent); outline-offset: 1px; border-color: var(--accent-color); }
input[aria-invalid="true"] { border-color: var(--danger-color, #b45151); }
input:disabled { opacity: .62; }
.field-tip { margin: 10px 0 0; color: var(--text-muted); font-size: .69rem; }
.field-help, .field-error { font-size: .66rem; line-height: 1.5; }
.field-help { color: var(--text-muted); }
.field-error { color: var(--danger-color, #b45151); font-weight: 650; }
.check-row { display: flex; min-height: 44px; margin-top: 10px; align-items: center; gap: 9px; color: var(--text-secondary); font-size: .75rem; }
.check-row input, .toggle-grid input, .enable-card input { width: 18px; min-height: 18px; flex: 0 0 auto; accent-color: var(--accent-color); }
.toggle-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.toggle-grid label { display: flex; min-height: 44px; padding: 10px 12px; align-items: center; gap: 9px; color: var(--text-secondary); font-size: .75rem; background: var(--bg-secondary); border-radius: 13px; }
.action-row, .card-footer { display: flex; margin-top: 14px; align-items: center; justify-content: space-between; gap: 14px; }
.action-row span, .card-footer p { margin: 0; color: var(--text-muted); font-size: .69rem; line-height: 1.55; }
.card-footer { margin-top: 0; padding-top: 16px; border-top: 1px solid var(--border-light); }
.button { display: inline-flex; min-height: 44px; padding: 0 14px; align-items: center; justify-content: center; gap: 7px; color: var(--text-primary); font: inherit; font-size: .75rem; font-weight: 650; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 13px; cursor: pointer; }
.button--primary { color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: var(--accent-color); }
.button:disabled { opacity: .55; cursor: not-allowed; }
.notice { margin: 0; padding: 12px 14px; color: var(--text-secondary); font-size: .76rem; line-height: 1.6; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; }
.notice--warning { color: var(--warning-color, #9a6b28); }
.notice--success { color: var(--success-color, #4f8a5b); }
.notice--error { color: var(--danger-color, #b45151); }
.integration-toast { position: fixed; right: 18px; bottom: 18px; z-index: 720; display: flex; width: min(440px, calc(100vw - 36px)); min-height: 48px; padding: 11px 14px; align-items: center; gap: 9px; color: var(--success-color, #4f8a5b); background: color-mix(in srgb, var(--bg-card) 96%, transparent); border: 1px solid var(--border-color); border-radius: 14px; box-shadow: var(--shadow-lg); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); box-sizing: border-box; }
.integration-toast.is-error { color: var(--danger-color, #b45151); }
.integration-toast.is-busy { color: var(--info-color, var(--accent-color)); }
.integration-toast.is-busy svg { animation: integration-spin .85s linear infinite; }
@keyframes integration-spin { to { transform: rotate(360deg); } }
.enable-card { display: flex; min-height: 64px; padding: 13px 15px; align-items: center; gap: 12px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 15px; }
.enable-card > span { display: grid; gap: 4px; }
.enable-card strong { color: var(--text-primary); font-size: .78rem; }
.enable-card small { color: var(--text-muted); font-size: .68rem; line-height: 1.5; }
.enable-card.is-disabled { opacity: .7; }
@media (max-width: 680px) {
  .integration-heading, .action-row, .card-footer { align-items: stretch; flex-direction: column; }
  .field-grid, .toggle-grid { grid-template-columns: 1fr; }
  .button { width: 100%; }
  .integration-toast { right: max(12px, env(safe-area-inset-right)); bottom: calc(86px + env(safe-area-inset-bottom)); left: max(12px, env(safe-area-inset-left)); width: auto; }
}
</style>
