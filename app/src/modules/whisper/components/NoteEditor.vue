<script setup>
import { ref, watch, computed } from 'vue'
import { encrypt, hashPassword } from '@/shared/utils/crypto'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  note: {
    type: Object,
    default: null
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
  tags: []
})

// 标签输入
const tagInput = ref('')

// 是否编辑模式
const isEdit = computed(() => !!props.note)

// 标题
const modalTitle = computed(() => {
  if (isEdit.value) {
    return '编辑' + (props.note.type === 'memo' ? '备忘录' : '日记')
  }
  return '新建'
})

// 监听显示状态，初始化表单
watch(() => props.show, (val) => {
  if (val) {
    if (props.note) {
      formData.value = {
        type: props.note.type,
        title: props.note.title,
        content: props.note.encrypted ? '' : props.note.content,
        encrypted: props.note.encrypted,
        password: '',
        confirmPassword: '',
        tags: props.note.tags || []
      }
    } else {
      resetForm()
    }
  }
})

function resetForm() {
  formData.value = {
    type: 'memo',
    title: '',
    content: '',
    encrypted: false,
    password: '',
    confirmPassword: '',
    tags: []
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

// 提交表单
async function handleSubmit() {
  if (!formData.value.title.trim()) {
    alert('请输入标题')
    return
  }

  let content = formData.value.content
  let passwordHash = ''

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
    title: formData.value.title.trim(),
    content,
    encrypted: formData.value.encrypted,
    password: passwordHash,
    tags: formData.value.tags
  })

  resetForm()
}

function close() {
  emit('close')
}
</script>

<template>
  <div v-if="show" class="editor-modal" @click.self="close">
    <div class="editor-content">
      <!-- 头部 -->
      <div class="editor__header">
        <h3 class="editor__title">{{ modalTitle }}</h3>
        <button class="editor__close" @click="close">✕</button>
      </div>

      <!-- 类型选择 -->
      <div class="editor__type">
        <label class="type-option" :class="{ 'is-active': formData.type === 'memo' }">
          <input type="radio" value="memo" v-model="formData.type">
          <span class="type-option__icon">📋</span>
          <span class="type-option__label">备忘录</span>
        </label>
        <label class="type-option" :class="{ 'is-active': formData.type === 'diary' }">
          <input type="radio" value="diary" v-model="formData.type">
          <span class="type-option__icon">📖</span>
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
        >
      </div>

      <!-- 内容 -->
      <div class="form-group">
        <textarea
          v-model="formData.content"
          class="input editor__textarea"
          placeholder="写下你的想法..."
          rows="8"
        />
      </div>

      <!-- 标签 -->
      <div class="form-group">
        <div class="tags-input">
          <div class="tags-list">
            <span v-for="(tag, index) in formData.tags" :key="index" class="tag">
              {{ tag }}
              <button class="tag__remove" @click="removeTag(index)">×</button>
            </span>
          </div>
          <input
            v-model="tagInput"
            type="text"
            class="input tags-input__field"
            placeholder="添加标签（回车添加）"
            @keydown.enter.prevent="addTag"
          >
        </div>
      </div>

      <!-- 加密选项 -->
      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" v-model="formData.encrypted">
          <span class="checkbox-custom"></span>
          <span>🔒 加密内容</span>
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
          >
        </div>
        <div class="form-group">
          <input
            v-model="formData.confirmPassword"
            type="password"
            class="input"
            placeholder="确认密码"
          >
        </div>
      </template>

      <!-- 底部操作 -->
      <div class="editor__footer">
        <button class="btn btn--secondary" @click="close">取消</button>
        <button class="btn btn--primary" @click="handleSubmit">
          {{ isEdit ? '保存' : '创建' }}
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

.type-option {
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
  display: none;
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
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-primary);
}

.checkbox-label input {
  display: none;
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
  content: '✓';
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 12px;
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
</style>
