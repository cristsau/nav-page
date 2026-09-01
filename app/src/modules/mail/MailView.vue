<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import MailAiSearchDialog from './components/MailAiSearchDialog.vue'
import MailComposeDialog from './components/MailComposeDialog.vue'
import MailFolderSheet from './components/MailFolderSheet.vue'
import MailFolderSidebar from './components/MailFolderSidebar.vue'
import MailMessageDetail from './components/MailMessageDetail.vue'
import MailMessageList from './components/MailMessageList.vue'
import MailNotificationRuleDialog from './components/MailNotificationRuleDialog.vue'
import MailNotificationRulesManagerDialog from './components/MailNotificationRulesManagerDialog.vue'
import { fetchEmailStatus } from '@/shared/services/emailApi'
import { useMailStore } from './useMailStore'

const route = useRoute()
const router = useRouter()
const mail = useMailStore()
const { state, activeFolder, activeFolders, currentPage } = mail

const featureStatus = ref(null)
const initialLoading = ref(true)
const localError = ref('')
const folderSheetOpen = ref(false)
const composeOpen = ref(false)
const aiSearchOpen = ref(false)
const composeInitial = ref({})
const composeSourceMessageId = ref('')
const ruleDialogOpen = ref(false)
const rulesManagerOpen = ref(false)
const ruleMessage = ref(null)
const ruleNotice = ref('')
const lastMessageTrigger = ref(null)
const detailRef = ref(null)
let updatingRoute = false

const errorMessage = computed(() => localError.value || state.errorMessage)
const hasAccounts = computed(() => state.accounts.length > 0)
const hasLegacyDetail = computed(() => Boolean(state.selectedMessage?.legacyEvent))
const ingestConfigured = computed(() => Boolean(featureStatus.value?.ingest?.configured))
const ingestEnabled = computed(() => Boolean(featureStatus.value?.ingest?.enabled))
const detailOpen = computed(() => Boolean(state.selectedMessageId || state.loadingDetail))
const folderLabel = computed(() => activeFolder.value?.displayName || activeFolder.value?.name || activeFolder.value?.path || '收件箱')
const realtimeLabel = computed(() => {
  if (state.streamState === 'live') return '实时更新已连接'
  if (state.streamState === 'polling') return '实时连接中断，每分钟自动刷新'
  if (state.streamState === 'connecting') return '正在连接实时更新…'
  return ''
})
const mailboxNotice = computed(() => {
  if (!hasAccounts.value) return ''
  if (!featureStatus.value) return ''
  if (!ingestConfigured.value) return '当前邮箱连接不可用；已同步内容仍可只读查看。'
  if (!ingestEnabled.value) return '邮箱已配置，但后台自动同步当前处于关闭状态。'
  return ''
})
const activeAccountLabel = computed(() => {
  const account = state.accounts.find((item) => String(item.id) === state.activeAccountId)
  return account?.label || account?.displayName || account?.address || account?.email || '当前邮箱'
})
const selectedCommand = computed(() => (
  state.commandsByLocation?.[String(state.selectedMessageId || '')] || null
))
const syncRequesting = computed(() => state.syncState === 'requesting')
const syncNoticeClass = computed(() => (
  state.syncState === 'completed'
    ? 'is-success'
    : state.syncState === 'error' ? 'is-error' : 'is-info'
))

function queryText(value) {
  return Array.isArray(value) ? String(value[0] || '') : String(value || '')
}

function sameQuery(left, right) {
  const normalize = (value) => Object.keys(value).sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(queryText(value[key]))}`)
    .join('&')
  return normalize(left) === normalize(right)
}

async function replaceMailQuery({ messageId, legacyEventId } = {}) {
  const query = { ...route.query }
  if (state.activeAccountId) query.account = state.activeAccountId
  else delete query.account
  if (state.activeFolderId) query.folder = state.activeFolderId
  else delete query.folder

  if (legacyEventId) {
    query.email = legacyEventId
    delete query.message
  } else if (messageId) {
    query.message = messageId
    delete query.email
  } else {
    delete query.message
    delete query.email
  }
  if (sameQuery(query, route.query)) return
  updatingRoute = true
  try {
    await router.replace({ path: '/mail', query })
  } finally {
    updatingRoute = false
  }
}

async function loadLinkedDetail() {
  const legacyEventId = queryText(route.query.email)
  const messageId = queryText(route.query.message)
  if (legacyEventId) await mail.loadLegacyEvent(legacyEventId)
  else if (messageId && state.activeAccountId && state.activeFolderId) await mail.loadMessage(messageId)
}

async function initializeWorkspace() {
  initialLoading.value = true
  localError.value = ''
  state.errorMessage = ''
  try {
    const statusRequest = fetchEmailStatus()
      .then((payload) => { featureStatus.value = payload })
      .catch(() => {})
    await mail.initialize({
      accountId: queryText(route.query.account),
      folderId: queryText(route.query.folder)
    })
    await statusRequest
    await loadLinkedDetail()
    mail.startRealtime()
    await replaceMailQuery({
      messageId: queryText(route.query.message),
      legacyEventId: queryText(route.query.email)
    })
  } catch (error) {
    localError.value = error?.message || '邮箱工作区加载失败'
  } finally {
    initialLoading.value = false
  }
}

async function reloadWorkspace() {
  localError.value = ''
  state.errorMessage = ''
  const [nextStatus] = await Promise.all([
    fetchEmailStatus(),
    mail.refresh({ replace: true })
  ])
  featureStatus.value = nextStatus
}

async function refreshWorkspace() {
  localError.value = ''
  state.errorMessage = ''
  let syncError = null
  if (hasAccounts.value && state.activeAccountId) {
    try {
      await mail.requestSync()
    } catch (error) {
      syncError = error
    }
  }
  try {
    await reloadWorkspace()
  } catch (error) {
    localError.value = error?.message || '邮件刷新失败'
    return
  }
  if (syncError) {
    localError.value = `已刷新本地邮件，但未能请求服务器收信：${syncError?.message || '请求失败'}`
  }
}

async function chooseAccount(accountId) {
  localError.value = ''
  state.errorMessage = ''
  try {
    await mail.selectAccount(accountId)
    mail.startRealtime()
    folderSheetOpen.value = false
    await replaceMailQuery()
  } catch (error) {
    localError.value = error?.message || '邮箱账号切换失败'
  }
}

async function chooseFolder(folderId) {
  localError.value = ''
  state.errorMessage = ''
  try {
    await mail.selectFolder(folderId)
    folderSheetOpen.value = false
    await replaceMailQuery()
  } catch (error) {
    localError.value = error?.message || '邮件文件夹切换失败'
  }
}

async function openMessage(messageId, trigger) {
  lastMessageTrigger.value = trigger || null
  localError.value = ''
  state.errorMessage = ''
  try {
    const request = mail.loadMessage(messageId)
    await nextTick()
    focusMailDetail()
    await request
    await replaceMailQuery({ messageId })
    await nextTick()
    focusMailDetail()
  } catch (error) {
    localError.value = error?.message || '邮件详情加载失败'
  }
}

function focusMailDetail() {
  detailRef.value?.focusInitial?.()
}

async function openAiSearchSource(source) {
  const accountId = String(source?.accountId || '').trim()
  const folderId = String(source?.folderId || '').trim()
  const locationId = String(source?.locationId || '').trim()
  if (!accountId || !folderId || !locationId) {
    localError.value = '这个来源暂时没有可打开的邮箱位置。'
    return
  }
  aiSearchOpen.value = false
  localError.value = ''
  state.errorMessage = ''
  try {
    if (accountId !== state.activeAccountId) {
      await mail.selectAccount(accountId, { preferredFolderId: folderId })
      mail.startRealtime()
    } else if (folderId !== state.activeFolderId) {
      await mail.selectFolder(folderId)
    }
    await openMessage(locationId)
  } catch (error) {
    localError.value = error?.message || '邮件来源打开失败'
  }
}

async function closeMessage() {
  mail.clearSelection()
  await replaceMailQuery()
  await nextTick()
  lastMessageTrigger.value?.focus?.()
}

async function loadMore() {
  localError.value = ''
  state.errorMessage = ''
  try {
    await mail.loadMore()
  } catch (error) {
    localError.value = error?.message || '更多邮件加载失败'
  }
}

async function applyMailQuery(query) {
  localError.value = ''
  state.errorMessage = ''
  try {
    await mail.search(query)
  } catch (error) {
    localError.value = error?.message || '邮件搜索失败'
  }
}

function openCompose(initial = {}) {
  composeInitial.value = { ...initial }
  composeSourceMessageId.value = String(initial?.sourceMessageId || '').trim()
  composeOpen.value = true
}

function closeCompose() {
  composeOpen.value = false
  composeInitial.value = {}
  composeSourceMessageId.value = ''
}

function onDraftQueued() {
  void reloadWorkspace().catch(() => {})
}

function openNotificationRule(message) {
  ruleMessage.value = message || state.selectedMessage || null
  if (!ruleMessage.value) return
  ruleDialogOpen.value = true
}

function closeNotificationRule() {
  ruleDialogOpen.value = false
  ruleMessage.value = null
}

function onNotificationRuleSaved(rule) {
  ruleNotice.value = '邮件通知规则已启用；邮件仍会正常同步。'
  const action = String(rule?.action || '').trim()
  if (action && state.selectedMessage && ruleMessage.value) {
    state.selectedMessage.notificationAction = action
  }
  window.setTimeout(() => { ruleNotice.value = '' }, 5_000)
  void reloadWorkspace().catch(() => {})
}

async function openRulesManager() {
  folderSheetOpen.value = false
  await nextTick()
  rulesManagerOpen.value = true
}

function onRulesManagerChanged() {
  ruleNotice.value = '邮件提醒规则已更新；邮件仍会正常同步。'
  window.setTimeout(() => { ruleNotice.value = '' }, 5_000)
  void reloadWorkspace().catch(() => {})
}

async function runMessageCommand(payload) {
  localError.value = ''
  state.commandError = ''
  try {
    await mail.executeCommand(payload)
  } catch (error) {
    localError.value = error?.message || '邮件操作提交失败'
  }
}

async function undoMessageCommand() {
  localError.value = ''
  state.commandError = ''
  try {
    await mail.undoCommand()
  } catch (error) {
    localError.value = error?.message || '邮件操作撤销失败'
  }
}

watch(() => route.fullPath, async () => {
  if (updatingRoute || initialLoading.value) return
  const requestedAccountId = queryText(route.query.account)
  const requestedFolderId = queryText(route.query.folder)
  const previousAccountId = state.activeAccountId
  try {
    if (requestedAccountId && requestedAccountId !== state.activeAccountId) {
      await mail.selectAccount(requestedAccountId, { preferredFolderId: requestedFolderId })
    } else if (requestedFolderId && requestedFolderId !== state.activeFolderId) {
      await mail.selectFolder(requestedFolderId)
    }
    if (state.activeAccountId !== previousAccountId) mail.startRealtime()
    const legacyEventId = queryText(route.query.email)
    const messageId = queryText(route.query.message)
    if (legacyEventId && state.selectedMessageId !== `event:${legacyEventId}`) {
      await mail.loadLegacyEvent(legacyEventId)
    } else if (messageId && state.selectedMessageId !== messageId) {
      await mail.loadMessage(messageId)
    } else if (!legacyEventId && !messageId) {
      mail.clearSelection()
    }
  } catch (error) {
    localError.value = error?.message || '邮件深链接打开失败'
  }
}, { flush: 'post' })

watch(() => state.selectedMessageId, async (messageId, previousMessageId) => {
  if (messageId || !previousMessageId || !queryText(route.query.message)) return
  await replaceMailQuery()
})

onMounted(initializeWorkspace)
onBeforeUnmount(mail.deactivate)
</script>

<template>
  <main class="mail-page">
    <header class="mail-hero">
      <div>
        <span>智能邮箱</span>
        <h1>邮件</h1>
        <p>在一个工作区里完成实时收发、检索、会话阅读、通知降噪和 AI 分析。远端已读、重要、归档、移动与删除操作进入安全队列，冲突时不会覆盖新状态；永久删除与外发必须再次确认。</p>
      </div>
      <div class="mail-hero__actions">
        <button type="button" :disabled="!hasAccounts" aria-haspopup="dialog" @click="openCompose()">
          <Icon name="plus" :size="17" />
          <span>新建邮件</span>
        </button>
        <button type="button" :disabled="!hasAccounts" aria-haspopup="dialog" @click="aiSearchOpen = true">
          <Icon name="sparkles" :size="17" />
          <span>问整个邮箱</span>
        </button>
        <button
          type="button"
          :disabled="initialLoading || state.loadingMessages || syncRequesting"
          :aria-busy="syncRequesting"
          @click="refreshWorkspace"
        >
          <Icon name="refresh" :size="17" />
          <span>{{ syncRequesting ? '请求中…' : initialLoading || state.loadingMessages ? '读取中…' : '立即收信' }}</span>
        </button>
      </div>
    </header>

    <p v-if="errorMessage" class="mail-notice is-error" role="alert">{{ errorMessage }}</p>
    <p v-if="mailboxNotice" class="mail-notice is-warning" role="status">{{ mailboxNotice }}</p>
    <p v-if="ruleNotice" class="mail-notice is-success" role="status">{{ ruleNotice }}</p>
    <p v-if="state.syncNotice" :class="['mail-notice', syncNoticeClass]" role="status" aria-live="polite">{{ state.syncNotice }}</p>

    <section v-if="initialLoading" class="mail-loading" role="status" aria-label="正在加载邮箱工作区">
      <span></span><span></span><span></span>
    </section>

    <section v-else-if="!hasAccounts && !hasLegacyDetail" class="mail-setup">
      <span><Icon name="mail" :size="24" /></span>
      <div>
        <h2>{{ ingestConfigured ? '正在等待首次同步' : '还没有启用智能收件' }}</h2>
        <p v-if="ingestConfigured">邮箱已连接，但 DOMO NAV 还没有收录邮件；首次同步完成后会按文件夹显示在这里。</p>
        <p v-else>请先配置支持 IMAP 993 隐式 TLS 的邮箱并通过连接测试。密码只保存在服务器 Secret 文件中。</p>
      </div>
      <RouterLink to="/settings?category=system">配置邮件服务</RouterLink>
    </section>

    <section v-else :class="['mail-workspace', { 'is-detail-open': detailOpen, 'is-legacy-only': !hasAccounts }]" aria-label="邮箱工作区">
      <aside v-if="hasAccounts" class="mail-workspace__folders">
        <MailFolderSidebar
          :accounts="state.accounts"
          :folders="activeFolders"
          :active-account-id="state.activeAccountId"
          :active-folder-id="state.activeFolderId"
          :loading="state.loadingFolders"
          @select-account="chooseAccount"
          @select-folder="chooseFolder"
          @manage-rules="openRulesManager"
        />
      </aside>

      <div v-if="hasAccounts" class="mail-workspace__list">
        <MailMessageList
          :messages="currentPage.items"
          :selected-message-id="state.selectedMessageId"
          :folder-name="folderLabel"
          :loading="state.loadingMessages"
          :loading-more="state.loadingMore"
          :has-more="currentPage.hasMore"
          :realtime-label="realtimeLabel"
          @select="openMessage"
          @load-more="loadMore"
          @refresh="refreshWorkspace"
          @open-folders="folderSheetOpen = true"
          @compose="openCompose()"
          @notification="openNotificationRule"
          @query-change="applyMailQuery"
        />
      </div>

      <div class="mail-workspace__detail">
        <MailMessageDetail
          ref="detailRef"
          :message="state.selectedMessage"
          :message-id="state.selectedMessageId"
          :account-id="state.activeAccountId"
          :folder-id="state.activeFolderId"
          :location-id="state.selectedMessageId"
          :folders="activeFolders"
          :active-folder="activeFolder"
          :command="selectedCommand"
          :command-busy="state.commandBusy"
          :command-error="state.commandError"
          :loading="state.loadingDetail"
          @close="closeMessage"
          @reply="openCompose"
          @notification="openNotificationRule"
          @open-source="openAiSearchSource"
          @command="runMessageCommand"
          @undo-command="undoMessageCommand"
        />
      </div>
    </section>

    <MailFolderSheet
      :open="folderSheetOpen"
      :accounts="state.accounts"
      :folders="activeFolders"
      :active-account-id="state.activeAccountId"
      :active-folder-id="state.activeFolderId"
      :loading="state.loadingFolders"
      @close="folderSheetOpen = false"
      @select-account="chooseAccount"
      @select-folder="chooseFolder"
      @manage-rules="openRulesManager"
    />
    <MailComposeDialog
      :show="composeOpen"
      :account-id="state.activeAccountId"
      :source-message-id="composeSourceMessageId"
      :initial="composeInitial"
      @close="closeCompose"
      @queued="onDraftQueued"
    />
    <MailAiSearchDialog
      :open="aiSearchOpen"
      @close="aiSearchOpen = false"
      @open-source="openAiSearchSource"
    />
    <MailNotificationRuleDialog
      :open="ruleDialogOpen"
      :message="ruleMessage"
      :account-id="state.activeAccountId"
      @close="closeNotificationRule"
      @saved="onNotificationRuleSaved"
    />
    <MailNotificationRulesManagerDialog
      :open="rulesManagerOpen"
      :account-id="state.activeAccountId"
      :account-label="activeAccountLabel"
      @close="rulesManagerOpen = false"
      @changed="onRulesManagerChanged"
    />
  </main>
</template>

<style scoped>
.mail-page { min-height: calc(100vh - var(--app-shell-header-height, 64px)); padding: clamp(18px, 3vw, 34px) max(16px, calc((100vw - 1440px) / 2)) 92px; color: var(--text-primary); background: var(--bg-primary); }
.mail-hero { display: flex; margin-bottom: 18px; align-items: flex-end; justify-content: space-between; gap: 18px; }
.mail-hero > div > span { color: var(--accent-color); font-size: .66rem; font-weight: 760; letter-spacing: .08em; text-transform: uppercase; }
.mail-hero h1 { margin: 5px 0 0; font-size: clamp(1.5rem, 3vw, 2.15rem); }
.mail-hero p { max-width: 760px; margin: 8px 0 0; color: var(--text-muted); font-size: .75rem; line-height: 1.65; }
.mail-hero__actions { display: flex; gap: 8px; }
.mail-hero__actions button { display: inline-flex; min-width: 44px; min-height: 44px; padding: 0 13px; align-items: center; justify-content: center; gap: 7px; color: var(--text-secondary); font: inherit; font-size: .72rem; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 13px; cursor: pointer; }
.mail-hero__actions button:first-child { color: var(--accent-contrast, #fff); background: var(--accent-color); border-color: transparent; }
.mail-hero__actions button:disabled { opacity: .5; cursor: not-allowed; }
.mail-notice { margin: 0 0 14px; padding: 11px 13px; border-radius: 12px; font-size: .71rem; line-height: 1.55; }
.mail-notice.is-error { color: var(--error-color); background: color-mix(in srgb, var(--error-color) 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--error-color) 28%, transparent); }
.mail-notice.is-warning { color: var(--warning-color); background: color-mix(in srgb, var(--warning-color) 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--warning-color) 28%, transparent); }
.mail-notice.is-success { color: var(--success-color, #4c8a64); background: color-mix(in srgb, var(--success-color, #4c8a64) 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--success-color, #4c8a64) 28%, transparent); }
.mail-notice.is-info { color: var(--accent-color); background: var(--accent-bg); border: 1px solid color-mix(in srgb, var(--accent-color) 24%, transparent); }
.mail-loading { display: grid; min-height: min(690px, calc(100vh - 180px)); overflow: hidden; grid-template-columns: 220px 360px 1fr; gap: 1px; background: var(--border-light); border: 1px solid var(--border-light); border-radius: 21px; }
.mail-loading span { background: linear-gradient(105deg, var(--bg-card) 25%, var(--bg-hover) 40%, var(--bg-card) 55%); background-size: 240% 100%; animation: mail-shimmer 1.4s ease infinite; }
@keyframes mail-shimmer { to { background-position-x: -240%; } }
.mail-setup { display: grid; max-width: 800px; margin: 10vh auto 0; padding: 25px; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 17px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 20px; box-shadow: var(--shadow-card); }
.mail-setup > span { display: grid; width: 54px; height: 54px; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 17px; }
.mail-setup h2 { margin: 0; font-size: 1rem; }
.mail-setup p { margin: 7px 0 0; color: var(--text-muted); font-size: .72rem; line-height: 1.65; }
.mail-setup a { display: inline-flex; min-height: 44px; padding: 0 15px; align-items: center; justify-content: center; color: var(--accent-contrast, #fff); font-size: .72rem; font-weight: 700; text-decoration: none; background: var(--accent-color); border-radius: 13px; }
.mail-workspace { display: grid; height: min(720px, calc(100vh - 178px)); min-height: 560px; overflow: hidden; grid-template-columns: minmax(190px, 220px) minmax(300px, 360px) minmax(0, 1fr); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 21px; box-shadow: var(--shadow-card); }
.mail-workspace.is-legacy-only { grid-template-columns: minmax(0, 1fr); }
.mail-workspace__folders,
.mail-workspace__list,
.mail-workspace__detail { min-width: 0; min-height: 0; }
@media (min-width: 1180px) {
  .mail-workspace { height: min(780px, calc(100vh - 178px)); grid-template-columns: minmax(210px, 236px) minmax(350px, 400px) minmax(0, 1fr); }
}
@media (prefers-reduced-motion: reduce) {
  .mail-loading span { animation: none; }
}
@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .mail-page { padding: 15px 11px 96px; }
  .mail-hero { align-items: flex-start; }
  .mail-hero__actions button { width: 44px; padding: 0; }
  .mail-hero__actions button span { display: none; }
  .mail-loading { min-height: 520px; grid-template-columns: 1fr; }
  .mail-loading span:not(:first-child) { display: none; }
  .mail-setup { margin-top: 5vh; padding: 19px; grid-template-columns: auto minmax(0, 1fr); }
  .mail-setup a { grid-column: 1 / -1; }
  .mail-workspace { display: block; height: auto; min-height: 520px; overflow: visible; }
  .mail-workspace__folders { display: none; }
  .mail-workspace__list { display: block; min-height: 520px; }
  .mail-workspace__detail { display: none; }
  .mail-workspace.is-detail-open .mail-workspace__list { display: none; }
  .mail-workspace.is-detail-open .mail-workspace__detail { display: block; min-height: 520px; }
}
</style>
