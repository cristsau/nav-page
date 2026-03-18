<script setup>
import { ref } from 'vue'
import { exportData, importData, clearAllData } from '@/shared/db/database'
import { useConfig } from '@/shared/composables/useConfig'

const { resetConfig } = useConfig()

const importing = ref(false)
const exporting = ref(false)

// 导出数据
async function handleExport() {
  if (exporting.value) return

  exporting.value = true
  try {
    const data = await exportData()
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `nav-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    alert('导出成功！')
  } catch (e) {
    alert('导出失败：' + e.message)
  } finally {
    exporting.value = false
  }
}

// 导入数据
async function handleImport(event) {
  const file = event.target.files?.[0]
  if (!file) return

  importing.value = true
  try {
    const text = await file.text()
    const data = JSON.parse(text)

    // 验证数据格式
    if (!data.version || !data.data) {
      throw new Error('无效的备份文件')
    }

    await importData(data.data)
    alert('导入成功！页面将刷新')
    window.location.reload()
  } catch (e) {
    alert('导入失败：' + e.message)
  } finally {
    importing.value = false
    event.target.value = ''
  }
}

// 清除所有数据
async function handleClearData() {
  if (!confirm('⚠️ 确定要清除所有数据吗？\n\n这将删除：\n• 所有分组和书签\n• 所有时光笔记\n• 所有自定义设置\n\n此操作不可恢复！')) {
    return
  }

  if (!confirm('🔴 最后确认：真的要删除所有数据吗？')) {
    return
  }

  try {
    await clearAllData()
    alert('数据已清除，页面将刷新')
    window.location.reload()
  } catch (e) {
    alert('清除失败：' + e.message)
  }
}

// 重置设置
async function handleResetConfig() {
  if (!confirm('确定要重置所有设置吗？（不会删除数据）')) {
    return
  }

  await resetConfig()
  alert('设置已重置')
}

// 存储使用情况
const storageInfo = ref({
  used: 0,
  quota: 0
})

// 获取存储信息
async function getStorageInfo() {
  if (navigator.storage && navigator.storage.estimate) {
    const estimate = await navigator.storage.estimate()
    storageInfo.value = {
      used: estimate.usage || 0,
      quota: estimate.quota || 0
    }
  }
}

// 格式化存储大小
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB'
}

// 初始化
getStorageInfo()
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section__title">💾 数据管理</h3>

    <!-- 存储使用情况 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">存储使用</div>
        <div class="settings-item__desc">本地存储空间使用情况</div>
      </div>
      <div class="settings-item__control">
        <div class="storage-info">
          <div class="storage-bar">
            <div
              class="storage-bar__used"
              :style="{ width: `${(storageInfo.used / storageInfo.quota) * 100}%` }"
            ></div>
          </div>
          <div class="storage-text">
            {{ formatSize(storageInfo.used) }} / {{ formatSize(storageInfo.quota) }}
          </div>
        </div>
      </div>
    </div>

    <!-- 备份数据 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">备份数据</div>
        <div class="settings-item__desc">导出所有数据到本地文件</div>
      </div>
      <div class="settings-item__control">
        <button
          class="btn btn--secondary"
          :disabled="exporting"
          @click="handleExport"
        >
          {{ exporting ? '导出中...' : '📥 导出备份' }}
        </button>
      </div>
    </div>

    <!-- 恢复数据 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">恢复数据</div>
        <div class="settings-item__desc">从备份文件恢复数据</div>
      </div>
      <div class="settings-item__control">
        <label class="btn btn--secondary">
          {{ importing ? '导入中...' : '📤 导入备份' }}
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

    <!-- 重置设置 -->
    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">重置设置</div>
        <div class="settings-item__desc">恢复默认设置（不影响数据）</div>
      </div>
      <div class="settings-item__control">
        <button class="btn btn--secondary" @click="handleResetConfig">
          🔄 重置设置
        </button>
      </div>
    </div>

    <!-- 清除数据 -->
    <div class="settings-item settings-item--danger">
      <div class="settings-item__info">
        <div class="settings-item__label">清除所有数据</div>
        <div class="settings-item__desc">删除所有本地数据（不可恢复）</div>
      </div>
      <div class="settings-item__control">
        <button class="btn btn--danger" @click="handleClearData">
          🗑️ 清除数据
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
}

.settings-item__control {
  flex-shrink: 0;
  margin-left: 24px;
}

.settings-item--danger .settings-item__label {
  color: var(--error-color);
}

/* 存储信息 */
.storage-info {
  width: 200px;
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

/* 按钮 */
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
