<script setup>
import { computed, nextTick, onMounted, ref, shallowRef } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import Modal from '@/shared/components/Modal.vue'
import ProductivityPortability from './ProductivityPortability.vue'
import { clearAllData, exportData, getLocalDataSummary, importData } from '@/shared/db/database'
import { useConfig } from '@/shared/composables/useConfig'
import {
  applyBackendRestore,
  createCloudRestoreBackup,
  createLocalRestoreBackup,
  DATA_RESTORE_MAX_FILE_BYTES,
  DATA_RESTORE_MAX_STREAM_FILE_BYTES,
  exportBackendDataStream,
  exportBackendRestoreSafetyBackup,
  previewBackendRestore,
  shouldUseBackendMigration,
  uploadBackendRestoreStream
} from '@/shared/services/migrationApi'

const { resetConfig } = useConfig()

const importing = ref(false)
const exporting = ref(false)
const cloudExporting = ref(false)
const migrating = ref(false)
const restoreFileInput = ref(null)
const restorePreviewFocus = ref(null)
const restorePasswordInput = ref(null)
const restoreSuccessFocus = ref(null)
const restoreModalOpen = ref(false)
const restoreStage = ref('preview')
const restoreBackup = shallowRef(null)
const restorePreview = ref(null)
const restoreResult = ref(null)
const restoreFileName = ref('')
const restoreSource = ref('cloud-backup')
const restoreShares = ref(false)
const restorePreviewing = ref(false)
const restoreApplying = ref(false)
const restoreSafetyBackupDownloading = ref(false)
const restoreSafetyBackupDownloaded = ref(false)
const restoreSafetyBackupReceipt = ref('')
const restorePassword = ref('')
const restoreConfirmation = ref('')
const restoreError = ref('')
const restorePageMessage = ref('')
const restorePageMessageKind = ref('error')
let restorePreviewSequence = 0
const storageInfo = ref({
  used: 0,
  quota: 0
})
const localDataSummary = ref({
  groups: 0,
  bookmarks: 0,
  notes: 0,
  customEngines: 0,
  shares: 0,
  settings: 0,
  total: 0
})

const shouldShowCloudMigration = computed(() =>
  shouldUseBackendMigration() && localDataSummary.value.total > 0
)
const shouldShowCloudExport = computed(() => shouldUseBackendMigration())
const restoreIsCloudBackup = computed(() => restoreSource.value === 'cloud-backup')
const restoreIsStream = computed(() => Boolean(restoreBackup.value?.uploadId))
const restoreModalTitle = computed(() => {
  if (restoreStage.value === 'success') {
    return restoreIsCloudBackup.value ? '云端数据已恢复' : '本地数据已迁移'
  }
  if (restoreStage.value === 'confirm') return '确认替换云端数据'
  return restoreIsCloudBackup.value ? '预览云端数据恢复' : '预览本地数据迁移'
})

const RESTORE_COLLECTIONS = Object.freeze([
  { key: 'groups', label: '分组' },
  { key: 'bookmarks', label: '书签' },
  { key: 'notes', label: '笔记与日记' },
  { key: 'customEngines', label: '搜索引擎' },
  { key: 'shares', label: '公开分享' },
  { key: 'settings', label: '普通设置' }
])

function boundedCount(value) {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

function previewCount(container, key) {
  return boundedCount(container?.[key])
}

const restoreComparisonRows = computed(() => {
  const preview = restorePreview.value || {}
  return RESTORE_COLLECTIONS.map((collection) => {
    const current = previewCount(preview.current, collection.key)
    const incoming = previewCount(preview.incoming, collection.key)
    const backup = previewCount(preview.backupCounts, collection.key)
    return {
      ...collection,
      current,
      incoming,
      backup,
      difference: incoming - current
    }
  })
})

function normalizeRestoreMessages(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => (
      typeof item === 'string'
        ? item.trim()
        : String(item?.message || item?.error || item?.code || '').trim()
    ))
    .filter(Boolean)
}

const restoreWarnings = computed(() => normalizeRestoreMessages(restorePreview.value?.warnings))
const restoreBlockingErrors = computed(() => (
  normalizeRestoreMessages(restorePreview.value?.blockingErrors)
))
const restoreCanContinue = computed(() => (
  Boolean(restorePreview.value?.planToken)
  && !restorePreviewing.value
  && !restoreBlockingErrors.value.length
  && restoreSafetyBackupDownloaded.value
  && Boolean(restoreSafetyBackupReceipt.value)
))
const restoreCanApply = computed(() => (
  restoreCanContinue.value
  && Boolean(restorePassword.value)
  && restoreConfirmation.value === '恢复'
  && !restoreApplying.value
))
const restoreBackupShareCount = computed(() => (
  previewCount(restorePreview.value?.backupCounts, 'shares')
))
const restoreResultRows = computed(() => RESTORE_COLLECTIONS.map((collection) => ({
  ...collection,
  count: previewCount(restoreResult.value?.imported, collection.key)
})))

async function refreshLocalDataSummary() {
  localDataSummary.value = await getLocalDataSummary()
}

async function refreshStorageInfo() {
  if (!navigator.storage?.estimate) return

  const estimate = await navigator.storage.estimate()
  storageInfo.value = {
    used: estimate.usage || 0,
    quota: estimate.quota || 0
  }
}

async function refreshLocalState() {
  await Promise.all([
    refreshLocalDataSummary(),
    refreshStorageInfo()
  ])
}

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data)], {
    type: 'application/json'
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function setRestorePageMessage(message = '', kind = 'error') {
  restorePageMessage.value = String(message || '')
  restorePageMessageKind.value = kind === 'success' ? 'success' : 'error'
}

async function focusRestoreStage(stage = restoreStage.value) {
  await nextTick()
  if (stage === 'confirm') {
    restorePasswordInput.value?.focus()
    return
  }
  if (stage === 'success') {
    restoreSuccessFocus.value?.focus()
    return
  }
  restorePreviewFocus.value?.focus()
}

function ensureRestoreSize(bytes) {
  if (boundedCount(bytes) > DATA_RESTORE_MAX_FILE_BYTES) {
    throw new Error(`备份文件不能超过 ${formatSize(DATA_RESTORE_MAX_FILE_BYTES)}`)
  }
}

function restorePreviewIsStale(error) {
  const code = String(error?.code || '').toLowerCase()
  const message = String(error?.message || '').trim()
  return (
    code.includes('preview')
    || code.includes('state')
    || code.includes('backup_receipt')
    || /恢复预览.*过期|云端数据.*变化|preview.*expired|state.*changed/i.test(message)
  )
}

function restoreErrorText(error) {
  const code = String(error?.code || '').toLowerCase()
  const message = String(error?.message || '').trim()
  if (code.includes('password') || /当前密码不正确|current password.*incorrect/i.test(message)) {
    return '当前登录密码不正确。'
  }
  if (restorePreviewIsStale(error)) {
    return '恢复预览已过期，或云端数据已发生变化。请重新预览后再确认。'
  }
  return message || '恢复请求失败'
}

function resetRestoreFlow({ keepPageMessage = false } = {}) {
  restorePreviewSequence += 1
  restoreModalOpen.value = false
  restoreStage.value = 'preview'
  restoreBackup.value = null
  restorePreview.value = null
  restoreResult.value = null
  restoreFileName.value = ''
  restoreSource.value = 'cloud-backup'
  restoreShares.value = false
  restorePreviewing.value = false
  restoreApplying.value = false
  restoreSafetyBackupDownloading.value = false
  restoreSafetyBackupDownloaded.value = false
  restoreSafetyBackupReceipt.value = ''
  restorePassword.value = ''
  restoreConfirmation.value = ''
  restoreError.value = ''
  if (!keepPageMessage) setRestorePageMessage('')
  if (restoreFileInput.value) restoreFileInput.value.value = ''
}

function closeRestoreModal() {
  if (restoreApplying.value) return
  if (restoreStage.value === 'success') {
    finishRestore()
    return
  }
  resetRestoreFlow()
}

function finishRestore() {
  const message = restoreIsCloudBackup.value
    ? '云端备份恢复完成，页面将刷新。'
    : '本地数据迁移完成，页面将刷新。'
  setRestorePageMessage(message, 'success')
  resetRestoreFlow({ keepPageMessage: true })
  window.location.reload()
}

async function refreshRestorePreview() {
  if (!restoreBackup.value || restoreApplying.value) return

  const requestSequence = ++restorePreviewSequence
  restorePreviewing.value = true
  restorePreview.value = null
  restoreSafetyBackupDownloaded.value = false
  restoreSafetyBackupReceipt.value = ''
  restoreError.value = ''
  restorePassword.value = ''
  restoreConfirmation.value = ''

  try {
    const payload = await previewBackendRestore(restoreBackup.value, {
      restoreShares: restoreShares.value
    })
    if (requestSequence !== restorePreviewSequence) return

    const preview = payload?.preview
    if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
      throw new Error('服务器返回的恢复预览无效')
    }
    const blockingErrors = normalizeRestoreMessages(preview.blockingErrors)
    if (!blockingErrors.length && !String(preview.planToken || '').trim()) {
      throw new Error('恢复预览缺少安全计划令牌')
    }
    restorePreview.value = preview
  } catch (error) {
    if (requestSequence !== restorePreviewSequence) return
    restoreError.value = restoreErrorText(error)
  } finally {
    if (requestSequence === restorePreviewSequence) {
      restorePreviewing.value = false
      await focusRestoreStage('preview')
    }
  }
}

async function openRestoreFlow(backup, {
  fileName,
  source,
  restorePublicShares = false
}) {
  resetRestoreFlow()
  restoreBackup.value = backup
  restoreFileName.value = String(fileName || '')
  restoreSource.value = source
  restoreShares.value = restorePublicShares
  restoreModalOpen.value = true
  await nextTick()
  await refreshRestorePreview()
}

async function handleCloudRestoreFile(event) {
  const input = event.target
  const file = input.files?.[0]
  if (!file) return

  setRestorePageMessage('')
  try {
    const isStream = /\.ndjson$/i.test(file.name)
      || file.type === 'application/x-domo-nav-backup-ndjson'
    let backup
    if (isStream) {
      if (boundedCount(file.size) > DATA_RESTORE_MAX_STREAM_FILE_BYTES) {
        throw new Error(
          `流式备份不能超过 ${formatSize(DATA_RESTORE_MAX_STREAM_FILE_BYTES)}`
        )
      }
      const uploaded = await uploadBackendRestoreStream(file)
      if (!uploaded?.uploadId) throw new Error('服务器未返回流式恢复任务')
      backup = {
        uploadId: uploaded.uploadId,
        exportedAt: uploaded.exportedAt || null,
        streamed: true,
        counts: uploaded.counts || {},
        payloadBytes: boundedCount(uploaded.payloadBytes)
      }
    } else {
      ensureRestoreSize(file.size)
      const text = await file.text()
      backup = createCloudRestoreBackup(JSON.parse(text))
    }
    await openRestoreFlow(backup, {
      fileName: file.name,
      source: 'cloud-backup',
      restorePublicShares: false
    })
  } catch (error) {
    setRestorePageMessage(`无法读取云端备份：${restoreErrorText(error)}`)
  } finally {
    input.value = ''
  }
}

async function handleRestoreSharesChange() {
  restoreStage.value = 'preview'
  await refreshRestorePreview()
}

async function downloadRestoreSafetyBackup() {
  if (!restorePreview.value || restoreSafetyBackupDownloading.value) return

  const previewSequence = restorePreviewSequence
  restoreSafetyBackupDownloading.value = true
  restoreSafetyBackupDownloaded.value = false
  restoreError.value = ''
  try {
    const payload = await exportBackendRestoreSafetyBackup()
    const backup = payload?.backup
    const backupReceipt = String(payload?.backupReceipt || '').trim()
    if (
      backup?.schema !== 'domo-nav-backup'
      || Number(backup?.version) !== 1
      || !backup?.manifest
      || !backup?.data
      || !backupReceipt
    ) {
      throw new Error('服务器返回的当前云端备份格式无效')
    }
    if (previewSequence !== restorePreviewSequence || !restoreModalOpen.value) return
    const fallbackFileName = (
      `domo-nav-before-restore-${new Date().toISOString().slice(0, 10)}.json`
    )
    downloadJson(backup, backup.fileName || fallbackFileName)
    restoreSafetyBackupReceipt.value = backupReceipt
    restoreSafetyBackupDownloaded.value = true
  } catch (error) {
    if (previewSequence === restorePreviewSequence && restoreModalOpen.value) {
      restoreError.value = `当前云端备份下载失败：${restoreErrorText(error)}`
    }
  } finally {
    if (previewSequence === restorePreviewSequence) {
      restoreSafetyBackupDownloading.value = false
    }
  }
}

async function continueRestoreConfirmation() {
  if (!restoreCanContinue.value) return
  restoreStage.value = 'confirm'
  restoreError.value = ''
  restorePassword.value = ''
  restoreConfirmation.value = ''
  await focusRestoreStage('confirm')
}

async function returnToRestorePreview() {
  if (restoreApplying.value) return
  restoreStage.value = 'preview'
  restorePassword.value = ''
  restoreConfirmation.value = ''
  restoreError.value = ''
  await focusRestoreStage('preview')
}

async function applyRestore() {
  if (!restoreCanApply.value) return

  restoreApplying.value = true
  restoreError.value = ''
  try {
    const payload = await applyBackendRestore(restoreBackup.value, {
      restoreShares: restoreShares.value,
      planToken: restorePreview.value.planToken,
      backupReceipt: restoreSafetyBackupReceipt.value,
      currentPassword: restorePassword.value,
      confirmation: restoreConfirmation.value
    })
    restoreResult.value = payload
    restorePassword.value = ''
    restoreConfirmation.value = ''
    restoreStage.value = 'success'
    await focusRestoreStage('success')
  } catch (error) {
    const needsNewPreview = restorePreviewIsStale(error)
    restorePassword.value = ''
    restoreConfirmation.value = ''
    if (needsNewPreview) {
      restoreStage.value = 'preview'
      restoreApplying.value = false
      await refreshRestorePreview()
      restoreError.value = restoreErrorText(error)
    } else {
      restoreError.value = restoreErrorText(error)
      await focusRestoreStage('confirm')
    }
  } finally {
    restoreApplying.value = false
  }
}

function formatRestoreDifference(value) {
  const difference = Number(value || 0)
  if (difference > 0) return `+${difference}`
  return String(difference)
}

function formatRestoreExpiry(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

function formatRestoreTimestamp(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

async function handleExport() {
  if (exporting.value) return

  exporting.value = true
  try {
    const data = await exportData()
    downloadJson(data, `nav-backup-${new Date().toISOString().slice(0, 10)}.json`)
    alert('导出成功。')
  } catch (error) {
    alert(`导出失败：${error.message}`)
  } finally {
    exporting.value = false
  }
}

async function handleCloudExport() {
  if (!shouldShowCloudExport.value || cloudExporting.value) return

  if (!confirm(
    '导出文件包含笔记密文和仍然有效的公开分享链接。\n\n'
    + '它不包含 API Key、Telegram Token、加密笔记密码校验值或图床图片二进制。'
    + '请把文件视为敏感数据并妥善保存。是否继续？'
  )) {
    return
  }

  cloudExporting.value = true
  try {
    const result = await exportBackendDataStream()
    const fallbackFileName = (
      `domo-nav-cloud-backup-${new Date().toISOString().slice(0, 10)}.ndjson`
    )
    downloadBlob(result.blob, result.filename || fallbackFileName)
    alert('NAV 云端流式备份已完整导出，可直接用于超过 5,000 条记录的恢复。')
  } catch (error) {
    alert(`云端备份导出失败：${error.message}`)
  } finally {
    cloudExporting.value = false
  }
}

async function handleImport(event) {
  const file = event.target.files?.[0]
  if (!file) return

  importing.value = true
  try {
    ensureRestoreSize(file.size)
    const text = await file.text()
    const data = JSON.parse(text)

    if (!data.version || !data.data) {
      throw new Error('无效的备份文件')
    }

    await importData(data.data)
    await refreshLocalState()
    alert('导入成功，页面将刷新。')
    window.location.reload()
  } catch (error) {
    alert(`导入失败：${error.message}`)
  } finally {
    importing.value = false
    event.target.value = ''
  }
}

async function handleMigrateToCloud() {
  if (!shouldShowCloudMigration.value || migrating.value) return

  migrating.value = true
  setRestorePageMessage('')
  try {
    const backup = createLocalRestoreBackup(await exportData())
    ensureRestoreSize(new Blob([JSON.stringify(backup)]).size)
    await openRestoreFlow(backup, {
      fileName: '当前浏览器 IndexedDB',
      source: 'local-browser',
      restorePublicShares: false
    })
  } catch (error) {
    setRestorePageMessage(`无法预览本地数据迁移：${restoreErrorText(error)}`)
  } finally {
    migrating.value = false
  }
}

async function handleClearData() {
  if (!confirm('确定要清除当前浏览器里的所有本地数据吗？\n\n这不会删除云端数据库里的数据，但会移除本机缓存。')) {
    return
  }

  try {
    await clearAllData()
    await refreshLocalState()
    alert('本地数据已清除，页面将刷新。')
    window.location.reload()
  } catch (error) {
    alert(`清除失败：${error.message}`)
  }
}

async function handleResetConfig() {
  if (!confirm('确定要恢复默认设置吗？这不会删除书签和便签数据。')) {
    return
  }

  await resetConfig()
  await refreshLocalState()
  alert('设置已重置。')
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

onMounted(refreshLocalState)
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section__title">数据管理</h3>
    <ProductivityPortability />

    <p
      v-if="restorePageMessage"
      :class="[
        'restore-page-message',
        `restore-page-message--${restorePageMessageKind}`
      ]"
      :role="restorePageMessageKind === 'success' ? 'status' : 'alert'"
      :aria-live="restorePageMessageKind === 'success' ? 'polite' : 'assertive'"
    >
      <Icon
        :name="restorePageMessageKind === 'success' ? 'circle-check' : 'alert'"
        :size="18"
        aria-hidden="true"
      />
      <span>{{ restorePageMessage }}</span>
    </p>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">本地存储使用</div>
        <div class="settings-item__desc">当前浏览器 IndexedDB 的占用情况</div>
      </div>
      <div class="settings-item__control">
        <div class="storage-info">
          <div class="storage-bar">
            <div
              class="storage-bar__used"
              :style="{ width: storageInfo.quota ? `${(storageInfo.used / storageInfo.quota) * 100}%` : '0%' }"
            />
          </div>
          <div class="storage-text">
            {{ formatSize(storageInfo.used) }} / {{ formatSize(storageInfo.quota) }}
          </div>
        </div>
      </div>
    </div>

    <div v-if="shouldShowCloudExport" class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">导出 NAV 云端数据</div>
        <div class="settings-item__desc">
          下载当前账号在 PostgreSQL 中的分组、书签、笔记、分享、搜索引擎和普通设置。
          加密笔记只保留密文，不导出快速密码校验值；API Key、Telegram Token 等密钥不会写入文件。
          图片只导出图床 URL 与文件元数据，不包含图片二进制、外层反代配置或服务器 Secret。
          公开分享码仍可直接访问，请把导出文件视为敏感数据。
        </div>
      </div>
      <div class="settings-item__control">
        <button class="btn btn--secondary" :disabled="cloudExporting" @click="handleCloudExport">
          {{ cloudExporting ? '导出中...' : '下载 NAV 数据' }}
        </button>
      </div>
    </div>

    <div v-if="shouldShowCloudExport" class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">从完整备份恢复云端数据</div>
        <div class="settings-item__desc">
          先预览当前数据与备份差异，再用当前登录密码和确认文字执行恢复。
          恢复采用替换模式，不会合并；公开分享默认不恢复。
          JSON 最大 16 MB，NDJSON 流式备份最大 128 MB。
        </div>
      </div>
      <div class="settings-item__control">
        <input
          id="cloud-restore-file"
          ref="restoreFileInput"
          type="file"
          accept=".json,.ndjson,application/json,application/x-domo-nav-backup-ndjson"
          hidden
          :disabled="restorePreviewing || restoreApplying || restoreSafetyBackupDownloading"
          @change="handleCloudRestoreFile"
        >
        <button
          type="button"
          class="btn btn--secondary"
          :disabled="restorePreviewing || restoreApplying || restoreSafetyBackupDownloading"
          aria-describedby="cloud-restore-description"
          @click="restoreFileInput?.click()"
        >
          <Icon name="upload" :size="18" aria-hidden="true" />
          选择完整备份
        </button>
        <span id="cloud-restore-description" class="visually-hidden">
          选择 DOMO NAV 云端 JSON 备份（最大 16 MB）或 NDJSON 流式备份（最大 128 MB）
        </span>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">本地旧数据检测</div>
        <div class="settings-item__desc">
          当前浏览器里检测到 {{ localDataSummary.total }} 条本地记录。
          只有存在旧 IndexedDB 数据时，才显示“迁移到云端”入口。
        </div>
      </div>
      <div class="settings-item__control">
        <button class="btn btn--secondary" @click="refreshLocalState">
          重新检测
        </button>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">导出本地备份</div>
        <div class="settings-item__desc">把当前浏览器的所有本地数据导出为 JSON 文件</div>
      </div>
      <div class="settings-item__control">
        <button class="btn btn--secondary" :disabled="exporting" @click="handleExport">
          {{ exporting ? '导出中...' : '导出备份' }}
        </button>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">导入本地备份</div>
        <div class="settings-item__desc">从 JSON 备份文件恢复本地数据</div>
      </div>
      <div class="settings-item__control">
        <label class="btn btn--secondary">
          {{ importing ? '导入中...' : '导入备份' }}
          <input
            type="file"
            accept=".json"
            hidden
            :disabled="importing"
            @change="handleImport"
          >
        </label>
      </div>
    </div>

    <div v-if="shouldShowCloudMigration" class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">迁移本地数据到云端</div>
        <div class="settings-item__desc">
          先预览当前浏览器 IndexedDB 与云端数据差异，确认后替换云端数据。
          本地 IndexedDB 会保留，不会在迁移后清除。
        </div>
      </div>
      <div class="settings-item__control">
        <button class="btn btn--secondary" :disabled="migrating" @click="handleMigrateToCloud">
          <Icon name="database" :size="18" aria-hidden="true" />
          {{ migrating ? '准备预览中...' : '预览并迁移' }}
        </button>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">重置设置</div>
        <div class="settings-item__desc">恢复默认界面设置，不删除书签和便签</div>
      </div>
      <div class="settings-item__control">
        <button class="btn btn--secondary" @click="handleResetConfig">
          重置设置
        </button>
      </div>
    </div>

    <div class="settings-item settings-item--danger">
      <div class="settings-item__info">
        <div class="settings-item__label">清除本地数据</div>
        <div class="settings-item__desc">删除当前浏览器里的本地缓存，不影响云端数据库</div>
      </div>
      <div class="settings-item__control">
        <button class="btn btn--danger" @click="handleClearData">
          清除本地数据
        </button>
      </div>
    </div>

    <Modal
      :show="restoreModalOpen"
      :title="restoreModalTitle"
      width="760px"
      initial-focus-selector="[data-modal-initial-focus]"
      :close-disabled="restoreApplying"
      @close="closeRestoreModal"
    >
      <div
        class="restore-dialog"
        :aria-busy="restorePreviewing || restoreApplying"
      >
        <template v-if="restoreStage === 'preview'">
          <div
            ref="restorePreviewFocus"
            class="restore-source-card"
            data-modal-initial-focus
            tabindex="-1"
          >
            <Icon name="database" :size="22" aria-hidden="true" />
            <div>
              <strong>{{ restoreFileName || '待恢复数据' }}</strong>
              <p>
                {{ restoreIsCloudBackup ? '完整云端备份' : '当前浏览器 IndexedDB' }}
                · 替换模式 · {{ restoreIsStream ? '流式暂存 128 MB' : 'JSON 16 MB' }}
                <template v-if="formatRestoreTimestamp(restoreBackup?.exportedAt)">
                  · 备份于 {{ formatRestoreTimestamp(restoreBackup.exportedAt) }}
                </template>
              </p>
            </div>
          </div>

          <div v-if="restorePreviewing" class="restore-loading" role="status" aria-live="polite">
            <Icon name="refresh" :size="20" aria-hidden="true" />
            正在生成只读差异预览…
          </div>

          <p v-if="restoreError" class="restore-feedback restore-feedback--error" role="alert">
            <Icon name="alert" :size="18" aria-hidden="true" />
            <span>{{ restoreError }}</span>
          </p>

          <template v-if="restorePreview">
            <p class="visually-hidden" role="status" aria-live="polite">
              差异预览已生成，请检查恢复数量与风险提示。
            </p>
            <section class="restore-section" aria-labelledby="restore-difference-title">
              <div class="restore-section__heading">
                <div>
                  <h3 id="restore-difference-title">恢复后的数据变化</h3>
                  <p>“备份内”是文件原始数量，“恢复后”已反映公开分享开关。</p>
                </div>
                <span v-if="formatRestoreExpiry(restorePreview.expiresAt)" class="restore-expiry">
                  预览有效至 {{ formatRestoreExpiry(restorePreview.expiresAt) }}
                </span>
              </div>

              <div class="restore-comparison" role="list" aria-label="云端数据恢复差异">
                <article
                  v-for="row in restoreComparisonRows"
                  :key="row.key"
                  class="restore-comparison__item"
                  role="listitem"
                >
                  <h4>{{ row.label }}</h4>
                  <dl>
                    <div>
                      <dt>当前</dt>
                      <dd>{{ row.current }}</dd>
                    </div>
                    <div>
                      <dt>备份内</dt>
                      <dd>{{ row.backup }}</dd>
                    </div>
                    <div>
                      <dt>恢复后</dt>
                      <dd>{{ row.incoming }}</dd>
                    </div>
                    <div>
                      <dt>变化</dt>
                      <dd :class="{ 'restore-count--danger': row.difference < 0 }">
                        {{ formatRestoreDifference(row.difference) }}
                      </dd>
                    </div>
                  </dl>
                </article>
              </div>
              <div class="restore-media-summary" role="note">
                <Icon name="image" :size="20" aria-hidden="true" />
                <p>
                  当前 {{ previewCount(restorePreview.current, 'mediaAssets') }} 条图片目录记录会全部保留；
                  备份中的 {{ previewCount(restorePreview.backupCounts, 'mediaAssets') }} 条图片元数据仅用于去重补充，
                  不按替换差值计算。
                </p>
              </div>
            </section>

            <section
              v-if="restoreBackupShareCount > 0"
              class="restore-section restore-share-control"
              aria-labelledby="restore-share-title"
            >
              <div>
                <h3 id="restore-share-title">公开分享</h3>
                <p id="restore-share-help">
                  备份中有 {{ restoreBackupShareCount }} 条公开分享。默认不恢复；启用后，原分享链接可能重新对外可访问。
                </p>
              </div>
              <label
                class="restore-toggle"
                :class="{
                  'restore-toggle--disabled': restorePreviewing
                    || restoreApplying
                    || restoreSafetyBackupDownloading
                }"
              >
                <input
                  v-model="restoreShares"
                  type="checkbox"
                  :disabled="restorePreviewing || restoreApplying || restoreSafetyBackupDownloading"
                  aria-describedby="restore-share-help"
                  @change="handleRestoreSharesChange"
                >
                <span>同时恢复公开分享</span>
              </label>
              <p class="restore-share-control__note">
                切换此项会立即重新预览，并生成新的安全计划。
              </p>
            </section>

            <section
              class="restore-section restore-safety-backup"
              aria-labelledby="restore-safety-backup-title"
            >
              <Icon
                :name="restoreSafetyBackupDownloaded ? 'circle-check' : 'download'"
                :size="22"
                aria-hidden="true"
              />
              <div>
                <h3 id="restore-safety-backup-title">恢复前安全备份</h3>
                <p id="restore-safety-backup-help">
                  必须先下载一次当前云端数据，才能进入密码确认。重新预览、切换公开分享或选择其他文件后需要再次下载。
                  文件可能包含笔记密文和仍有效的公开分享链接，请妥善保存。
                </p>
                <button
                  type="button"
                  class="btn btn--secondary restore-safety-backup__button"
                  :disabled="restoreSafetyBackupDownloading || restorePreviewing || restoreBlockingErrors.length"
                  aria-describedby="restore-safety-backup-help"
                  @click="downloadRestoreSafetyBackup"
                >
                  <Icon
                    :name="restoreSafetyBackupDownloaded ? 'circle-check' : 'download'"
                    :size="18"
                    aria-hidden="true"
                  />
                  {{ restoreSafetyBackupDownloading
                    ? '正在下载当前备份…'
                    : restoreSafetyBackupDownloaded
                      ? '已下载当前云端备份'
                      : '下载当前云端备份' }}
                </button>
                <span
                  v-if="restoreSafetyBackupDownloaded"
                  class="visually-hidden"
                  role="status"
                  aria-live="polite"
                >
                  当前云端备份已下载，可以继续身份确认。
                </span>
              </div>
            </section>

            <section class="restore-section" aria-labelledby="restore-risk-title">
              <h3 id="restore-risk-title">执行前请确认这些影响</h3>
              <div class="restore-risk-list">
                <div class="restore-risk-card restore-risk-card--danger">
                  <Icon name="alert" :size="20" aria-hidden="true" />
                  <div>
                    <strong>替换，不是合并</strong>
                    <p>当前分组、书签、笔记、搜索引擎与普通设置会被备份内容替换。</p>
                  </div>
                </div>
                <div class="restore-risk-card">
                  <Icon name="shield" :size="20" aria-hidden="true" />
                  <div>
                    <strong>敏感服务配置不会从文件覆盖</strong>
                    <p>
                      API Key、Telegram Token、服务器 Secret 等仍使用服务器现有配置；
                      本次忽略 {{ boundedCount(restorePreview.ignoredSettings) }} 项设置。
                    </p>
                  </div>
                </div>
                <div class="restore-risk-card">
                  <Icon name="image" :size="20" aria-hidden="true" />
                  <div>
                    <strong>图床图片二进制不在备份中</strong>
                    <p>
                      仅恢复图片 URL 与元数据，并保留当前 {{ boundedCount(restorePreview.preservedMediaAssets) }} 条图片资产记录。
                    </p>
                  </div>
                </div>
                <div v-if="boundedCount(restorePreview.encryptedNotes) > 0" class="restore-risk-card">
                  <Icon name="lock" :size="20" aria-hidden="true" />
                  <div>
                    <strong>加密笔记仍需要原密码</strong>
                    <p>备份含 {{ boundedCount(restorePreview.encryptedNotes) }} 条加密笔记，恢复不会重置其加密密码。</p>
                  </div>
                </div>
              </div>
            </section>

            <section v-if="restoreWarnings.length" class="restore-section" aria-labelledby="restore-warning-title">
              <h3 id="restore-warning-title">服务器风险提示</h3>
              <ul class="restore-message-list">
                <li v-for="warning in restoreWarnings" :key="warning">
                  <Icon name="alert" :size="18" aria-hidden="true" />
                  <span>{{ warning }}</span>
                </li>
              </ul>
            </section>

            <section
              v-if="restoreBlockingErrors.length"
              class="restore-section restore-blocking"
              role="alert"
              aria-labelledby="restore-blocking-title"
            >
              <h3 id="restore-blocking-title">当前不能执行恢复</h3>
              <ul class="restore-message-list">
                <li v-for="blockingError in restoreBlockingErrors" :key="blockingError">
                  <Icon name="circle-x" :size="18" aria-hidden="true" />
                  <span>{{ blockingError }}</span>
                </li>
              </ul>
            </section>
          </template>
        </template>

        <form
          v-else-if="restoreStage === 'confirm'"
          id="cloud-restore-confirm-form"
          class="restore-confirm"
          @submit.prevent="applyRestore"
        >
          <div class="restore-confirm__warning">
            <Icon name="alert" :size="22" aria-hidden="true" />
            <div>
              <strong>此操作会替换云端数据，不会合并</strong>
              <p>
                {{ restoreShares ? '公开分享也会按备份恢复。' : '公开分享不会恢复。' }}
                提交后请等待完成，不要关闭页面。
              </p>
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="cloud-restore-password">当前登录密码</label>
            <input
              id="cloud-restore-password"
              ref="restorePasswordInput"
              v-model="restorePassword"
              class="input"
              type="password"
              name="current-password"
              autocomplete="current-password"
              :disabled="restoreApplying"
              aria-describedby="cloud-restore-password-help"
              required
            >
            <p id="cloud-restore-password-help" class="restore-field-help">
              只用于本次身份确认，不会写入备份或保存在浏览器中。
            </p>
          </div>

          <div class="form-group">
            <label class="form-label" for="cloud-restore-confirmation">
              输入“恢复”确认
            </label>
            <input
              id="cloud-restore-confirmation"
              v-model="restoreConfirmation"
              class="input"
              type="text"
              name="restore-confirmation"
              autocomplete="off"
              maxlength="2"
              :disabled="restoreApplying"
              aria-describedby="cloud-restore-confirmation-help"
              required
            >
            <p id="cloud-restore-confirmation-help" class="restore-field-help">
              必须准确输入中文“恢复”两个字，才能启用最终按钮。
            </p>
          </div>

          <p v-if="restoreError" class="restore-feedback restore-feedback--error" role="alert">
            <Icon name="alert" :size="18" aria-hidden="true" />
            <span>{{ restoreError }}</span>
          </p>
        </form>

        <div
          v-else
          ref="restoreSuccessFocus"
          class="restore-success"
          role="status"
          aria-live="polite"
          tabindex="-1"
        >
          <Icon name="circle-check" :size="42" aria-hidden="true" />
          <h3>{{ restoreIsCloudBackup ? '云端备份恢复完成' : '本地数据迁移完成' }}</h3>
          <p>服务器已完成原子替换，页面刷新后即可使用新数据。</p>
          <dl class="restore-result-list">
            <div v-for="row in restoreResultRows" :key="row.key">
              <dt>{{ row.label }}</dt>
              <dd>{{ row.count }}</dd>
            </div>
            <div>
              <dt>忽略设置</dt>
              <dd>{{ boundedCount(restoreResult?.ignoredSettings) }}</dd>
            </div>
            <div>
              <dt>图片元数据处理</dt>
              <dd>{{ boundedCount(restoreResult?.imported?.mediaAssets) }}</dd>
            </div>
            <div>
              <dt>现有图片目录</dt>
              <dd>{{ restoreResult?.preservedMediaAssets ? '已保留' : '未确认' }}</dd>
            </div>
          </dl>
          <p class="restore-result-note">
            {{ restoreResult?.sharesRestored ? '公开分享已随备份恢复。' : '公开分享未恢复。' }}
            {{ restoreIsCloudBackup ? '' : '当前浏览器 IndexedDB 仍保留。' }}
          </p>
        </div>
      </div>

      <template #footer>
        <div class="restore-footer">
          <template v-if="restoreStage === 'preview'">
            <button type="button" class="btn btn--secondary" @click="closeRestoreModal">
              取消
            </button>
            <button
              v-if="restoreError && !restorePreviewing && !restorePreview"
              type="button"
              class="btn btn--secondary"
              data-restore-primary
              @click="refreshRestorePreview"
            >
              <Icon name="refresh" :size="18" aria-hidden="true" />
              重新预览
            </button>
            <button
              v-else-if="!restoreSafetyBackupDownloaded"
              type="button"
              class="btn btn--primary"
              data-restore-primary
              :disabled="restorePreviewing || restoreSafetyBackupDownloading || !restorePreview || restoreBlockingErrors.length"
              @click="downloadRestoreSafetyBackup"
            >
              <Icon name="download" :size="18" aria-hidden="true" />
              {{ restoreSafetyBackupDownloading ? '正在下载…' : '先下载当前云端备份' }}
            </button>
            <button
              v-else
              type="button"
              class="btn btn--primary"
              data-restore-primary
              :disabled="!restoreCanContinue"
              @click="continueRestoreConfirmation"
            >
              继续身份确认
            </button>
          </template>
          <template v-else-if="restoreStage === 'confirm'">
            <button
              type="button"
              class="btn btn--secondary"
              :disabled="restoreApplying"
              @click="returnToRestorePreview"
            >
              <Icon name="arrow-left" :size="18" aria-hidden="true" />
              返回预览
            </button>
            <button
              type="submit"
              form="cloud-restore-confirm-form"
              class="btn btn--danger"
              :disabled="!restoreCanApply"
            >
              <Icon name="shield" :size="18" aria-hidden="true" />
              {{ restoreApplying ? '正在恢复…' : '确认替换云端数据' }}
            </button>
          </template>
          <button v-else type="button" class="btn btn--primary" @click="finishRestore">
            完成并刷新
          </button>
        </div>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.settings-section {
  margin-bottom: 24px;
  padding: 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.settings-section__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-light);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.restore-page-message {
  display: flex;
  align-items: center;
  gap: 9px;
  min-height: 44px;
  margin: 0 0 8px;
  padding: 10px 14px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
}

.restore-page-message > svg {
  flex: 0 0 auto;
}

.restore-page-message--success {
  background: color-mix(in srgb, var(--success-color) 14%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--success-color) 38%, var(--border-light));
}

.restore-page-message--success > svg {
  color: var(--success-color);
}

.restore-page-message--error {
  color: var(--error-color);
  background: color-mix(in srgb, var(--error-color) 12%, var(--bg-secondary));
  border-color: color-mix(in srgb, var(--error-color) 40%, var(--border-light));
}

.restore-page-message--error > svg {
  color: var(--error-color);
}

.settings-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 0;
  border-bottom: 1px solid var(--border-light);
}

.settings-item:last-child {
  border-bottom: none;
}

.settings-item__info {
  flex: 1;
}

.settings-item__label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.settings-item__desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
  line-height: 1.6;
}

.settings-item__control {
  flex-shrink: 0;
  margin-left: 24px;
}

.settings-item--danger .settings-item__label {
  color: var(--error-color);
}

.storage-info {
  width: 220px;
  text-align: right;
}

.storage-bar {
  height: 8px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-full);
  overflow: hidden;
  margin-bottom: 6px;
}

.storage-bar__used {
  height: 100%;
  background: var(--accent-color);
  border-radius: var(--radius-full);
  transition: width var(--transition-normal);
}

.storage-text {
  font-size: 12px;
  color: var(--text-muted);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 44px;
  padding: 10px 20px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn--secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.btn--secondary:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn--primary {
  background: var(--accent-color);
  color: var(--accent-text, #fff);
}

.btn--primary:hover:not(:disabled) {
  filter: brightness(1.06);
}

.btn--danger {
  background: var(--error-color);
  color: #fff;
}

.btn--danger:hover:not(:disabled) {
  opacity: 0.9;
}

.restore-dialog {
  color: var(--text-primary);
}

.restore-source-card,
.restore-confirm__warning,
.restore-risk-card,
.restore-feedback,
.restore-loading {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
}

.restore-source-card {
  align-items: center;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
}

.restore-source-card:focus {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.restore-source-card svg,
.restore-risk-card svg {
  flex: 0 0 auto;
  color: var(--accent-color);
}

.restore-source-card strong,
.restore-risk-card strong,
.restore-confirm__warning strong {
  display: block;
  font-size: 14px;
  color: var(--text-primary);
}

.restore-source-card > div,
.restore-safety-backup > div {
  min-width: 0;
}

.restore-source-card strong {
  overflow-wrap: anywhere;
}

.restore-source-card p,
.restore-risk-card p,
.restore-confirm__warning p,
.restore-section__heading p,
.restore-share-control p,
.restore-success p {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.restore-loading {
  align-items: center;
  margin-top: 16px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
}

.restore-loading svg {
  flex: 0 0 auto;
  animation: restore-spin 0.9s linear infinite;
}

.restore-feedback {
  margin: 16px 0 0;
  line-height: 1.55;
}

.restore-feedback svg {
  flex: 0 0 auto;
  margin-top: 1px;
}

.restore-feedback--error {
  color: var(--error-color);
  background: color-mix(in srgb, var(--error-color) 12%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--error-color) 40%, var(--border-light));
}

.restore-section {
  margin-top: 22px;
}

.restore-section h3,
.restore-success h3 {
  margin: 0;
  color: var(--text-primary);
  font-size: 15px;
  font-weight: 650;
}

.restore-section__heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.restore-expiry {
  flex: 0 0 auto;
  padding: 6px 9px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-full);
  font-size: 12px;
}

.restore-comparison {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.restore-comparison__item {
  padding: 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
}

.restore-comparison__item h4 {
  margin: 0 0 10px;
  color: var(--text-primary);
  font-size: 14px;
}

.restore-comparison__item dl {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin: 0;
}

.restore-comparison__item dl div {
  min-width: 0;
}

.restore-comparison__item dt {
  color: var(--text-muted);
  font-size: 11px;
}

.restore-comparison__item dd {
  margin: 3px 0 0;
  color: var(--text-primary);
  font-size: 14px;
  font-variant-numeric: tabular-nums;
}

.restore-count--danger {
  color: var(--error-color) !important;
}

.restore-share-control {
  padding: 16px;
  background: color-mix(in srgb, var(--accent-color) 8%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--accent-color) 28%, var(--border-light));
  border-radius: var(--radius-md);
}

.restore-toggle {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  margin-top: 10px;
  padding: 7px 12px;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
  font-size: 14px;
  cursor: pointer;
}

.restore-toggle:focus-within {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.restore-toggle input {
  width: 20px;
  height: 20px;
  margin: 0;
  accent-color: var(--accent-color);
}

.restore-toggle--disabled {
  opacity: 0.65;
  cursor: not-allowed;
}

.restore-share-control__note {
  margin-top: 8px !important;
}

.restore-safety-backup {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px;
  background: color-mix(in srgb, var(--success-color) 9%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--success-color) 32%, var(--border-light));
  border-radius: var(--radius-md);
}

.restore-safety-backup > svg {
  flex: 0 0 auto;
  color: var(--success-color);
}

.restore-safety-backup p {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.restore-safety-backup__button {
  margin-top: 12px;
}

.restore-risk-list {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}

.restore-risk-card {
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
}

.restore-risk-card--danger {
  background: color-mix(in srgb, var(--error-color) 9%, var(--bg-secondary));
  border-color: color-mix(in srgb, var(--error-color) 35%, var(--border-light));
}

.restore-risk-card--danger svg {
  color: var(--error-color);
}

.restore-message-list {
  display: grid;
  gap: 8px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.restore-message-list li {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 11px 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
  font-size: 13px;
  line-height: 1.55;
}

.restore-message-list svg {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--warning-color, var(--accent-color));
}

.restore-blocking {
  padding: 14px;
  background: color-mix(in srgb, var(--error-color) 8%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--error-color) 36%, var(--border-light));
  border-radius: var(--radius-md);
}

.restore-blocking .restore-message-list svg,
.restore-blocking h3 {
  color: var(--error-color);
}

.restore-confirm__warning {
  margin-bottom: 20px;
  background: color-mix(in srgb, var(--error-color) 10%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--error-color) 38%, var(--border-light));
}

.restore-confirm__warning > svg {
  flex: 0 0 auto;
  color: var(--error-color);
}

.restore-confirm :deep(.input) {
  min-height: 44px;
}

.restore-field-help {
  margin: 7px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.55;
}

.restore-success {
  padding: 8px 0;
  text-align: center;
}

.restore-success:focus {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.restore-success > svg {
  color: var(--success-color);
}

.restore-success h3 {
  margin-top: 12px;
  font-size: 18px;
}

.restore-result-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 20px 0 0;
}

.restore-result-list div {
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-sm);
}

.restore-result-list dt {
  color: var(--text-muted);
  font-size: 12px;
}

.restore-result-list dd {
  margin: 4px 0 0;
  color: var(--text-primary);
  font-size: 18px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.restore-result-note {
  margin-top: 16px !important;
}

.restore-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  width: 100%;
}

@keyframes restore-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .restore-loading svg {
    animation: none;
  }
}

@media (max-width: 640px) {
  .settings-section {
    padding: 16px;
  }

  .settings-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .settings-item__control {
    margin-left: 0;
    width: 100%;
  }

  .storage-info {
    width: 100%;
    text-align: left;
  }

  .btn {
    width: 100%;
    justify-content: center;
  }

  .restore-section__heading {
    display: block;
  }

  .restore-expiry {
    display: inline-flex;
    margin-top: 8px;
  }

  .restore-comparison {
    grid-template-columns: 1fr;
  }

  .restore-comparison__item {
    padding: 12px;
  }

  .restore-toggle {
    width: 100%;
  }

  .restore-result-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .restore-footer {
    flex-direction: column;
  }

  .restore-footer .btn {
    min-height: 48px;
  }
}
</style>
