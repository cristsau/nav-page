<script setup>
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'
import { useAuth } from '@/shared/composables/useAuth'

const { currentUser } = useAuth()
const canManageMailAccounts = computed(() => currentUser.value?.role === 'admin')

defineProps({
  titleId: { type: String, default: 'mail-folders-title' },
  accounts: { type: Array, default: () => [] },
  folders: { type: Array, default: () => [] },
  activeAccountId: { type: String, default: '' },
  activeFolderId: { type: String, default: '' },
  loading: { type: Boolean, default: false }
})

const emit = defineEmits(['select-account', 'select-folder', 'manage-rules'])

function folderName(folder) {
  return folder?.displayName || folder?.name || folder?.path || '未命名文件夹'
}

function accountName(account) {
  return account?.label || account?.displayName || account?.address || account?.email || '邮箱账号'
}

function folderIcon(folder) {
  const specialUse = String(folder?.specialUse || folder?.special_use || '').toLowerCase()
  if (specialUse === 'inbox') return 'mail'
  if (specialUse === 'sent') return 'forward'
  if (specialUse === 'drafts') return 'edit'
  if (specialUse === 'archive' || specialUse === 'all') return 'archive'
  if (specialUse === 'trash' || specialUse === 'junk') return 'trash'
  if (specialUse === 'important' || specialUse === 'flagged') return 'star'
  return 'folder'
}
</script>

<template>
  <section class="mail-folders" :aria-labelledby="titleId">
    <header>
      <span class="mail-folders__icon" aria-hidden="true"><Icon name="mail" :size="18" /></span>
      <div>
        <h2 :id="titleId">邮箱</h2>
        <p>实时收件 · 安全外发</p>
      </div>
    </header>

    <label class="mail-account-select">
      <span>邮箱账号</span>
      <select
        :value="activeAccountId"
        :disabled="loading || accounts.length < 2"
        @change="emit('select-account', $event.target.value)"
      >
        <option v-for="account in accounts" :key="account.id" :value="account.id">
          {{ accountName(account) }}
        </option>
      </select>
    </label>
    <RouterLink
      v-if="canManageMailAccounts"
      class="mail-account-manage"
      to="/settings?category=system"
      aria-label="添加或管理邮箱账号"
    >
      <Icon name="plus" :size="16" />
      <span>{{ accounts.length < 2 ? '添加第二邮箱' : '管理邮箱账号' }}</span>
    </RouterLink>
    <p v-else class="mail-account-help">需要更多邮箱时，请联系管理员添加。</p>

    <nav aria-label="邮件文件夹" :aria-busy="loading">
      <h3 v-if="folders.length">邮件箱</h3>
      <p v-if="loading && !folders.length" role="status">正在读取文件夹…</p>
      <p v-else-if="!folders.length">当前邮箱还没有可显示的文件夹。</p>
      <ul v-else>
        <li v-for="folder in folders" :key="folder.id">
          <button
            type="button"
            :class="{ 'is-active': String(folder.id) === activeFolderId }"
            :aria-current="String(folder.id) === activeFolderId ? 'page' : undefined"
            :aria-label="`${folderName(folder)}${Number(folder.unreadCount || 0) ? `，${Number(folder.unreadCount)} 封未读` : ''}`"
            @click="emit('select-folder', String(folder.id))"
          >
            <Icon :name="folderIcon(folder)" :size="17" />
            <span>{{ folderName(folder) }}</span>
            <b v-if="Number(folder.unreadCount || 0)" aria-hidden="true">{{ Number(folder.unreadCount) > 999 ? '999+' : Number(folder.unreadCount) }}</b>
          </button>
        </li>
      </ul>
    </nav>

    <footer>
      <button type="button" class="mail-rules-entry" @click="emit('manage-rules')">
        <Icon name="bell" :size="17" />
        <span>
          <strong>提醒规则</strong>
          <small>发件人、类别与邮箱默认</small>
        </span>
        <Icon class="mail-rules-entry__chevron" name="chevron-down" :size="16" aria-hidden="true" />
      </button>
    </footer>
  </section>
</template>

<style scoped>
.mail-folders { display: flex; min-width: 0; height: 100%; padding: 16px 12px; overflow-y: auto; flex-direction: column; color: var(--text-primary); background: var(--bg-secondary); }
.mail-folders > header { display: flex; min-height: 54px; padding: 0 8px 12px; align-items: center; gap: 10px; }
.mail-folders__icon { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; color: var(--accent-color); background: var(--accent-bg); border-radius: 11px; }
.mail-folders h2 { margin: 0; font-size: .86rem; }
.mail-folders header p { margin: 2px 0 0; color: var(--text-muted); font-size: .65rem; }
.mail-account-select { display: grid; margin: 2px 4px 12px; gap: 5px; color: var(--text-muted); font-size: .65rem; }
.mail-account-select select { width: 100%; min-height: 44px; padding: 0 10px; color: var(--text-primary); font: inherit; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 12px; }
.mail-account-manage { display: flex; min-height: 44px; margin: -4px 4px 8px; padding: 0 10px; align-items: center; justify-content: center; gap: 7px; color: var(--accent-color); font-size: .68rem; font-weight: 700; text-decoration: none; background: var(--accent-bg); border: 1px solid color-mix(in srgb, var(--accent-color) 24%, var(--border-light)); border-radius: 12px; }
.mail-account-manage:hover, .mail-account-manage:focus-visible { outline: 2px solid color-mix(in srgb, var(--accent-color) 30%, transparent); outline-offset: 2px; }
.mail-account-help { margin: -2px 8px 8px; color: var(--text-muted); font-size: .6rem; line-height: 1.5; }
.mail-folders nav > p { padding: 18px 8px; color: var(--text-muted); font-size: .7rem; line-height: 1.6; }
.mail-folders nav > h3 { margin: 18px 9px 7px; color: var(--text-muted); font-size: .58rem; font-weight: 760; letter-spacing: .08em; text-transform: uppercase; }
.mail-folders ul { display: grid; margin: 0; padding: 0; gap: 3px; list-style: none; }
.mail-folders button { display: grid; width: 100%; min-height: 44px; padding: 0 10px; align-items: center; grid-template-columns: 20px minmax(0, 1fr) auto; gap: 8px; text-align: left; color: var(--text-secondary); font: inherit; font-size: .73rem; background: transparent; border: 1px solid transparent; border-radius: 11px; cursor: pointer; }
.mail-folders button span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.mail-folders button b { min-width: 23px; padding: 2px 6px; text-align: center; color: var(--accent-color); font-size: .6rem; background: var(--accent-bg); border-radius: 999px; }
.mail-folders button:hover,
.mail-folders button:focus-visible { color: var(--text-primary); background: var(--bg-hover); }
.mail-folders button.is-active { color: var(--accent-color); background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent-color) 22%, var(--border-light)); }
.mail-folders > footer { margin: auto 4px 0; padding-top: 18px; border-top: 1px solid var(--border-light); }
.mail-folders .mail-rules-entry { grid-template-columns: 20px minmax(0, 1fr) auto; color: var(--text-muted); }
.mail-rules-entry > span { display: grid; min-width: 0; gap: 2px; }
.mail-rules-entry strong { color: var(--text-secondary); font-size: .68rem; font-weight: 710; }
.mail-rules-entry small { overflow: hidden; color: var(--text-muted); font-size: .57rem; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.mail-rules-entry__chevron { transform: rotate(-90deg); }
</style>
