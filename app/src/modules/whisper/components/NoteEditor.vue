<script setup>
import { ref, watch, computed } from 'vue'
import { encrypt, hashPassword } from '@/shared/utils/crypto'
import Icon from '@/shared/components/Icon.vue'
import NoteAiPanel from './NoteAiPanel.vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  note: {
    type: Object,
    default: null
  },
  saving: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'save'])

// 表单数据
const formData = ref({
  type: 'memo',
  title: '',
  content: '',
  encrypted: false,
  password: '',
  confirmPassword: '',
  tags: [],
  entryDate: '',
  mood: '',
  dueAt: '',
  completed: false
})

// 标签输入
const tagInput = ref('')
const initialSnapshot = ref('')
const copiedId = ref(false)

// 是否编辑模式
const isEdit = computed(() => !!props.note?.id)

// 标题
const modalTitle = computed(() => {
  const typeLabel = (props.note?.type || formData.value.type) === 'memo' ? '备忘录' : '日记'
  if (isEdit.value) {
    return `编辑${typeLabel}`
  }
  return `新建${typeLabel}`
})

const contentCount = computed(() => formData.value.content.length)
const noteNumberLabel = computed(() => (
  props.note?.numberId ? `#${props.note.numberId}` : ''
))

function today() {
  const now = new Date()
  const offset = now.getTimezoneOffset() * 60_000
  return new Date(now.getTime() - offset).toISOString().slice(0, 10)
}

function toDateTimeLocal(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function currentSnapshot() {
  return JSON.stringify({
    ...formData.value,
    password: '',
    confirmPassword: ''
  })
}

// 监听显示状态，初始化表单
watch(() => props.show, (val) => {
  if (val) {
    if (props.note?.id) {
      formData.value = {
        type: props.note.type,
        title: props.note.title,
        content: props.note.encrypted && !props.note._unlocked ? '' : props.note.content,
        encrypted: props.note.encrypted,
        password: '',
        confirmPassword: '',
        tags: [...(props.note.tags || [])],
        entryDate: props.note.entryDate || today(),
        mood: props.note.mood || '',
        dueAt: toDateTimeLocal(props.note.dueAt),
        completed: Boolean(props.note.completed)
      }
    } else {
      resetForm(props.note?.type || 'memo')
    }
    initialSnapshot.value = currentSnapshot()
  }
})

function resetForm(type = 'memo') {
  formData.value = {
    type,
    title: '',
    content: '',
    encrypted: false,
    password: '',
    confirmPassword: '',
    tags: [],
    entryDate: today(),
    mood: '',
    dueAt: '',
    completed: false
  }
  tagInput.value = ''
}

// 添加标签
function addTag() {
  const tag = tagInput.value.trim()
  if (tag && !formData.value.tags.includes(tag)) {
    formData.value.tags.push(tag)
    tagInput.value = ''
  }
}

// 移除标签
function removeTag(index) {
  formData.value.tags.splice(index, 1)
}

async function copyNoteId() {
  if (!props.note?.numberId) return

  try {
    await navigator.clipboard.writeText(String(props.note.numberId))
    copiedId.value = true
    window.setTimeout(() => {
      copiedId.value = false
    }, 1800)
  } catch {
    alert('复制 ID 失败，请手动复制。')
  }
}

function insertAiText(text) {
  const current = formData.value.content.trimEnd()
  formData.value.content = current
    ? `${current}\n\n${text}`
    : text
}

function replaceAiText(text) {
  formData.value.content = text
}

function buildDefaultTitle() {
  const content = formData.value.content.trim()
  if (content) {
    return content.replace(/\s+/g, ' ').slice(0, 20)
  }

  const label = formData.value.type === 'diary' ? '日记' : '备忘录'
  const now = new Date()
  const timestamp = now.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })

  return `${label} ${timestamp}`
}

// 提交表单
async function handleSubmit() {
  if (props.saving) return

  let content = formData.value.content
  let passwordHash = ''
  const title = formData.value.title.trim() || buildDefaultTitle()

  // 如果需要加密
  if (formData.value.encrypted) {
    if (!formData.value.password) {
      alert('请设置加密密码')
      return
    }
    if (formData.value.password !== formData.value.confirmPassword) {
      alert('两次密码不一致')
      return
    }
    content = await encrypt(formData.value.content, formData.value.password)
    passwordHash = await hashPassword(formData.value.password)
  }

  emit('save', {
    type: formData.value.type,
    title,
    content,
    encrypted: formData.value.encrypted,
    password: passwordHash,
    tags: [...formData.value.tags],
    entryDate: formData.value.type === 'diary' ? formData.value.entryDate : '',
    mood: formData.value.type === 'diary' ? formData.value.mood : '',
    dueAt: formData.value.type === 'memo' && formData.value.dueAt
      ? new Date(formData.value.dueAt).toISOString()
      : null,
    completed: formData.value.type === 'memo' && formData.value.completed
  })
}

function close() {
  if (!props.saving && initialSnapshot.value && currentSnapshot() !== initialSnapshot.value) {
    if (!confirm('尚有未保存的修改，确定关闭吗？')) return
  }
  emit('close')
}
</script>

<template>
  <div v-if="show" class="editor-modal" @click.self="close">
    <div class="editor-content" role="dialog" aria-modal="true" :aria-label="modalTitle">
      <!-- 头部 -->
      <div class="editor__header">
        <div class="editor__heading">
          <h3 class="editor__title">{{ modalTitle }}</h3>
          <button
            v-if="noteNumberLabel"
            type="button"
            class="editor__note-id"
            :aria-label="`复制笔记数字 ID ${note.numberId}`"
            :title="copiedId ? '已复制' : '复制数字 ID'"
            @click="copyNoteId"
          >
            <Icon :name="copiedId ? 'circle-check' : 'copy'" :size="13" />
            {{ noteNumberLabel }}
          </button>
        </div>
        <button type="button" class="editor__close" aria-label="关闭编辑器" :disabled="saving" @click="close">
          <Icon name="close" :size="18" />
        </button>
      </div>

      <!-- 类型选择 -->
      <div class="editor__type">
        <label class="type-option" :class="{ 'is-active': formData.type === 'memo' }">
          <input v-model="formData.type" type="radio" value="memo" :disabled="saving">
          <span class="type-option__icon"><Icon name="list" :size="24" /></span>
          <span class="type-option__label">备忘录</span>
        </label>
        <label class="type-option" :class="{ 'is-active': formData.type === 'diary' }">
          <input v-model="formData.type" type="radio" value="diary" :disabled="saving">
          <span class="type-option__icon"><Icon name="book" :size="24" /></span>
          <span class="type-option__label">日记</span>
        </label>
      </div>

      <!-- 标题 -->
      <div class="form-group">
        <input
          v-model="formData.title"
          type="text"
          class="input"
          placeholder="标题"
          :disabled="saving"
        >
      </div>

      <div v-if="formData.type === 'diary'" class="form-row">
        <label class="form-group form-group--grow">
          <span class="form-label">日记日期</span>
          <input v-model="formData.entryDate" type="date" class="input" :disabled="saving">
        </label>
        <label class="form-group form-group--grow">
          <span class="form-label">心情</span>
          <select v-model="formData.mood" class="input" :disabled="saving">
            <option value="">未记录</option>
            <option value="平静">平静</option>
            <option value="开心">开心</option>
            <option value="充实">充实</option>
            <option value="疲惫">疲惫</option>
            <option value="低落">低落</option>
          </select>
        </label>
      </div>

      <div v-else class="form-row">
        <label class="form-group form-group--grow">
          <span class="form-label">截止时间（可选）</span>
          <input v-model="formData.dueAt" type="datetime-local" class="input" :disabled="saving">
        </label>
        <label v-if="isEdit" class="checkbox-label checkbox-label--status">
          <input v-model="formData.completed" type="checkbox" :disabled="saving">
          <span class="checkbox-custom"></span>
          <span>标记为已完成</span>
        </label>
      </div>

      <!-- 内容 -->
      <div class="form-group">
        <textarea
          v-model="formData.content"
          class="input editor__textarea"
          placeholder="写下你的想法..."
          rows="8"
          :disabled="saving"
        />
        <div class="editor__counter">{{ contentCount }} 字</div>
      </div>

      <NoteAiPanel
        :type="formData.type"
        :title="formData.title"
        :content="formData.content"
        :encrypted="formData.encrypted"
        :auto-open="Boolean(note?._openAi)"
        :disabled="saving"
        @insert="insertAiText"
        @replace="replaceAiText"
      />

      <!-- 标签 -->
      <div class="form-group">
        <div class="tags-input">
          <div class="tags-list">
            <span v-for="(tag, index) in formData.tags" :key="index" class="tag">
              {{ tag }}
              <button
                type="button"
                class="tag__remove"
                :aria-label="`移除标签 ${tag}`"
                :disabled="saving"
                @click="removeTag(index)"
              >
                <Icon name="close" :size="12" />
              </button>
            </span>
          </div>
          <input
            v-model="tagInput"
            type="text"
            class="input tags-input__field"
            placeholder="添加标签（回车添加）"
            :disabled="saving"
            @keydown.enter.prevent="addTag"
          >
        </div>
      </div>

      <!-- 加密选项 -->
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="formData.encrypted" :disabled="saving">
          <span class="checkbox-custom"></span>
          <span class="checkbox-label__text"><Icon name="lock" :size="16" /> 加密内容</span>
        </label>
      </div>

      <!-- 加密密码 -->
      <template v-if="formData.encrypted">
        <div class="form-group">
          <input
            v-model="formData.password"
            type="password"
            class="input"
            placeholder="设置密码"
            :disabled="saving"
          >
        </div>
        <div class="form-group">
          <input
            v-model="formData.confirmPassword"
            type="password"
            class="input"
            placeholder="确认密码"
            :disabled="saving"
          >
        </div>
      </template>

      <!-- 底部操作 -->
      <div class="editor__footer">
        <button type="button" class="btn btn--secondary" :disabled="saving" @click="close">取消</button>
        <button type="button" class="btn btn--primary" :disabled="saving" @click="handleSubmit">
          <span v-if="saving" class="button-spinner" aria-hidden="true"></span>
          {{ saving ? '保存中' : (isEdit ? '保存' : '创建') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.editor-content {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  width: 100%;
  max-width: 600px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow: var(--shadow-lg);
  animation: scaleIn 0.2s var(--ease-bounce);
}

@keyframes scaleIn {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.editor__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-light);
}

.editor__title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.editor__heading {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 9px;
}

.editor__note-id {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 8px;
  color: var(--text-muted);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 999px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}

.editor__note-id:hover {
  color: var(--accent-color);
  border-color: color-mix(in srgb, var(--accent-color) 50%, var(--border-light));
}

.editor__close {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.editor__close:hover {
  background: var(--bg-hover);
}

.editor__type {
  display: flex;
  gap: 12px;
  padding: 20px 24px;
}

.form-row {
  display: flex;
  gap: 12px;
  padding: 0 24px;
}

.form-row .form-group {
  padding: 0;
}

.form-group--grow {
  flex: 1;
}

.form-label {
  display: block;
  margin-bottom: 7px;
  color: var(--text-secondary);
  font-size: 12px;
}

.type-option {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.type-option:hover {
  background: var(--bg-hover);
}

.type-option.is-active {
  background: var(--accent-bg);
  box-shadow: 0 0 0 2px var(--accent-color);
}

.type-option input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.type-option:has(input:focus-visible) {
  outline: 3px solid color-mix(in srgb, var(--accent-color) 28%, transparent);
  outline-offset: 2px;
}

.type-option__icon {
  font-size: 28px;
  margin-bottom: 8px;
}

.type-option__label {
  font-size: 14px;
  color: var(--text-primary);
}

.form-group {
  padding: 0 24px;
  margin-bottom: 16px;
}

.input {
  width: 100%;
  padding: 12px 16px;
  font-size: 14px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 2px solid transparent;
  border-radius: var(--radius-md);
  outline: none;
  transition: all var(--transition-fast);
}

.input:focus {
  border-color: var(--accent-color);
  background: var(--bg-primary);
}

.editor__textarea {
  resize: vertical;
  min-height: 200px;
  line-height: 1.6;
}

.editor__counter {
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 12px;
  text-align: right;
}

/* 标签输入 */
.tags-input {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}

.tags-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  background: var(--accent-bg);
  color: var(--accent-color);
  border-radius: var(--radius-full);
  font-size: 12px;
}

.tag__remove {
  background: none;
  border: none;
  color: var(--accent-color);
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  line-height: 1;
}

.tags-input__field {
  flex: 1;
  min-width: 120px;
  padding: 4px 8px;
  background: transparent;
  border: none;
}

/* 复选框 */
.checkbox-label {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-primary);
}

.checkbox-label--status {
  align-self: center;
  flex: 0 0 auto;
  margin-bottom: 16px;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}

.checkbox-label__text {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.checkbox-label input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.checkbox-label input:focus-visible + .checkbox-custom {
  outline: 3px solid color-mix(in srgb, var(--accent-color) 28%, transparent);
  outline-offset: 2px;
}

.checkbox-custom {
  width: 20px;
  height: 20px;
  background: var(--bg-secondary);
  border-radius: var(--radius-xs);
  transition: all var(--transition-fast);
}

.checkbox-label input:checked + .checkbox-custom {
  background: var(--accent-color);
}

.checkbox-label input:checked + .checkbox-custom::after {
  content: '';
  width: 9px;
  height: 5px;
  display: block;
  margin: 5px auto 0;
  border-left: 2px solid #fff;
  border-bottom: 2px solid #fff;
  transform: rotate(-45deg);
}

/* 底部 */
.editor__footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 20px 24px;
  border-top: 1px solid var(--border-light);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px 24px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.btn--primary:hover {
  background: var(--accent-hover);
}

.btn--secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.btn--secondary:hover {
  background: var(--bg-hover);
}

.button-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: button-spin 0.8s linear infinite;
}

@keyframes button-spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 560px) {
  .editor-modal {
    align-items: flex-end;
    padding: 0;
  }

  .editor-content {
    max-height: 94vh;
    border-radius: 22px 22px 0 0;
  }

  .form-row {
    flex-direction: column;
    gap: 0;
  }

  .checkbox-label--status {
    align-self: stretch;
  }
}
</style>
