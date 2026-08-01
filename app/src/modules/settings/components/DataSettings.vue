<script setup>
import { computed, onMounted, ref } from 'vue'
import { clearAllData, exportData, getLocalDataSummary, importData } from '@/shared/db/database'
import { useConfig } from '@/shared/composables/useConfig'
import {
  exportBackendData,
  importLocalDataToBackend,
  shouldUseBackendMigration
} from '@/shared/services/migrationApi'

const { resetConfig } = useConfig()

const importing = ref(false)
const exporting = ref(false)
const cloudExporting = ref(false)
const migrating = ref(false)
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
  const blob = new Blob([JSON.stringify(data, null, 2)], {
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
    const backup = await exportBackendData()
    if (
      backup?.schema !== 'domo-nav-backup'
      || backup?.version !== 1
      || !backup?.manifest
      || !backup?.data
    ) {
      throw new Error('服务器返回的备份格式无效')
    }

    const fallbackFileName = (
      `domo-nav-cloud-backup-${new Date().toISOString().slice(0, 10)}.json`
    )
    downloadJson(backup, backup.fileName || fallbackFileName)

    const counts = backup.manifest.counts || {}
    alert(
      `NAV 云端数据已导出：书签 ${counts.bookmarks || 0} 条，`
      + `笔记 ${counts.notes || 0} 条，分享 ${counts.shares || 0} 条。`
    )
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

  if (!confirm('确定把当前浏览器里的本地数据迁移到云端数据库吗？\n\n这会用本地数据覆盖当前账号在云端的已有数据。')) {
    return
  }

  migrating.value = true
  try {
    const backup = await exportData()
    const summary = await importLocalDataToBackend(backup.data)
    alert(`迁移成功：书签 ${summary.imported.bookmarks} 条，笔记 ${summary.imported.notes} 条，设置 ${summary.imported.settings} 项。`)
    await refreshLocalState()
  } catch (error) {
    alert(`迁移失败：${error.message}`)
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
        <div class="settings-item__desc">把当前浏览器 IndexedDB 里的书签、便签、设置和自定义搜索引擎导入 PostgreSQL</div>
      </div>
      <div class="settings-item__control">
        <button class="btn btn--secondary" :disabled="migrating" @click="handleMigrateToCloud">
          {{ migrating ? '迁移中...' : '上传到云端' }}
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
  gap: 6px;
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

.btn--danger {
  background: var(--error-color);
  color: #fff;
}

.btn--danger:hover:not(:disabled) {
  opacity: 0.9;
}

@media (max-width: 640px) {
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
}
</style>
