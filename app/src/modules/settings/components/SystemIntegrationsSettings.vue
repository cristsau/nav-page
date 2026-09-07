<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import OauthIntegrationSettings from './OauthIntegrationSettings.vue'
import SystemNotificationSettings from './SystemNotificationSettings.vue'
import { fetchManagedIntegrations, saveManagedCloudBackup, testManagedCloudBackup } from '@/shared/services/integrationApi'

const loading = ref(true)
const busyAction = ref('')
const message = ref('')
const warning = ref('')
const error = ref('')
const writable = ref(false)
const systemMail = ref({})
const updatedAt = ref(null)
const savedCloudFingerprint = ref('')
const errorNotice = ref(null)
const busyActionLabel = computed(() => busyAction.value ? '正在处理…' : '')
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

const cloudHasUnsavedChanges = computed(() => cloudFingerprint() !== savedCloudFingerprint.value)
const cloudReadyToTest = computed(() => Boolean(
  cloud.endpoint && cloud.bucket && cloud.accessKeyConfigured && cloud.secretKeyConfigured
  && !cloudHasUnsavedChanges.value
))

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
  systemMail.value = state.systemMail || {}
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
  savedCloudFingerprint.value = cloudFingerprint()
}

async function refresh() {
  loading.value = true
  warning.value = ''
  error.value = ''
  try {
    applyState(await fetchManagedIntegrations())
  } catch (caught) {
    error.value = caught.message || '无法读取集成配置。'
  } finally {
    loading.value = false
  }
}

async function run(action, successText, callback) {
  busyAction.value = action
  message.value = ''
  warning.value = ''
  error.value = ''
  try {
    const result = await callback()
    if (result?.warning) warning.value = String(result.warning)
    else message.value = successText
    return result
  } catch (caught) {
    warning.value = ''
    error.value = caught.message || '操作失败，请稍后重试。'
    await nextTick()
    errorNotice.value?.focus({ preventScroll: true })
    errorNotice.value?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return null
  } finally {
    busyAction.value = ''
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
        <p>配置账号登录、系统通知和加密云备份。</p>
      </div>
      <button class="button button--secondary" type="button" :disabled="loading || busyAction" @click="refresh">
        <Icon name="refresh" :size="16" />
        {{ loading ? '读取中' : '刷新状态' }}
      </button>
    </div>

    <div v-if="!writable && !loading" id="integration-write-warning" class="notice notice--warning" role="alert">
      服务器尚未挂载可管理集成目录。当前页面为只读；发布时配置 NAV_MANAGED_INTEGRATIONS_DIR 后即可自助保存。
    </div>
    <p v-if="message" class="notice notice--success" role="status">{{ message }}</p>
    <p v-if="warning" class="notice notice--warning" role="status" aria-live="polite">{{ warning }}</p>
    <p v-if="error" ref="errorNotice" class="notice notice--error" role="alert" tabindex="-1">{{ error }}</p>

    <OauthIntegrationSettings />

    <SystemNotificationSettings :state="systemMail" :writable="writable" @saved="refresh" />

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
      v-if="busyAction || message || warning || error"
      class="integration-toast"
      :class="{ 'is-error': Boolean(error), 'is-warning': Boolean(warning), 'is-busy': Boolean(busyAction) }"
      :role="error ? 'alert' : 'status'"
      aria-live="polite"
    >
      <Icon :name="error || warning ? 'alert' : busyAction ? 'refresh' : 'check'" :size="17" />
      <span>{{ busyAction ? busyActionLabel : error || warning || message }}</span>
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
.mail-account-manager { display: grid; padding: 14px; align-items: end; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 15px; }
.mail-account-manager > div { display: grid; min-width: 0; gap: 7px; }
.mail-account-manager label { color: var(--text-secondary); font-size: .72rem; font-weight: 680; }
.mail-account-manager p { margin: 0; grid-column: 1 / -1; color: var(--text-muted); font-size: .68rem; line-height: 1.55; }
.mail-account-label { margin-top: 0; }
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
.button { display: inline-flex; min-height: 44px; padding: 0 14px; align-items: center; justify-content: center; gap: 7px; color: var(--text-primary); font: inherit; font-size: .75rem; font-weight: 650; background: var(--bg-secondary); border: 1px solid var(--border-color); border-radius: 13px; cursor: pointer; touch-action: manipulation; }
.button--primary { color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: var(--accent-color); }
.button--secondary.is-ready { color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: var(--accent-color); }
.button:disabled { opacity: .55; cursor: not-allowed; }
.notice { margin: 0; padding: 12px 14px; color: var(--text-secondary); font-size: .76rem; line-height: 1.6; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; }
.notice--warning { color: var(--warning-color, #9a6b28); }
.notice--success { color: var(--success-color, #4f8a5b); }
.notice--error { color: var(--danger-color, #b45151); }
.integration-toast { position: fixed; right: 18px; bottom: 18px; z-index: 720; display: flex; width: min(440px, calc(100vw - 36px)); min-height: 48px; padding: 11px 14px; align-items: center; gap: 9px; color: var(--success-color, #4f8a5b); background: color-mix(in srgb, var(--bg-card) 96%, transparent); border: 1px solid var(--border-color); border-radius: 14px; box-shadow: var(--shadow-lg); -webkit-backdrop-filter: blur(18px); backdrop-filter: blur(18px); box-sizing: border-box; }
.integration-toast.is-error { color: var(--danger-color, #b45151); }
.integration-toast.is-warning { color: var(--warning-color, #9a6b28); }
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
  .mail-account-manager { grid-template-columns: 1fr; }
  .mail-account-manager p { grid-column: auto; }
  .button { width: 100%; }
  .integration-toast { right: max(12px, env(safe-area-inset-right)); bottom: calc(86px + env(safe-area-inset-bottom)); left: max(12px, env(safe-area-inset-left)); width: auto; }
}
</style>
