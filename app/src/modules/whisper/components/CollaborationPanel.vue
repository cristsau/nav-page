<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import {
  addCollaborator,
  addComment,
  deleteComment,
  fetchCollaborationDetail,
  removeCollaborator,
  resolveComment,
  updateComment,
  updateCollaborator
} from '@/shared/services/collaborationApi'
import { subscribeToCollaborationEvents } from '@/shared/services/collaborationEvents'
import { getCurrentUserId } from '@/shared/db/database'

const props = defineProps({
  note: { type: Object, required: true },
  selection: { type: Object, default: null },
  disabled: { type: Boolean, default: false }
})
const emit = defineEmits(['collaboration-enabled'])

const members = ref([])
const comments = ref([])
const loading = ref(false)
const working = ref(false)
const pendingAction = ref('')
const loadError = ref('')
const message = ref('')
const username = ref('')
const role = ref('editor')
const commentBody = ref('')
const showResolved = ref(false)
const editingCommentId = ref('')
const editingCommentBody = ref('')
const realtimeStatus = ref('idle')
let refreshTimer = null
let loadPromise = null
let stopRealtimeEvents = null
let realtimeRefreshPending = false

const accessRole = computed(() => props.note?.accessRole || 'owner')
const currentUserId = computed(() => String(getCurrentUserId() || ''))
const canManageMembers = computed(() => accessRole.value === 'owner' && !props.note?.encrypted)
const canComment = computed(() => ['owner', 'editor', 'commenter'].includes(accessRole.value) && !props.note?.encrypted)
const roleLabel = (value) => ({ owner: '所有者', editor: '可编辑', commenter: '可评论', viewer: '只读' }[value] || '只读')
const visibleComments = computed(() => comments.value.filter((comment) => (
  showResolved.value || comment.status !== 'resolved'
)))
const realtimeLabel = computed(() => ({
  connected: '实时已连接',
  connecting: '正在连接',
  reconnecting: '正在重连',
  offline: '离线模式',
  unsupported: '低频刷新',
  'access-changed': '权限已变更'
}[realtimeStatus.value] || '准备连接'))

function canEditComment(comment) {
  return canComment.value && (
    String(comment.userId || '') === currentUserId.value
    || ['owner', 'editor'].includes(accessRole.value)
  )
}

function canDeleteComment(comment) {
  return canComment.value && (
    accessRole.value === 'owner'
    || String(comment.userId || '') === currentUserId.value
  )
}

function setMessage(value) {
  message.value = value
  window.setTimeout(() => {
    if (message.value === value) message.value = ''
  }, 3200)
}

async function load({ silent = false } = {}) {
  if (!props.note?.id || props.note.encrypted) return
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    if (!silent) { loading.value = true; loadError.value = '' }
    try {
      const detail = await fetchCollaborationDetail(props.note.id)
      members.value = detail.members || []
      comments.value = detail.comments || []
      if (detail.offline && !silent) setMessage('当前离线，显示最后一次同步的协作信息')
    } catch (error) {
      if (!silent) loadError.value = error.message || '加载协作信息失败'
    } finally {
      if (!silent) loading.value = false
      loadPromise = null
    }
  })()
  return loadPromise
}

function refreshLiveComments() {
  if (
    document.visibilityState !== 'visible'
    || !navigator.onLine
    || working.value
    || editingCommentId.value
  ) {
    realtimeRefreshPending = true
    return
  }
  realtimeRefreshPending = false
  load({ silent: true })
}

function handleRealtimeEvent(event) {
  if (!['comment.upsert', 'comment.delete', 'member.upsert', 'member.delete', 'note.delete'].includes(event.eventKind)) return
  if (event.eventKind === 'note.delete') setMessage('这篇协作笔记已被删除')
  refreshLiveComments()
}

function connectRealtimeEvents() {
  stopRealtimeEvents?.()
  stopRealtimeEvents = null
  realtimeStatus.value = 'idle'
  if (!props.note?.id || props.note.encrypted) return
  stopRealtimeEvents = subscribeToCollaborationEvents(props.note.id, {
    onEvent: handleRealtimeEvent,
    onStatus: (status) => { realtimeStatus.value = status }
  })
}

async function invite() {
  if (!canManageMembers.value || props.disabled || !username.value.trim() || working.value) return
  working.value = true
  pendingAction.value = 'invite'
  try {
    const result = await addCollaborator(props.note.id, username.value.trim(), role.value)
    const index = members.value.findIndex((member) => member.userId === result.member.userId)
    if (index >= 0) members.value.splice(index, 1, result.member)
    else members.value.push(result.member)
    username.value = ''
    emit('collaboration-enabled')
    setMessage('协作者已更新')
  } catch (error) {
    setMessage(error.message || '添加协作者失败')
  } finally {
    working.value = false
  }
}

async function changeRole(member, nextRole) {
  if (!canManageMembers.value || props.disabled || working.value) return
  working.value = true
  pendingAction.value = `role:${member.userId}`
  try {
    const result = await updateCollaborator(props.note.id, member.userId, nextRole)
    Object.assign(member, result.member)
    setMessage('权限已更新')
  } catch (error) {
    setMessage(error.message || '更新权限失败')
  } finally {
    working.value = false
  }
}

async function removeMember(member) {
  if (!canManageMembers.value || props.disabled || working.value) return
  if (!confirm(`移除协作者「${member.username}」？`)) return
  working.value = true
  pendingAction.value = `member:${member.userId}`
  try {
    await removeCollaborator(props.note.id, member.userId)
    members.value = members.value.filter((item) => item.userId !== member.userId)
    setMessage('协作者已移除')
  } catch (error) {
    setMessage(error.message || '移除协作者失败')
  } finally {
    working.value = false
  }
}

async function submitComment() {
  const body = commentBody.value.trim()
  if (!canComment.value || props.disabled || !body || working.value) return
  working.value = true
  pendingAction.value = 'comment'
  try {
    const selection = props.selection?.text ? props.selection : null
    const result = await addComment(props.note.id, { body, selection })
    comments.value.push(result.comment)
    commentBody.value = ''
    setMessage(result.offline ? '评论已保存在本机，联网后自动同步' : '评论已发布')
  } catch (error) {
    setMessage(error.message || '发布评论失败')
  } finally {
    working.value = false
  }
}

async function toggleResolved(comment) {
  if (!canComment.value || props.disabled || working.value) return
  working.value = true
  pendingAction.value = `resolve:${comment.id}`
  try {
    const result = await resolveComment(props.note.id, comment.id, comment.status !== 'resolved')
    Object.assign(comment, result.comment)
  } catch (error) {
    setMessage(error.message || '更新评论状态失败')
  } finally {
    working.value = false
  }
}

function beginEditComment(comment) {
  if (!canEditComment(comment) || props.disabled || working.value) return
  editingCommentId.value = comment.id
  editingCommentBody.value = comment.body
}

function cancelEditComment() {
  editingCommentId.value = ''
  editingCommentBody.value = ''
}

async function saveEditedComment(comment) {
  const body = editingCommentBody.value.trim()
  if (!body || !canEditComment(comment) || props.disabled || working.value) return
  working.value = true
  pendingAction.value = `edit:${comment.id}`
  try {
    const result = await updateComment(props.note.id, comment.id, body)
    Object.assign(comment, result.comment)
    cancelEditComment()
    setMessage(result.offline ? '评论修改已保存在本机，联网后自动同步' : '评论已更新')
  } catch (error) {
    setMessage(error.message || '更新评论失败')
  } finally {
    working.value = false
  }
}

async function removeCommentItem(comment) {
  if (!canDeleteComment(comment) || props.disabled || working.value) return
  if (!confirm('删除这条评论？')) return
  working.value = true
  pendingAction.value = `delete:${comment.id}`
  try {
    await deleteComment(props.note.id, comment.id)
    comments.value = comments.value.filter((item) => item.id !== comment.id)
  } catch (error) {
    setMessage(error.message || '删除评论失败')
  } finally {
    working.value = false
  }
}

watch(
  [working, editingCommentId],
  ([isWorking, editingId]) => {
    if (!isWorking && !editingId && realtimeRefreshPending) refreshLiveComments()
  }
)
watch(
  [() => props.note?.id, () => props.note?.encrypted],
  () => {
    load()
    connectRealtimeEvents()
  },
  { immediate: true }
)
onMounted(() => {
  refreshTimer = window.setInterval(() => {
    if (realtimeStatus.value !== 'connected') refreshLiveComments()
  }, 30_000)
  window.addEventListener('focus', refreshLiveComments)
  window.addEventListener('domo-nav:offline-sync', refreshLiveComments)
  document.addEventListener('visibilitychange', refreshLiveComments)
})
onBeforeUnmount(() => {
  if (refreshTimer) window.clearInterval(refreshTimer)
  refreshTimer = null
  stopRealtimeEvents?.()
  stopRealtimeEvents = null
  window.removeEventListener('focus', refreshLiveComments)
  window.removeEventListener('domo-nav:offline-sync', refreshLiveComments)
  document.removeEventListener('visibilitychange', refreshLiveComments)
})
</script>

<template>
  <section class="collaboration" aria-labelledby="collaboration-title">
    <header class="collaboration__header">
      <div>
        <h4 id="collaboration-title"><Icon name="users" :size="17" /> 协作与评论</h4>
        <span class="collaboration__realtime" :class="`is-${realtimeStatus}`" aria-live="polite">
          <span aria-hidden="true"></span>{{ realtimeLabel }}
        </span>
      </div>
      <span class="collaboration__role">{{ roleLabel(accessRole) }}</span>
    </header>

    <p v-if="note.encrypted" class="collaboration__notice">
      <Icon name="lock" :size="18" /> 加密笔记保持私密，不上传协作者或评论。
    </p>
    <template v-else>
      <div class="collaboration__scroll">
        <details v-if="canManageMembers || members.length" class="collaboration__sharing">
          <summary><Icon name="share" :size="15" /><span>协作权限</span><small>{{ members.length }} 位协作者</small><Icon name="chevron-down" :size="14" /></summary>
          <p v-if="canManageMembers" class="collaboration__help">邀请已批准用户一起编辑或评论。</p>
          <div v-if="canManageMembers" class="collaboration__invite" :aria-busy="working && pendingAction === 'invite'">
            <input v-model="username" type="text" class="collaboration__input collaboration__username" aria-label="协作者用户名" placeholder="输入已批准用户名" :disabled="disabled || working" @keydown.enter.stop.prevent="invite">
            <select v-model="role" class="collaboration__input" aria-label="协作者权限" :disabled="disabled || working">
              <option value="editor">可编辑</option>
              <option value="commenter">可评论</option>
              <option value="viewer">只读</option>
            </select>
            <button type="button" class="collaboration__button" :disabled="!username.trim() || disabled || working" @click="invite">
              <span v-if="working && pendingAction === 'invite'" class="collaboration__spinner" aria-hidden="true"></span>
              <Icon v-else name="plus" :size="15" /> {{ working && pendingAction === 'invite' ? '添加中' : '添加' }}
            </button>
          </div>
          <div v-if="members.length" class="collaboration__members" aria-label="协作者列表">
            <div v-for="member in members" :key="member.userId" class="collaboration__member">
              <span class="collaboration__avatar" aria-hidden="true">{{ member.username.slice(0, 1).toUpperCase() }}</span>
              <strong>{{ member.username }}</strong>
              <select v-if="canManageMembers" class="collaboration__input" :value="member.role" :aria-label="`${member.username} 的协作权限`" :disabled="disabled || working" @change="changeRole(member, $event.target.value)">
                <option value="editor">可编辑</option><option value="commenter">可评论</option><option value="viewer">只读</option>
              </select>
              <span v-else>{{ roleLabel(member.role) }}</span>
              <button v-if="canManageMembers" type="button" class="collaboration__icon-button" aria-label="移除协作者" :disabled="disabled || working" @click="removeMember(member)"><Icon name="close" :size="14" /></button>
            </div>
          </div>
        </details>

        <div class="collaboration__comments-header">
          <strong>评论 <span>{{ visibleComments.length }}</span></strong>
          <label><input v-model="showResolved" type="checkbox"> 显示已解决</label>
        </div>
        <div v-if="loading" class="collaboration__empty" role="status">
          <span class="collaboration__spinner" aria-hidden="true"></span><p>正在加载评论…</p>
        </div>
        <div v-else-if="loadError" class="collaboration__empty is-error" role="alert">
          <Icon name="alert" :size="22" /><p>{{ loadError }}</p>
          <button type="button" class="collaboration__button" @click="load()">重新加载</button>
        </div>
        <div v-else-if="visibleComments.length" class="collaboration__comments">
          <article v-for="comment in visibleComments" :key="comment.id" class="collaboration__comment" :class="{ 'is-resolved': comment.status === 'resolved' }">
            <header><span class="collaboration__avatar" aria-hidden="true">{{ (comment.username || '离').slice(0, 1).toUpperCase() }}</span><div><strong>{{ comment.username || '离线用户' }}</strong><time>{{ new Date(comment.createdAt).toLocaleString('zh-CN') }}</time></div><Icon v-if="comment.status === 'resolved'" name="circle-check" :size="16" label="已解决" /></header>
            <blockquote v-if="comment.selection?.text">{{ comment.selection.text }}</blockquote>
            <template v-if="editingCommentId === comment.id">
              <label class="sr-only" :for="`comment-edit-${comment.id}`">编辑 {{ comment.username }} 的评论</label>
              <textarea :id="`comment-edit-${comment.id}`" v-model="editingCommentBody"
                class="collaboration__input collaboration__comment-edit" rows="3" maxlength="4000" :disabled="disabled || working"
                @keydown.escape.stop.prevent="cancelEditComment" @keydown.ctrl.enter.stop.prevent="saveEditedComment(comment)" @keydown.meta.enter.stop.prevent="saveEditedComment(comment)" />
            </template>
            <p v-else>{{ comment.body }}</p>
            <footer>
              <span v-if="working && pendingAction.endsWith(':' + comment.id)" class="collaboration__spinner" aria-label="处理中"></span>
              <template v-if="editingCommentId === comment.id">
                <button type="button" :disabled="disabled || working" @click="cancelEditComment">取消</button>
                <button type="button" :disabled="disabled || working || !editingCommentBody.trim()" @click="saveEditedComment(comment)">{{ working && pendingAction === 'edit:' + comment.id ? '保存中' : '保存' }}</button>
              </template>
              <template v-else>
                <button v-if="canEditComment(comment)" type="button" :disabled="disabled || working" @click="beginEditComment(comment)">编辑</button>
                <button v-if="canComment" type="button" :disabled="disabled || working" @click="toggleResolved(comment)">{{ comment.status === 'resolved' ? '重新打开' : '解决' }}</button>
                <button v-if="canDeleteComment(comment)" type="button" class="collaboration__delete" :disabled="disabled || working" @click="removeCommentItem(comment)">删除</button>
              </template>
            </footer>
          </article>
        </div>
        <div v-else class="collaboration__empty">
          <Icon name="quote" :size="24" />
          <strong>{{ comments.length ? '暂时没有未解决的评论' : '讨论，从这里开始' }}</strong>
          <p>{{ comments.length ? '打开“显示已解决”查看历史讨论。' : '写下想法，也可以选中正文中的文字，留下带引用的评论。' }}</p>
        </div>
      </div>

      <div v-if="canComment" class="collaboration__composer" :aria-busy="working && pendingAction === 'comment'">
        <p v-if="selection?.text" class="collaboration__quote"><Icon name="quote" :size="13" />{{ selection.text.slice(0, 100) }}</p>
        <label class="sr-only" for="note-comment-body">评论正文</label>
        <textarea id="note-comment-body" v-model="commentBody" class="collaboration__input" rows="3" maxlength="4000"
          placeholder="写下评论…" :disabled="disabled || working"
          @keydown.ctrl.enter.stop.prevent="submitComment" @keydown.meta.enter.stop.prevent="submitComment" />
        <div class="collaboration__composer-actions">
          <span>Ctrl / ⌘ + Enter 发送</span>
          <button type="button" class="collaboration__button collaboration__button--primary" :disabled="!commentBody.trim() || disabled || working" @click="submitComment">
            <span v-if="working && pendingAction === 'comment'" class="collaboration__spinner" aria-hidden="true"></span>
            <Icon v-else name="reply" :size="15" />{{ working && pendingAction === 'comment' ? '发布中…' : '发布评论' }}
          </button>
        </div>
      </div>
      <p v-else class="collaboration__notice">当前为只读权限，可以查看评论。</p>
    </template>
    <p v-if="message" class="collaboration__message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.collaboration { display: flex; flex-direction: column; width: 100%; min-height: 0; color: var(--text-primary); font-size: 13px; }
.collaboration__header { display: flex; flex: 0 0 auto; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 22px 20px 18px; border-bottom: 1px solid var(--border-light); }
.collaboration__header h4 { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; font-size: 14px; font-weight: 650; }
.collaboration__role { padding: 4px 8px; border: 1px solid var(--border-light); border-radius: 6px; color: var(--text-secondary); font-size: 11px; white-space: nowrap; }
.collaboration__scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 0 20px 16px; }
.collaboration__sharing { border-bottom: 1px solid var(--border-light); padding-block: 8px 12px; }
.collaboration__sharing summary { display: flex; align-items: center; min-height: 40px; gap: 7px; cursor: pointer; list-style: none; }
.collaboration__sharing summary::-webkit-details-marker { display: none; }
.collaboration__sharing summary small { margin-left: auto; color: var(--text-muted); font-size: 11px; }
.collaboration__sharing[open] summary > :last-child { transform: rotate(180deg); }
.collaboration__help { margin: 2px 0 10px; color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.collaboration__input { box-sizing: border-box; width: 100%; min-width: 0; min-height: 40px; padding: 9px 11px; border: 1px solid var(--border-light); border-radius: 9px; color: var(--text-primary); background: var(--bg-card); font: inherit; line-height: 1.5; }
.collaboration__input::placeholder { color: var(--text-muted); }
.collaboration textarea { display: block; resize: vertical; max-height: 180px; }
.collaboration__invite { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.collaboration__username { grid-column: 1 / -1; }
.collaboration__button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; padding: 8px 13px; border: 1px solid var(--border-light); border-radius: 9px; color: var(--text-primary); background: var(--bg-card); font: inherit; font-weight: 550; white-space: nowrap; cursor: pointer; transition: background .15s ease; }
.collaboration__button:hover:not(:disabled) { background: var(--bg-hover); }
.collaboration__button--primary { min-width: 106px; background: var(--accent-color); border-color: var(--accent-color); color: #fff; }
.collaboration__button--primary:hover:not(:disabled) { background: var(--accent-hover, var(--accent-color)); }
.collaboration :is(button, input, textarea, select):disabled { opacity: .5; cursor: not-allowed; }
.collaboration :is(button, input, textarea, select, summary):focus-visible { outline: 2px solid var(--accent-color); outline-offset: 3px; }
.collaboration__members { display: grid; gap: 10px; margin-top: 12px; }
.collaboration__member { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto 32px; align-items: center; gap: 6px; }
.collaboration__member strong { min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
.collaboration__member select { padding-inline: 4px; font-size: 11px; }
.collaboration__icon-button { display: grid; place-items: center; width: 32px; height: 36px; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }
.collaboration__avatar { display: grid; width: 28px; height: 28px; flex: 0 0 auto; place-items: center; border-radius: 9px; color: var(--accent-color); background: var(--accent-bg); font-size: 11px; font-weight: 650; }
.collaboration__comments-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 18px 0 10px; color: var(--text-secondary); font-size: 12px; }
.collaboration__comments-header strong span { margin-left: 5px; color: var(--text-muted); font-weight: 400; }
.collaboration__comments-header label { display: flex; align-items: center; gap: 5px; min-height: 28px; font-size: 11px; cursor: pointer; }
.collaboration input[type='checkbox'] { width: 15px; height: 15px; margin: 0; accent-color: var(--accent-color); }
.collaboration__realtime { display: inline-flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: 11px; }
.collaboration__realtime > span { width: 6px; height: 6px; border-radius: 50%; background: var(--warning-color, #b47e3f); }
.collaboration__realtime.is-connected > span { background: var(--success-color, #548569); }
.collaboration__realtime.is-offline > span, .collaboration__realtime.is-access-changed > span { background: var(--text-muted); }
.collaboration__comments { display: grid; gap: 12px; padding-top: 6px; }
.collaboration__comment { min-width: 0; padding: 12px; border: 1px solid var(--border-light); border-radius: 11px; background: var(--bg-card); }
.collaboration__comment.is-resolved { background: transparent; }
.collaboration__comment header { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.collaboration__comment header > div { min-width: 0; flex: 1; }
.collaboration__comment header strong { overflow-wrap: anywhere; }
.collaboration__comment time { display: block; margin-top: 3px; color: var(--text-muted); font-size: 10px; }
.collaboration__comment blockquote, .collaboration__quote { margin: 10px 0; padding: 8px 10px; border-left: 2px solid var(--accent-color); background: var(--accent-bg); color: var(--text-secondary); font-size: 12px; overflow-wrap: anywhere; }
.collaboration__comment p { margin: 12px 0 4px; color: var(--text-secondary); line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.collaboration__comment-edit { margin-block: 10px; }
.collaboration__comment footer { display: flex; align-items: center; justify-content: flex-end; gap: 4px; padding-top: 4px; }
.collaboration__comment footer button { min-height: 32px; padding: 4px 6px; border: 0; border-radius: 6px; color: var(--text-secondary); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
.collaboration__comment footer button:hover:not(:disabled) { background: var(--bg-secondary); color: var(--accent-color); }
.collaboration__comment footer .collaboration__delete:hover:not(:disabled) { color: var(--error-color); }
.collaboration__empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 180px; padding: 26px 12px; text-align: center; color: var(--text-muted); }
.collaboration__empty strong { color: var(--text-secondary); font-size: 13px; font-weight: 550; }
.collaboration__empty p { max-width: 250px; margin: 0; font-size: 12px; line-height: 1.7; overflow-wrap: anywhere; }
.collaboration__empty.is-error { color: var(--error-color); }
.collaboration__composer { flex: 0 0 auto; display: grid; gap: 10px; padding: 16px 20px; border-top: 1px solid var(--border-light); background: var(--bg-card); }
.collaboration__composer textarea { width: 100%; min-height: 92px; background: color-mix(in srgb, var(--bg-secondary) 45%, var(--bg-card)); }
.collaboration__quote { display: flex; gap: 6px; margin: 0; max-height: 90px; overflow: auto; }
.collaboration__composer-actions { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.collaboration__composer-actions > span { color: var(--text-muted); font-size: 10px; }
.collaboration__message { margin: 0; padding: 0 20px 14px; color: var(--accent-color); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; background: var(--bg-card); }
.collaboration__notice { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: 20px; color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.collaboration__spinner { width: 14px; height: 14px; flex: 0 0 auto; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: collaboration-spin .8s linear infinite; }
@keyframes collaboration-spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) {
  .collaboration__button, .collaboration__icon-button, .collaboration__comment footer button { min-height: 44px; }
  .collaboration__input { font-size: 16px; }
  .collaboration__member { grid-template-columns: 28px minmax(0, 1fr) auto 36px; }
}
@media (prefers-reduced-motion: reduce) { .collaboration__spinner { animation: none; } .collaboration__button { transition: none; } }
</style>
