<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import {
  fetchEmailEvent,
  fetchEmailEvents,
  fetchEmailStatus
} from '@/shared/services/emailApi'

const route = useRoute()
const router = useRouter()
const status = ref(null)
const emails = ref([])
const selectedEmail = ref(null)
const search = ref('')
const tier = ref(0)
const loading = ref(true)
const detailLoading = ref(false)
const errorMessage = ref('')

const filters = Object.freeze([
  { value: 0, label: '全部' },
  { value: 1, label: '立即核对' },
  { value: 2, label: '今日处理' },
  { value: 3, label: '仅归档' }
])

const mailboxConfigured = computed(() => Boolean(status.value?.ingest?.configured))
const mailboxEnabled = computed(() => Boolean(status.value?.ingest?.enabled))
const mailboxAvailable = computed(() => mailboxConfigured.value || emails.value.length > 0)
const mailboxNotice = computed(() => {
  if (loading.value) return ''
  if (!mailboxConfigured.value && emails.value.length) {
    return '当前邮件连接不可用；以下历史邮件仍可只读查看，恢复配置后会继续同步。'
  }
  if (mailboxConfigured.value && !mailboxEnabled.value) {
    return '邮件连接已配置，但自动同步当前处于关闭状态；现有邮件仍可只读查看。'
  }
  return ''
})
const filteredEmails = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase('zh-CN')
  return emails.value.filter((email) => {
    if (tier.value && Number(email.tier) !== tier.value) return false
    if (!needle) return true
    return [
      email.subject,
      email.senderName,
      email.senderAddress,
      email.reason,
      email.suggestedAction,
      email.bodyPreview
    ].join(' ').toLocaleLowerCase('zh-CN').includes(needle)
  })
})
const hasFilters = computed(() => Boolean(search.value.trim() || tier.value))

function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)
}

function senderLabel(email) {
  return email?.senderName || email?.senderAddress || '未知发件人'
}

function tierLabel(value) {
  return filters.find((item) => item.value === Number(value))?.label || `Tier ${value}`
}

async function loadEmailDetail(emailId, { updateUrl = true } = {}) {
  if (!emailId) {
    selectedEmail.value = null
    return
  }
  detailLoading.value = true
  errorMessage.value = ''
  try {
    selectedEmail.value = await fetchEmailEvent(emailId)
    if (updateUrl) {
      await router.replace({
        path: '/mail',
        query: { ...route.query, email: emailId }
      })
    }
  } catch (error) {
    errorMessage.value = error.message || '邮件详情加载失败'
  } finally {
    detailLoading.value = false
  }
}

async function closeDetail() {
  selectedEmail.value = null
  const query = { ...route.query }
  delete query.email
  await router.replace({ path: '/mail', query })
}

async function loadMailbox() {
  loading.value = true
  errorMessage.value = ''
  try {
    const [nextStatus, nextEmails] = await Promise.all([
      fetchEmailStatus(),
      fetchEmailEvents({ limit: 100 })
    ])
    status.value = nextStatus
    emails.value = nextEmails
    const linkedId = String(route.query.email || '')
    if (linkedId) await loadEmailDetail(linkedId, { updateUrl: false })
  } catch (error) {
    errorMessage.value = error.message || '邮件读取失败'
  } finally {
    loading.value = false
  }
}

watch(() => route.query.email, (value) => {
  const emailId = String(value || '')
  if (!emailId) {
    selectedEmail.value = null
  } else if (selectedEmail.value?.id !== emailId && !loading.value) {
    void loadEmailDetail(emailId, { updateUrl: false })
  }
})

onMounted(loadMailbox)
</script>

<template>
  <main class="mail-page">
    <header class="mail-hero">
      <div>
        <span class="mail-eyebrow">智能收件</span>
        <h1>邮件</h1>
        <p>查看 DOMO NAV 已安全接入并分类的邮件。当前为只读视图，不会删除、移动或回复原邮箱中的邮件。</p>
      </div>
      <button type="button" :disabled="loading" @click="loadMailbox">
        <Icon name="refresh" :size="17" />
        <span>{{ loading ? '读取中…' : '刷新' }}</span>
      </button>
    </header>

    <p v-if="errorMessage" class="mail-notice is-error" role="alert">{{ errorMessage }}</p>
    <p v-if="mailboxNotice" class="mail-notice is-warning" role="status">{{ mailboxNotice }}</p>
    <section v-if="!loading && !mailboxAvailable" class="mail-setup">
      <span><Icon name="mail" :size="24" /></span>
      <div>
        <h2>还没有启用智能收件</h2>
        <p>管理员需要先配置支持 IMAP 的邮箱并通过连接测试。密码只保存在服务器 Secret 文件中，不会回显到页面。</p>
      </div>
      <RouterLink to="/settings?category=system">配置邮件服务</RouterLink>
    </section>

    <section v-else class="mail-workspace">
      <aside class="mail-list" aria-label="邮件列表">
        <div class="mail-toolbar">
          <label class="mail-search">
            <Icon name="search" :size="16" />
            <input v-model="search" type="search" aria-label="搜索已接入邮件" placeholder="搜索标题、发件人或判断原因">
          </label>
          <div class="mail-filters" aria-label="按处理级别筛选">
            <button
              v-for="item in filters"
              :key="item.value"
              type="button"
              :class="{ 'is-active': tier === item.value }"
              @click="tier = item.value"
            >
              {{ item.label }}
            </button>
          </div>
        </div>

        <p v-if="loading" class="mail-empty">正在读取邮件…</p>
        <p v-else-if="!emails.length" class="mail-empty">
          邮箱已连接，但 DOMO NAV 还没有收录邮件。首次同步完成后会显示在这里。
        </p>
        <p v-else-if="!filteredEmails.length" class="mail-empty">
          没有符合当前筛选条件的邮件。<button v-if="hasFilters" type="button" @click="search = ''; tier = 0">清除筛选</button>
        </p>
        <div v-else class="mail-items">
          <button
            v-for="email in filteredEmails"
            :key="email.id"
            type="button"
            :class="['mail-item', `is-tier-${email.tier}`, { 'is-active': selectedEmail?.id === email.id }]"
            @click="loadEmailDetail(email.id)"
          >
            <span class="mail-item__meta">
              <strong>{{ senderLabel(email) }}</strong>
              <time>{{ formatDate(email.receivedAt) }}</time>
            </span>
            <span class="mail-item__subject">{{ email.subject || '(无主题)' }}</span>
            <span class="mail-item__preview">{{ email.reason || email.bodyPreview || '暂无摘要' }}</span>
            <span class="mail-item__tier">{{ tierLabel(email.tier) }}</span>
          </button>
        </div>
      </aside>

      <article class="mail-detail" aria-live="polite">
        <div v-if="detailLoading" class="mail-detail__empty">正在解密并读取邮件…</div>
        <div v-else-if="!selectedEmail" class="mail-detail__empty">
          <span><Icon name="mail" :size="28" /></span>
          <h2>选择一封邮件</h2>
          <p>这里会显示正文、分类原因和建议操作。</p>
        </div>
        <template v-else>
          <header class="mail-detail__header">
            <div>
              <span class="mail-detail__tier">{{ tierLabel(selectedEmail.tier) }} · {{ selectedEmail.urgency }}</span>
              <h2>{{ selectedEmail.subject || '(无主题)' }}</h2>
            </div>
            <button type="button" aria-label="关闭邮件详情" title="关闭" @click="closeDetail">
              <Icon name="close" :size="18" />
            </button>
          </header>
          <dl>
            <div><dt>发件人</dt><dd>{{ senderLabel(selectedEmail) }}<small v-if="selectedEmail.senderName">{{ selectedEmail.senderAddress }}</small></dd></div>
            <div><dt>接收时间</dt><dd>{{ formatDate(selectedEmail.receivedAt) }}</dd></div>
            <div><dt>判断原因</dt><dd>{{ selectedEmail.reason || '暂无' }}</dd></div>
            <div><dt>建议操作</dt><dd>{{ selectedEmail.suggestedAction || '暂无' }}</dd></div>
          </dl>
          <section class="mail-detail__body">
            <h3>正文</h3>
            <pre>{{ selectedEmail.body || '邮件正文为空' }}</pre>
          </section>
        </template>
      </article>
    </section>
  </main>
</template>

<style scoped>
.mail-page { min-height: calc(100vh - var(--app-shell-header-height, 64px)); padding: clamp(20px, 4vw, 44px) max(20px, calc((100vw - 1220px) / 2)) 92px; color: var(--text-primary); background: var(--bg-primary); }
.mail-hero { display: flex; margin-bottom: 22px; align-items: flex-end; justify-content: space-between; gap: 20px; }
.mail-eyebrow { color: var(--accent-color); font-size: .68rem; font-weight: 760; letter-spacing: .08em; text-transform: uppercase; }
.mail-hero h1 { margin: 5px 0 0; font-size: clamp(1.55rem, 3vw, 2.3rem); }
.mail-hero p { max-width: 720px; margin: 9px 0 0; color: var(--text-muted); font-size: .78rem; line-height: 1.7; }
.mail-hero > button, .mail-detail__header button { display: inline-flex; min-width: 44px; min-height: 44px; padding: 0 13px; align-items: center; justify-content: center; gap: 7px; color: var(--text-secondary); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 13px; cursor: pointer; }
.mail-hero > button:disabled { opacity: .5; cursor: not-allowed; }
.mail-notice { margin: 0 0 16px; padding: 12px 14px; border-radius: 13px; font-size: .75rem; }
.mail-notice.is-error { color: var(--error-color); background: color-mix(in srgb, var(--error-color) 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--error-color) 28%, transparent); }
.mail-notice.is-warning { color: var(--warning-color); background: color-mix(in srgb, var(--warning-color) 9%, var(--bg-card)); border: 1px solid color-mix(in srgb, var(--warning-color) 28%, transparent); }
.mail-setup { display: grid; max-width: 780px; margin: 10vh auto 0; padding: 26px; align-items: center; grid-template-columns: auto minmax(0, 1fr) auto; gap: 18px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 20px; box-shadow: var(--shadow-card); }
.mail-setup > span, .mail-detail__empty > span { display: grid; width: 54px; height: 54px; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 17px; }
.mail-setup h2, .mail-detail__empty h2 { margin: 0; font-size: 1rem; }
.mail-setup p, .mail-detail__empty p { margin: 7px 0 0; color: var(--text-muted); font-size: .74rem; line-height: 1.65; }
.mail-setup a { min-height: 44px; padding: 0 15px; display: inline-flex; align-items: center; color: var(--accent-contrast, #fff); font-size: .75rem; font-weight: 700; text-decoration: none; background: var(--accent-color); border-radius: 13px; }
.mail-workspace { display: grid; min-height: min(690px, calc(100vh - 190px)); overflow: hidden; grid-template-columns: minmax(300px, 390px) minmax(0, 1fr); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 22px; box-shadow: var(--shadow-card); }
.mail-list { min-width: 0; background: var(--bg-secondary); border-right: 1px solid var(--border-light); }
.mail-toolbar { position: sticky; top: 0; z-index: 2; padding: 14px; background: color-mix(in srgb, var(--bg-secondary) 95%, transparent); border-bottom: 1px solid var(--border-light); backdrop-filter: blur(14px); }
.mail-search { display: flex; min-height: 44px; padding: 0 12px; align-items: center; gap: 8px; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 13px; }
.mail-search input { min-width: 0; flex: 1; color: var(--text-primary); font: inherit; background: transparent; border: 0; outline: 0; }
.mail-search input::placeholder { color: var(--text-muted); }
.mail-filters { display: flex; margin-top: 9px; overflow-x: auto; gap: 5px; }
.mail-filters button { min-height: 36px; padding: 0 10px; flex: 0 0 auto; color: var(--text-muted); font: inherit; font-size: .67rem; font-weight: 680; background: transparent; border: 1px solid transparent; border-radius: 10px; cursor: pointer; }
.mail-filters button.is-active { color: var(--accent-color); background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent-color) 24%, var(--border-light)); }
.mail-items { max-height: calc(100vh - 285px); padding: 8px; overflow-y: auto; }
.mail-item { position: relative; display: grid; width: 100%; min-height: 126px; padding: 13px 13px 13px 16px; text-align: left; gap: 5px; color: var(--text-primary); background: transparent; border: 1px solid transparent; border-radius: 15px; cursor: pointer; }
.mail-item::before { position: absolute; top: 18px; bottom: 18px; left: 5px; width: 3px; content: ''; background: var(--border-color); border-radius: 99px; }
.mail-item.is-tier-1::before { background: var(--error-color); }
.mail-item.is-tier-2::before { background: var(--warning-color); }
.mail-item:hover, .mail-item:focus-visible { background: var(--bg-hover); outline: 0; }
.mail-item.is-active { background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent-color) 26%, var(--border-light)); }
.mail-item__meta { display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; color: var(--text-muted); font-size: .65rem; }
.mail-item__meta strong { min-width: 0; overflow: hidden; color: var(--text-secondary); white-space: nowrap; text-overflow: ellipsis; }
.mail-item__subject { overflow: hidden; font-size: .78rem; font-weight: 720; white-space: nowrap; text-overflow: ellipsis; }
.mail-item__preview { display: -webkit-box; overflow: hidden; color: var(--text-muted); font-size: .68rem; line-height: 1.5; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.mail-item__tier { width: fit-content; padding: 3px 7px; color: var(--text-muted); font-size: .61rem; background: var(--bg-card); border-radius: 999px; }
.mail-empty { padding: 28px 18px; color: var(--text-muted); text-align: center; font-size: .73rem; line-height: 1.7; }
.mail-empty button { color: var(--accent-color); font: inherit; background: transparent; border: 0; cursor: pointer; }
.mail-detail { min-width: 0; max-height: calc(100vh - 190px); overflow-y: auto; }
.mail-detail__empty { display: grid; min-height: 100%; place-content: center; justify-items: center; text-align: center; }
.mail-detail__empty > span { margin-bottom: 14px; }
.mail-detail__header { position: sticky; top: 0; z-index: 2; display: flex; min-height: 98px; padding: 20px clamp(18px, 4vw, 38px); align-items: flex-start; justify-content: space-between; gap: 18px; background: color-mix(in srgb, var(--bg-card) 95%, transparent); border-bottom: 1px solid var(--border-light); backdrop-filter: blur(14px); }
.mail-detail__header > div { min-width: 0; }
.mail-detail__header h2 { margin: 7px 0 0; overflow-wrap: anywhere; font-size: clamp(1rem, 2vw, 1.35rem); }
.mail-detail__tier { color: var(--accent-color); font-size: .67rem; font-weight: 730; }
.mail-detail dl { display: grid; margin: 0; padding: 22px clamp(18px, 4vw, 38px); grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px; border-bottom: 1px solid var(--border-light); }
.mail-detail dl div { display: grid; min-width: 0; gap: 5px; }
.mail-detail dt { color: var(--text-muted); font-size: .65rem; }
.mail-detail dd { display: grid; margin: 0; overflow-wrap: anywhere; color: var(--text-secondary); font-size: .75rem; line-height: 1.6; }
.mail-detail dd small { color: var(--text-muted); }
.mail-detail__body { padding: 22px clamp(18px, 4vw, 38px) 40px; }
.mail-detail__body h3 { margin: 0 0 14px; font-size: .78rem; }
.mail-detail__body pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font: inherit; font-size: .76rem; line-height: 1.8; }
@media (max-width: 820px), (pointer: coarse) and (max-width: 1024px) {
  .mail-page { padding: 16px 12px 92px; }
  .mail-hero { align-items: flex-start; }
  .mail-hero > button { width: 44px; padding: 0; }
  .mail-hero > button span { display: none; }
  .mail-setup { margin-top: 5vh; padding: 20px; grid-template-columns: auto minmax(0, 1fr); }
  .mail-setup a { grid-column: 1 / -1; justify-content: center; }
  .mail-workspace { min-height: auto; grid-template-columns: 1fr; overflow: visible; }
  .mail-list { border-right: 0; border-bottom: 1px solid var(--border-light); }
  .mail-items { max-height: 48vh; }
  .mail-detail { min-height: 420px; max-height: none; }
  .mail-detail dl { grid-template-columns: 1fr; }
}
</style>
