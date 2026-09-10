<script setup>
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useAuth } from '@/shared/composables/useAuth'
import { fetchAdminMailStatus, queueAdminMailTest } from '@/shared/services/systemNotificationApi'

const {
  currentUser,
  pendingRequests,
  approvedUsers,
  registrationHistory,
  approve,
  reject,
  initAuth,
  refreshAll
} = useAuth()

const mailStatus = ref({
  mail: { configured: false, enabled: false }
})
const mailStatusLoading = ref(false)
const mailTestRecipient = ref('')
const mailTestLoading = ref(false)
const mailTestMessage = ref('')
const mailTestError = ref('')

const pendingCount = computed(() => pendingRequests.value.length)
const route = useRoute()
const decision = ref(null), deciding = ref(false), decisionMessage = ref(''), decisionError = ref(''), refreshRequired = ref(false)
const decisionPanel = ref(null)
const linkedRequest = computed(() => registrationHistory.value.find(item => item.id === String(route.query.request || '')))
const statusLabels = { email_pending: '待验证邮箱', pending: '待管理员审核', approved: '已批准', rejected: '已拒绝', expired: '已过期' }
function statusLabel(status) { return statusLabels[status] || '未知状态' }
async function selectDecision(request, action) {
  if (deciding.value) return
  decision.value = { request, action }; decisionMessage.value = ''; decisionError.value = ''
  await nextTick(); decisionPanel.value?.focus()
}
async function confirmDecision() {
  if (!decision.value || deciding.value) return
  deciding.value = true; decisionError.value = ''; decisionMessage.value = ''
  try {
    const { request, action } = decision.value
    const result = await (action === 'approved' ? approve(request.id) : reject(request.id))
    const mail = result.notification?.mailStatus
    const notificationText = mail === 'sent' ? '结果通知已交给邮件服务器。'
      : ['pending', 'sending'].includes(mail) ? '结果邮件已进入发送队列。'
      : mail === 'not_applicable' ? '此申请未绑定邮箱，无邮件通知。'
      : '请在邮件状态中确认结果通知的投递情况。'
    decisionMessage.value = `申请${statusLabel(result.status)}。${notificationText}`
    refreshRequired.value = result.refreshRequired === true
    decision.value = null
  } catch (error) {
    decisionError.value = error.code === 'REGISTRATION_NOT_PENDING'
      ? '该申请状态已变化，请刷新列表后查看。'
      : '未能确认审批完成，请刷新列表核对状态后再重试。'
    refreshRequired.value = true
  } finally { deciding.value = false }
}
async function refreshLists() {
  try { await refreshAll(); refreshRequired.value = false; decisionError.value = ''; decision.value = null }
  catch { decisionError.value = '列表刷新失败，请检查网络后重试。' }
}

function formatDate(timestamp) {
  if (!timestamp) return '-'
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false })
}

async function loadMailStatus() {
  mailStatusLoading.value = true
  try {
    mailStatus.value = await fetchAdminMailStatus()
  } catch {
    mailTestError.value = '暂时无法获取邮件状态，请稍后刷新。'
  } finally {
    mailStatusLoading.value = false
  }
}

async function sendMailTest() {
  mailTestMessage.value = ''
  mailTestError.value = ''
  const recipient = mailTestRecipient.value.trim()
  if (!recipient) {
    mailTestError.value = '请输入测试收件地址。'
    return
  }
  mailTestLoading.value = true
  try {
    await queueAdminMailTest(recipient)
    mailTestMessage.value = '测试邮件已进入发送队列，请稍后检查收件箱和垃圾邮件。'
  } catch (error) {
    mailTestError.value = error.message || '无法创建测试邮件。'
  } finally {
    mailTestLoading.value = false
  }
}

onMounted(async () => {
  try { await initAuth(); await refreshAll() }
  catch { decisionError.value = '用户列表未加载完整，请刷新重试。'; refreshRequired.value = true }

  if (currentUser.value?.role !== 'admin') return

  if (currentUser.value.email) mailTestRecipient.value = currentUser.value.email
  await loadMailStatus()
})
</script>

<template>
  <section v-if="currentUser?.role === 'admin'" class="settings-section">
    <div class="section-header">
      <div>
        <h3 class="settings-section__title">用户管理</h3>
        <p class="settings-section__subtitle">注册申请通过已配置的邮件服务送达，审批仍需登录本页完成。</p>
      </div>
      <button class="sync-btn" :disabled="mailStatusLoading" @click="loadMailStatus">
        {{ mailStatusLoading ? '检查中...' : '刷新邮件状态' }}
      </button>
    </div>

    <div v-if="linkedRequest" class="sync-message" aria-label="邮件对应的注册申请">
      <strong>{{ linkedRequest.username }} · {{ statusLabel(linkedRequest.status) }}</strong>
      <p>邮件只定位此申请，批准仍需管理员在下方确认。</p>
      <div v-if="linkedRequest.status === 'pending'" class="request-card__actions">
        <button class="btn btn--secondary" :disabled="deciding" @click="selectDecision(linkedRequest, 'rejected')">拒绝此申请</button>
        <button class="btn btn--primary" :disabled="deciding" @click="selectDecision(linkedRequest, 'approved')">批准此申请</button>
      </div>
    </div>
    <section v-if="decision" ref="decisionPanel" tabindex="-1" class="decision-panel" aria-label="确认审批">
      <strong>确认{{ decision.action === 'approved' ? '批准' : '拒绝' }} {{ decision.request.username }} 的申请？</strong>
      <p>{{ decision.action === 'approved' ? '批准后创建普通用户账号，不授予管理员权限。' : '拒绝后不会创建账号。' }}有绑定邮箱时会自动通知申请人。</p>
      <div class="request-card__actions">
        <button class="btn btn--secondary" :disabled="deciding" @click="decision=null">取消</button>
        <button class="btn btn--primary" :disabled="deciding" @click="confirmDecision">{{ deciding ? '处理中…' : '确认' + (decision.action === 'approved' ? '批准' : '拒绝') }}</button>
      </div>
    </section>
    <p v-if="decisionMessage" class="sync-message" role="status">{{ decisionMessage }}</p>
    <p v-if="decisionError" class="sync-message" role="alert">{{ decisionError }}</p>
    <button v-if="refreshRequired" class="btn btn--secondary" :disabled="deciding" @click="refreshLists">刷新审批列表</button>

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

    <div class="mail-panel">
      <div class="user-block__title">邮件通知通道</div>
      <div class="mail-status-grid">
        <div><span>注册与审批邮件</span><strong>{{ mailStatus.mail?.configured && mailStatus.mail?.enabled ? '已就绪' : '待配置' }}</strong></div>
      </div>
      <p class="mail-tip">Cloudflare 继续负责 DNS；SMTP 仅用于注册验证、审批结果和系统告警。管理员可在“登录与系统集成”中配置，密码只写入服务器 Secret 文件且不会回显。</p>
      <a class="mail-config-link" href="/settings?category=system">配置系统通知</a>
      <div class="mail-test">
        <label>
          <span>测试收件地址</span>
          <input
            v-model="mailTestRecipient"
            type="email"
            autocomplete="email"
            placeholder="name@example.com"
          >
        </label>
        <button
          class="btn btn--secondary"
          type="button"
          :disabled="mailTestLoading || !mailStatus.mail?.configured || !mailStatus.mail?.enabled"
          @click="sendMailTest"
        >
          {{ mailTestLoading ? '排队中...' : '发送测试邮件' }}
        </button>
      </div>
      <p v-if="mailTestMessage" class="mail-test-message is-success">{{ mailTestMessage }}</p>
      <p v-if="mailTestError" class="mail-test-message is-error">{{ mailTestError }}</p>
    </div>

    <div class="user-block">
      <div class="user-block__title">待审批注册</div>
      <div v-if="pendingRequests.length" class="request-list">
        <div v-for="request in pendingRequests" :key="request.id" class="request-card">
          <div>
            <div class="request-card__name">{{ request.username }}</div>
            <div v-if="request.email" class="request-card__meta">邮箱：{{ request.email }}</div>
            <div class="request-card__meta">申请编号：{{ request.id }}</div>
            <div class="request-card__meta">提交时间：{{ formatDate(request.createdAt) }}</div>
          </div>
          <div class="request-card__actions">
            <button class="btn btn--secondary" :disabled="deciding" @click="selectDecision(request, 'rejected')">拒绝</button>
            <button class="btn btn--primary" :disabled="deciding" @click="selectDecision(request, 'approved')">批准</button>
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
          <span>{{ statusLabel(item.status) }}</span>
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
  min-height: 44px;
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
.decision-panel {display:grid;gap:12px;margin-top:16px;padding:18px;border:1px solid var(--accent-color);border-radius:16px;color:var(--text-primary);background:var(--bg-secondary)}
.decision-panel p {font-size:13px;line-height:1.7;color:var(--text-secondary)}
.decision-panel:focus {outline:2px solid var(--accent-color);outline-offset:3px}
.sync-message,.request-card__meta,.table__row {overflow-wrap:anywhere}

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

.mail-panel,
.user-block {
  margin-top: 20px;
}

.user-block__title {
  margin-bottom: 12px;
  color: var(--text-primary);
  font-weight: 600;
}

.mail-status-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.mail-status-grid > div {
  display: grid;
  min-height: 82px;
  padding: 14px;
  align-content: space-between;
  gap: 10px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 16px;
}

.mail-status-grid span {
  color: var(--text-muted);
  font-size: 12px;
}

.mail-status-grid strong {
  color: var(--text-primary);
  font-size: 14px;
}

.mail-tip {
  margin-top: 10px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.mail-config-link {
  display: inline-flex;
  min-height: 44px;
  margin-top: 8px;
  padding: 0 13px;
  align-items: center;
  color: var(--accent-color);
  font-size: 12px;
  font-weight: 650;
  text-decoration: none;
  background: color-mix(in srgb, var(--accent-color) 9%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--accent-color) 30%, var(--border-light));
  border-radius: 13px;
}

.mail-config-link:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent-color) 28%, transparent);
  outline-offset: 2px;
}

.mail-test {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  align-items: end;
  margin-top: 14px;
}

.mail-test label {
  display: grid;
  gap: 7px;
  color: var(--text-secondary);
  font-size: 12px;
}

.mail-test input {
  min-height: 44px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  padding: 10px 13px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  font: inherit;
}

.mail-test-message {
  margin: 10px 0 0;
  font-size: 12px;
}

.mail-test-message.is-success {
  color: var(--success-color, #4f8a5b);
}

.mail-test-message.is-error {
  color: var(--danger-color, #b45151);
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
  .request-card {
    flex-direction: column;
    align-items: stretch;
  }

  .summary-grid {
    grid-template-columns: 1fr;
  }

  .mail-status-grid {
    grid-template-columns: 1fr;
  }

  .mail-test {
    grid-template-columns: 1fr;
  }

  .table__head,
  .table__row {
    grid-template-columns: 1fr;
  }
}
</style>
