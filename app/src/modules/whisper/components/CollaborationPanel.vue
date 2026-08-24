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
    if (!silent) loading.value = true
    try {
      const detail = await fetchCollaborationDetail(props.note.id)
      members.value = detail.members || []
      comments.value = detail.comments || []
      if (detail.offline && !silent) setMessage('当前离线，显示最后一次同步的协作信息')
    } catch (error) {
      if (!silent) setMessage(error.message || '加载协作信息失败')
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
  if (!username.value.trim() || working.value) return
  working.value = true
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
  if (working.value) return
  working.value = true
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
  if (!confirm(`移除协作者「${member.username}」？`)) return
  working.value = true
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
  if (!body || working.value) return
  working.value = true
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
  if (!canComment.value || working.value) return
  working.value = true
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
  if (!canEditComment(comment) || working.value) return
  editingCommentId.value = comment.id
  editingCommentBody.value = comment.body
}

function cancelEditComment() {
  editingCommentId.value = ''
  editingCommentBody.value = ''
}

async function saveEditedComment(comment) {
  const body = editingCommentBody.value.trim()
  if (!body || !canEditComment(comment) || working.value) return
  working.value = true
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
  if (!canDeleteComment(comment) || working.value) return
  if (!confirm('删除这条评论？')) return
  working.value = true
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
        <p>权限、评论和离线修改会在你的设备之间同步。</p>
      </div>
      <span class="collaboration__role">{{ accessRole }}</span>
    </header>

    <p v-if="note.encrypted" class="collaboration__notice">
      加密笔记保持本机私密，不上传协作者或评论数据。
    </p>
    <template v-else>
      <div v-if="canManageMembers" class="collaboration__invite">
        <input v-model="username" type="text" class="input" aria-label="协作者用户名" placeholder="输入已批准用户名" :disabled="disabled || working" @keydown.enter.prevent="invite">
        <select v-model="role" class="input" aria-label="协作者权限" :disabled="disabled || working">
          <option value="editor">可编辑</option>
          <option value="commenter">可评论</option>
          <option value="viewer">只读</option>
        </select>
        <button type="button" class="btn btn--secondary" :disabled="!username.trim() || disabled || working" @click="invite">
          <Icon name="plus" :size="15" /> 添加
        </button>
      </div>

      <div v-if="members.length" class="collaboration__members" aria-label="协作者列表">
        <div v-for="member in members" :key="member.userId" class="collaboration__member">
          <span class="collaboration__avatar" aria-hidden="true">{{ member.username.slice(0, 1).toUpperCase() }}</span>
          <strong>{{ member.username }}</strong>
          <select v-if="canManageMembers" :value="member.role" :aria-label="`${member.username} 的协作权限`" :disabled="working" @change="changeRole(member, $event.target.value)">
            <option value="editor">可编辑</option>
            <option value="commenter">可评论</option>
            <option value="viewer">只读</option>
          </select>
          <span v-else>{{ member.role }}</span>
          <button v-if="canManageMembers" type="button" aria-label="移除协作者" :disabled="working" @click="removeMember(member)"><Icon name="close" :size="14" /></button>
        </div>
      </div>

      <div class="collaboration__comments-header">
        <strong>评论 {{ comments.length }}</strong>
        <span class="collaboration__realtime" :class="`is-${realtimeStatus}`" aria-live="polite">
          <span aria-hidden="true"></span>{{ realtimeLabel }}
        </span>
        <label><input v-model="showResolved" type="checkbox"> 显示已解决</label>
      </div>
      <div v-if="visibleComments.length" class="collaboration__comments">
        <article v-for="comment in visibleComments" :key="comment.id" class="collaboration__comment" :class="{ 'is-resolved': comment.status === 'resolved' }">
          <header><strong>{{ comment.username || '离线用户' }}</strong><time>{{ new Date(comment.createdAt).toLocaleString('zh-CN') }}</time></header>
          <blockquote v-if="comment.selection?.text">{{ comment.selection.text }}</blockquote>
          <template v-if="editingCommentId === comment.id">
            <label class="sr-only" :for="`comment-edit-${comment.id}`">编辑 {{ comment.username }} 的评论</label>
            <textarea
              :id="`comment-edit-${comment.id}`"
              v-model="editingCommentBody"
              class="input collaboration__comment-edit"
              rows="3"
              maxlength="4000"
              :disabled="working"
              @keydown.escape.prevent="cancelEditComment"
              @keydown.ctrl.enter.prevent="saveEditedComment(comment)"
              @keydown.meta.enter.prevent="saveEditedComment(comment)"
            />
          </template>
          <p v-else>{{ comment.body }}</p>
          <footer>
            <template v-if="editingCommentId === comment.id">
              <button type="button" :disabled="working" @click="cancelEditComment">取消</button>
              <button type="button" :disabled="working || !editingCommentBody.trim()" @click="saveEditedComment(comment)">保存</button>
            </template>
            <template v-else>
              <button v-if="canEditComment(comment)" type="button" :disabled="working" @click="beginEditComment(comment)">编辑</button>
              <button v-if="canComment" type="button" :disabled="working" @click="toggleResolved(comment)">{{ comment.status === 'resolved' ? '重新打开' : '解决' }}</button>
              <button v-if="canDeleteComment(comment)" type="button" :disabled="working" @click="removeCommentItem(comment)">删除</button>
            </template>
          </footer>
        </article>
      </div>
      <p v-else-if="!loading" class="collaboration__empty">还没有评论；选中一段文字后可留下带上下文的评论。</p>

      <div v-if="canComment" class="collaboration__composer">
        <p v-if="selection?.text">将引用：{{ selection.text.slice(0, 100) }}</p>
        <textarea v-model="commentBody" class="input" rows="3" maxlength="4000" aria-label="评论正文" placeholder="写下评论…" :disabled="disabled || working" />
        <button type="button" class="btn btn--secondary" :disabled="!commentBody.trim() || disabled || working" @click="submitComment">发布评论</button>
      </div>
    </template>
    <p v-if="message" class="collaboration__message" role="status">{{ message }}</p>
  </section>
</template>

<style scoped>
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.collaboration { margin: 0 24px 18px; padding: 18px; border: 1px solid var(--border-light); border-radius: var(--radius-md); background: color-mix(in srgb, var(--bg-secondary) 72%, transparent); }
.collaboration__header, .collaboration__member, .collaboration__comments-header, .collaboration__comment header, .collaboration__comment footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.collaboration__header h4 { display: flex; align-items: center; gap: 8px; margin: 0; color: var(--text-primary); font-size: 14px; }
.collaboration__header p, .collaboration__empty, .collaboration__notice, .collaboration__message { margin: 5px 0 0; color: var(--text-muted); font-size: 12px; line-height: 1.55; }
.collaboration__role { padding: 5px 9px; border-radius: 999px; background: var(--accent-bg); color: var(--accent-color); font-size: 11px; }
.collaboration__invite { display: grid; grid-template-columns: minmax(180px, 1fr) 130px auto; gap: 8px; margin-top: 14px; }
.collaboration__invite .input { padding: 9px 11px; }
.collaboration__members { display: grid; gap: 7px; margin-top: 12px; }
.collaboration__member { min-height: 44px; padding: 7px 9px; border-radius: 10px; background: var(--bg-card); }
.collaboration__member strong { flex: 1; color: var(--text-primary); font-size: 12px; }
.collaboration__member select { color: var(--text-secondary); background: transparent; border: 0; }
.collaboration__member button { width: 32px; height: 32px; color: var(--text-muted); background: transparent; border: 0; border-radius: 8px; }
.collaboration__avatar { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 9px; background: var(--accent-bg); color: var(--accent-color); font-size: 11px; font-weight: 700; }
.collaboration__comments-header { flex-wrap: wrap; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border-light); color: var(--text-secondary); font-size: 12px; }
.collaboration__comments-header label { display: flex; align-items: center; gap: 6px; }
.collaboration__realtime { display: inline-flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: 11px; font-weight: 550; }
.collaboration__realtime > span { width: 7px; height: 7px; border-radius: 999px; background: var(--warning-color, #c7924c); }
.collaboration__realtime.is-connected > span { background: var(--success-color, #66a36c); }
.collaboration__realtime.is-offline > span,
.collaboration__realtime.is-access-changed > span { background: var(--danger-color, #c66); }
.collaboration__comments { display: grid; gap: 9px; margin-top: 10px; }
.collaboration__comment { padding: 12px; border-radius: 12px; background: var(--bg-card); }
.collaboration__comment.is-resolved { opacity: 0.68; }
.collaboration__comment header { color: var(--text-primary); font-size: 11px; }
.collaboration__comment time { color: var(--text-muted); }
.collaboration__comment blockquote { margin: 8px 0; padding: 7px 9px; border-left: 2px solid var(--accent-color); color: var(--text-muted); font-size: 11px; }
.collaboration__comment p { margin: 8px 0; color: var(--text-secondary); font-size: 13px; white-space: pre-wrap; }
.collaboration__comment-edit { width: 100%; margin: 9px 0; resize: vertical; }
.collaboration__comment footer { justify-content: flex-end; }
.collaboration__comment footer button { min-height: 32px; color: var(--accent-color); background: transparent; border: 0; }
.collaboration__composer { display: grid; justify-items: end; gap: 8px; margin-top: 12px; }
.collaboration__composer p { justify-self: stretch; margin: 0; color: var(--text-muted); font-size: 11px; }
.collaboration__composer textarea { resize: vertical; }
.collaboration__message { color: var(--accent-color); }
@media (max-width: 720px) { .collaboration { margin-inline: 14px; } .collaboration__invite { grid-template-columns: 1fr; } .collaboration__invite .btn { min-height: 44px; } }
</style>
