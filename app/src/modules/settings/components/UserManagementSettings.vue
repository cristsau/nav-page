<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAuth } from '@/shared/composables/useAuth'
import { getTelegramConfig, setTelegramConfig } from '@/shared/db/database'
import { testTelegramConfig } from '@/shared/services/telegramApproval'
import {
  fetchBackendTelegramConfig,
  saveBackendTelegramConfig,
  shouldUseBackendTelegramAdmin,
  testBackendTelegramConfig
} from '@/shared/services/adminTelegramApi'

const {
  currentUser,
  pendingRequests,
  approvedUsers,
  registrationHistory,
  approve,
  reject,
  syncTelegram,
  initAuth,
  refreshAll
} = useAuth()

const syncing = ref(false)
const syncMessage = ref('')
const savingTelegram = ref(false)
const testingTelegram = ref(false)
const telegramMessage = ref('')
const telegramForm = ref({
  enabled: false,
  botToken: '',
  adminChatId: ''
})

let timer = null

const pendingCount = computed(() => pendingRequests.value.length)

function formatDate(timestamp) {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

async function loadTelegramSettings() {
  telegramForm.value = shouldUseBackendTelegramAdmin()
    ? await fetchBackendTelegramConfig()
    : await getTelegramConfig()
}

async function handleApprove(requestId) {
  await approve(requestId)
}

async function handleReject(requestId) {
  await reject(requestId)
}

async function handleSyncTelegram() {
  if (currentUser.value?.role !== 'admin' || syncing.value) return

  syncing.value = true
  syncMessage.value = ''

  try {
    const summary = await syncTelegram()
    syncMessage.value = summary.skipped
      ? 'Telegram 未启用或未配置'
      : summary.processed.length
        ? `已同步 ${summary.processed.length} 条 Telegram 审批指令`
        : '已同步，没有新的 Telegram 审批指令'
  } catch (error) {
    syncMessage.value = error.message || 'Telegram 同步失败'
  } finally {
    syncing.value = false
  }
}

async function handleSaveTelegram() {
  savingTelegram.value = true
  telegramMessage.value = ''

  try {
    if (shouldUseBackendTelegramAdmin()) {
      await saveBackendTelegramConfig(telegramForm.value)
    } else {
      await setTelegramConfig(telegramForm.value)
    }
    telegramMessage.value = 'Telegram 配置已保存，仅保存在当前设备管理员账户下'
  } catch (error) {
    telegramMessage.value = error.message || 'Telegram 配置保存失败'
  } finally {
    savingTelegram.value = false
  }
}

async function handleTestTelegram() {
  testingTelegram.value = true
  telegramMessage.value = ''

  try {
    const result = shouldUseBackendTelegramAdmin()
      ? await testBackendTelegramConfig(telegramForm.value)
      : await testTelegramConfig(telegramForm.value)
    telegramMessage.value = `测试消息已送达，Bot 名称：${result.result?.username || result.result?.first_name || '未知'}`
  } catch (error) {
    telegramMessage.value = error.message || 'Telegram 连接失败'
  } finally {
    testingTelegram.value = false
  }
}

onMounted(async () => {
  await initAuth()
  await refreshAll()

  if (currentUser.value?.role !== 'admin') return

  await loadTelegramSettings()
  await handleSyncTelegram()
  timer = window.setInterval(handleSyncTelegram, 15000)
})

onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <section v-if="currentUser?.role === 'admin'" class="settings-section">
    <div class="section-header">
      <div>
        <h3 class="settings-section__title">用户管理</h3>
        <p class="settings-section__subtitle">默认管理员可审批注册，也可配置自己的 Telegram 审批通道。</p>
      </div>
      <button class="sync-btn" :disabled="syncing" @click="handleSyncTelegram">
        {{ syncing ? '同步中...' : '同步 Telegram 审批' }}
      </button>
    </div>

    <div v-if="syncMessage" class="sync-message">{{ syncMessage }}</div>

    <div class="summary-grid">
      <div class="summary-card">
        <span class="summary-card__label">当前管理员</span>
        <strong>{{ currentUser.username }}</strong>
      </div>
      <div class="summary-card">
        <span class="summary-card__label">待审批申请</span>
        <strong>{{ pendingCount }}</strong>
      </div>
      <div class="summary-card">
        <span class="summary-card__label">已批准用户</span>
        <strong>{{ approvedUsers.length }}</strong>
      </div>
    </div>

    <div class="telegram-panel">
      <div class="user-block__title">Telegram 接入</div>
      <div class="telegram-grid">
        <label class="telegram-field telegram-field--switch">
          <span>启用 Telegram 审批</span>
          <input v-model="telegramForm.enabled" type="checkbox">
        </label>
        <label class="telegram-field">
          <span>Bot Token</span>
          <input v-model="telegramForm.botToken" type="password" placeholder="输入你自己的 Telegram Bot Token">
        </label>
        <label class="telegram-field">
          <span>管理员 Chat ID</span>
          <input v-model="telegramForm.adminChatId" type="text" placeholder="输入你自己的管理员 Chat ID">
        </label>
      </div>
      <div class="telegram-actions">
        <button class="btn btn--secondary" :disabled="testingTelegram" @click="handleTestTelegram">
          {{ testingTelegram ? '发送中...' : '发送测试消息' }}
        </button>
        <button class="btn btn--primary" :disabled="savingTelegram" @click="handleSaveTelegram">
          {{ savingTelegram ? '保存中...' : '保存 Telegram 配置' }}
        </button>
      </div>
      <div v-if="telegramMessage" class="sync-message">{{ telegramMessage }}</div>
      <p class="telegram-tip">测试会向填写的 Chat ID 发送一条 DOMO NAV 测试消息，同时验证 Bot Token 与真实接收目标。</p>
    </div>

    <div class="user-block">
      <div class="user-block__title">待审批注册</div>
      <div v-if="pendingRequests.length" class="request-list">
        <div v-for="request in pendingRequests" :key="request.id" class="request-card">
          <div>
            <div class="request-card__name">{{ request.username }}</div>
            <div class="request-card__meta">申请编号：{{ request.id }}</div>
            <div class="request-card__meta">提交时间：{{ formatDate(request.createdAt) }}</div>
          </div>
          <div class="request-card__actions">
            <button class="btn btn--secondary" @click="handleReject(request.id)">拒绝</button>
            <button class="btn btn--primary" @click="handleApprove(request.id)">批准</button>
          </div>
        </div>
      </div>
      <div v-else class="empty-state">当前没有待审批的注册申请。</div>
    </div>

    <div class="user-block">
      <div class="user-block__title">已批准用户</div>
      <div class="table">
        <div class="table__head">
          <span>用户名</span>
          <span>角色</span>
          <span>创建时间</span>
          <span>最近登录</span>
        </div>
        <div v-for="user in approvedUsers" :key="user.id" class="table__row">
          <span>{{ user.username }}</span>
          <span>{{ user.role === 'admin' ? '管理员' : '普通用户' }}</span>
          <span>{{ formatDate(user.createdAt) }}</span>
          <span>{{ formatDate(user.lastLoginAt) }}</span>
        </div>
      </div>
    </div>

    <div class="user-block">
      <div class="user-block__title">审批历史</div>
      <div class="table">
        <div class="table__head">
          <span>用户名</span>
          <span>状态</span>
          <span>处理人</span>
          <span>更新时间</span>
        </div>
        <div v-for="item in registrationHistory" :key="item.id" class="table__row">
          <span>{{ item.username }}</span>
          <span>{{ item.status }}</span>
          <span>{{ item.decidedBy || '-' }}</span>
          <span>{{ formatDate(item.updatedAt) }}</span>
        </div>
      </div>
    </div>
  </section>
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
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.settings-section__subtitle {
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: 13px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-light);
}

.sync-btn,
.btn {
  border: none;
  border-radius: 14px;
  padding: 10px 16px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sync-btn {
  background: var(--accent-color);
  color: #fff;
}

.sync-btn:disabled,
.btn:disabled {
  opacity: 0.7;
  cursor: wait;
}

.sync-message {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
}

.summary-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 18px;
}

.summary-card {
  display: grid;
  gap: 8px;
  padding: 16px;
  border-radius: 18px;
  background: var(--bg-secondary);
}

.summary-card__label {
  color: var(--text-muted);
  font-size: 12px;
}

.telegram-panel,
.user-block {
  margin-top: 20px;
}

.user-block__title {
  margin-bottom: 12px;
  color: var(--text-primary);
  font-weight: 600;
}

.telegram-grid {
  display: grid;
  gap: 12px;
}

.telegram-field {
  display: grid;
  gap: 8px;
  color: var(--text-primary);
}

.telegram-field input {
  width: 100%;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 12px 14px;
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.telegram-field--switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--bg-secondary);
}

.telegram-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.telegram-tip {
  margin-top: 10px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.request-list {
  display: grid;
  gap: 12px;
}

.request-card {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
  padding: 16px;
  border-radius: 18px;
  background: var(--bg-secondary);
}

.request-card__name {
  font-size: 16px;
  color: var(--text-primary);
  font-weight: 600;
}

.request-card__meta {
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 12px;
}

.request-card__actions {
  display: flex;
  gap: 8px;
}

.btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.btn--secondary {
  background: var(--bg-primary);
  color: var(--text-primary);
}

.table {
  display: grid;
  gap: 8px;
}

.table__head,
.table__row {
  display: grid;
  grid-template-columns: 1.3fr 0.8fr 1.1fr 1.2fr;
  gap: 12px;
  padding: 14px 16px;
  border-radius: 16px;
}

.table__head {
  background: var(--bg-secondary);
  color: var(--text-muted);
  font-size: 12px;
}

.table__row {
  background: color-mix(in srgb, var(--bg-secondary) 88%, transparent);
  color: var(--text-primary);
  font-size: 13px;
}

.empty-state {
  padding: 18px;
  border-radius: 18px;
  background: var(--bg-secondary);
  color: var(--text-muted);
}

@media (max-width: 760px) {
  .section-header,
  .request-card,
  .telegram-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .summary-grid {
    grid-template-columns: 1fr;
  }

  .table__head,
  .table__row {
    grid-template-columns: 1fr;
  }
}
</style>
