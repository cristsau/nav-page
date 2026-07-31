<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { encrypt, hashPassword } from '@/shared/utils/crypto'
import {
  MAX_NOTE_TAGS,
  mergeSuggestedNoteTags,
  normalizeNoteTag
} from '@/shared/utils/noteTags'
import {
  shouldUseBackendNotes,
  uploadBackendNoteImage
} from '@/shared/services/notesApi'
import Icon from '@/shared/components/Icon.vue'
import NoteAiPanel from './NoteAiPanel.vue'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_NOTE_IMAGES = 8
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

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
  completed: false,
  attachments: []
})

// 标签输入
const tagInput = ref('')
const tagMessage = ref('')
const tagMessageType = ref('')
const initialSnapshot = ref('')
const copiedId = ref(false)
const titleInputRef = ref(null)
const imageInputRef = ref(null)
const uploadingImage = ref(false)
const imageMessage = ref('')
const imageMessageType = ref('')

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
watch(() => props.show, async (val) => {
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
        completed: Boolean(props.note.completed),
        attachments: [...(props.note.attachments || [])]
      }
    } else {
      resetForm(props.note?.type || 'memo')
    }
    tagMessage.value = ''
    tagMessageType.value = ''
    imageMessage.value = ''
    imageMessageType.value = ''
    initialSnapshot.value = currentSnapshot()
    await nextTick()
    titleInputRef.value?.focus()
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
    completed: false,
    attachments: []
  }
  tagInput.value = ''
  tagMessage.value = ''
  tagMessageType.value = ''
  imageMessage.value = ''
  imageMessageType.value = ''
}

// 添加标签
function addTag() {
  const tag = normalizeNoteTag(tagInput.value)
  if (!tag) {
    tagMessage.value = '标签需为 1–32 个字符，且不能包含网址、网络地址、邮箱、密钥或敏感编号。'
    tagMessageType.value = 'error'
    return
  }

  if (formData.value.tags.length >= MAX_NOTE_TAGS) {
    tagMessage.value = `每条记录最多保留 ${MAX_NOTE_TAGS} 个标签。`
    tagMessageType.value = 'error'
    return
  }

  const duplicate = formData.value.tags.some(
    (item) => normalizeNoteTag(item).toLocaleLowerCase('zh-CN') === tag.toLocaleLowerCase('zh-CN')
  )
  if (duplicate) {
    tagMessage.value = '这个标签已经存在。'
    tagMessageType.value = 'error'
    return
  }

  formData.value.tags.push(tag)
  tagInput.value = ''
  tagMessage.value = '标签已加入编辑器，保存后生效。'
  tagMessageType.value = 'success'
}

// 移除标签
function removeTag(index) {
  formData.value.tags.splice(index, 1)
  tagMessage.value = ''
  tagMessageType.value = ''
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

function applyAiTags(tags) {
  const merged = mergeSuggestedNoteTags(formData.value.tags, tags)
  formData.value.tags = merged.tags

  if (!merged.added.length) {
    tagMessage.value = merged.limitReached
      ? `已达到 ${MAX_NOTE_TAGS} 个标签上限，没有添加新标签。`
      : 'AI 建议与现有标签重复，没有添加新标签。'
    tagMessageType.value = 'error'
    return
  }

  tagMessage.value = `已加入 ${merged.added.length} 个 AI 标签，保存记录后生效。`
  tagMessageType.value = 'success'
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

function formatImageSize(bytes) {
  const value = Number(bytes || 0)
  if (!value) return ''
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function chooseImages() {
  if (formData.value.encrypted) {
    imageMessage.value = '加密笔记暂不支持公开图床图片，避免正文加密但图片仍可公开访问。'
    imageMessageType.value = 'error'
    return
  }

  if (!shouldUseBackendNotes()) {
    imageMessage.value = '图片上传需要连接 NAV 服务端，密钥不会保存在浏览器。'
    imageMessageType.value = 'error'
    return
  }

  imageInputRef.value?.click()
}

async function handleImageUpload(event) {
  const files = [...(event.target.files || [])]
  event.target.value = ''
  if (!files.length || uploadingImage.value) return

  if (formData.value.attachments.length + files.length > MAX_NOTE_IMAGES) {
    imageMessage.value = `每条笔记最多添加 ${MAX_NOTE_IMAGES} 张图片。`
    imageMessageType.value = 'error'
    return
  }

  const invalid = files.find((file) => (
    !ALLOWED_IMAGE_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_IMAGE_BYTES
  ))
  if (invalid) {
    imageMessage.value = '仅支持 JPEG、PNG、WebP、GIF，单张图片不超过 10 MB。'
    imageMessageType.value = 'error'
    return
  }

  uploadingImage.value = true
  imageMessage.value = `正在上传 ${files.length} 张图片到个人图床…`
  imageMessageType.value = ''

  try {
    for (const file of files) {
      const attachment = await uploadBackendNoteImage(file)
      formData.value.attachments.push(attachment)
    }
    imageMessage.value = `已上传 ${files.length} 张图片，保存笔记后完成关联。`
    imageMessageType.value = 'success'
  } catch (error) {
    imageMessage.value = `图片上传失败：${error.message || '请稍后重试'}`
    imageMessageType.value = 'error'
  } finally {
    uploadingImage.value = false
  }
}

function removeImage(index) {
  formData.value.attachments.splice(index, 1)
  imageMessage.value = '已从笔记移除图片引用；图床原文件暂不自动删除。'
  imageMessageType.value = ''
}

function handleEncryptionToggle() {
  if (formData.value.encrypted && formData.value.attachments.length) {
    formData.value.encrypted = false
    imageMessage.value = '请先移除图片再启用加密；公开图床图片不具备笔记端到端加密。'
    imageMessageType.value = 'error'
  }
}

// 提交表单
async function handleSubmit() {
  if (props.saving || uploadingImage.value) return

  let content = formData.value.content
  let passwordHash = ''
  const title = formData.value.title.trim() || buildDefaultTitle()

  if (formData.value.encrypted && formData.value.attachments.length) {
    imageMessage.value = '加密笔记不能保存公开图床图片，请先移除图片。'
    imageMessageType.value = 'error'
    return
  }

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
    completed: formData.value.type === 'memo' && formData.value.completed,
    attachments: [...formData.value.attachments]
  })
}

function close() {
  if (uploadingImage.value) return
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
          ref="titleInputRef"
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

      <section class="form-group image-uploader" aria-labelledby="note-images-title">
        <div class="image-uploader__header">
          <div>
            <h4 id="note-images-title">图片附件</h4>
            <p>上传到 pic.skrskr.net，NAV 只保存图片链接，不占用 NAV 服务器磁盘。</p>
          </div>
          <button
            type="button"
            class="btn btn--secondary image-uploader__button"
            :disabled="saving || uploadingImage || formData.encrypted || formData.attachments.length >= MAX_NOTE_IMAGES"
            @click="chooseImages"
          >
            <span v-if="uploadingImage" class="button-spinner" aria-hidden="true"></span>
            <Icon v-else name="upload" :size="16" />
            {{ uploadingImage ? '上传中' : '添加图片' }}
          </button>
          <input
            ref="imageInputRef"
            class="image-uploader__input"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            multiple
            :disabled="saving || uploadingImage || formData.encrypted"
            @change="handleImageUpload"
          >
        </div>

        <div v-if="formData.attachments.length" class="image-uploader__grid">
          <article
            v-for="(image, index) in formData.attachments"
            :key="image.id || image.url"
            class="image-uploader__item"
          >
            <a :href="image.url" target="_blank" rel="noopener noreferrer" :aria-label="`打开图片 ${image.name || index + 1}`">
              <img :src="image.url" :alt="image.name || `笔记图片 ${index + 1}`" loading="lazy">
            </a>
            <div class="image-uploader__meta">
              <span :title="image.name">{{ image.name || `图片 ${index + 1}` }}</span>
              <small>{{ formatImageSize(image.size) }}</small>
            </div>
            <button
              type="button"
              class="image-uploader__remove"
              :aria-label="`从笔记移除 ${image.name || `图片 ${index + 1}`}`"
              :disabled="saving || uploadingImage"
              @click="removeImage(index)"
            >
              <Icon name="trash" :size="14" />
            </button>
          </article>
        </div>

        <p
          v-if="imageMessage"
          class="image-uploader__message"
          :class="`is-${imageMessageType}`"
          aria-live="polite"
        >
          {{ imageMessage }}
        </p>
        <p v-else-if="formData.encrypted" class="image-uploader__message is-error">
          加密笔记暂不开放图片上传，防止公开链接泄露图片内容。
        </p>
      </section>

      <NoteAiPanel
        :type="formData.type"
        :title="formData.title"
        :content="formData.content"
        :tags="formData.tags"
        :encrypted="formData.encrypted"
        :auto-open="Boolean(note?._openAi)"
        :disabled="saving"
        @insert="insertAiText"
        @replace="replaceAiText"
        @apply-tags="applyAiTags"
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
        <p
          v-if="tagMessage"
          class="tags-input__message"
          :class="`is-${tagMessageType}`"
          aria-live="polite"
        >
          {{ tagMessage }}
        </p>
      </div>

      <!-- 加密选项 -->
      <div class="form-group">
        <label class="checkbox-label">
          <input
            v-model="formData.encrypted"
            type="checkbox"
            :disabled="saving || uploadingImage"
            @change="handleEncryptionToggle"
          >
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

.image-uploader {
  padding: 16px 18px;
  background: color-mix(in srgb, var(--bg-secondary) 76%, transparent);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-md);
}

.image-uploader__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.image-uploader__header h4 {
  margin: 0 0 4px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
}

.image-uploader__header p {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.image-uploader__button {
  flex: 0 0 auto;
  padding: 9px 13px;
}

.image-uploader__button:disabled,
.image-uploader__remove:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.image-uploader__input {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  clip-path: inset(50%);
}

.image-uploader__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin-top: 14px;
}

.image-uploader__item {
  position: relative;
  min-width: 0;
  overflow: hidden;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 14px;
}

.image-uploader__item a {
  display: block;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--bg-secondary);
}

.image-uploader__item img {
  width: 100%;
  height: 100%;
  display: block;
  object-fit: cover;
  transition: transform var(--transition-normal) var(--ease-smooth);
}

.image-uploader__item:hover img {
  transform: scale(1.03);
}

.image-uploader__meta {
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 34px 8px 9px;
}

.image-uploader__meta span {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.image-uploader__meta small {
  margin-top: 2px;
  color: var(--text-muted);
  font-size: 10px;
}

.image-uploader__remove {
  position: absolute;
  right: 7px;
  bottom: 8px;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  color: var(--text-muted);
  background: var(--bg-secondary);
  border: 0;
  border-radius: 9px;
  cursor: pointer;
}

.image-uploader__remove:hover {
  color: #fff;
  background: var(--error-color);
}

.image-uploader__message {
  margin: 10px 0 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.image-uploader__message.is-success {
  color: var(--success-color);
}

.image-uploader__message.is-error {
  color: var(--error-color);
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

.tags-input__message {
  width: 100%;
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.5;
}

.tags-input__message.is-success {
  color: var(--success-color);
}

.tags-input__message.is-error {
  color: var(--error-color);
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

  .image-uploader__header {
    flex-direction: column;
  }

  .image-uploader__button {
    width: 100%;
  }

  .image-uploader__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .image-uploader__item img {
    transition: none;
  }

  .image-uploader__item:hover img {
    transform: none;
  }
}
</style>
