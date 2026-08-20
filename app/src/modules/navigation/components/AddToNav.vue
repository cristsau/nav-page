<script setup>
import { ref, computed, watch } from 'vue'
import Modal from '@/shared/components/Modal.vue'
import Button from '@/shared/components/Button.vue'
import Icon from '@/shared/components/Icon.vue'
import {
  MAX_NOTE_TAGS,
  normalizeNoteTag
} from '@/shared/utils/noteTags'
import { GROUP_ICON_OPTIONS, resolveGroupIcon } from '../navigationUi'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  mode: {
    type: String,
    default: 'bookmark' // bookmark | group
  },
  groups: {
    type: Array,
    default: () => []
  },
  editingItem: {
    type: Object,
    default: null
  },
  defaultGroupId: {
    type: String,
    default: ''
  },
  saving: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'submit'])

// 表单数据
const formData = ref({
  // 书签字段
  groupId: '',
  title: '',
  url: '',
  favicon: '',
  description: '',
  tags: [],
  // 分组字段
  name: '',
  icon: 'folder',
  color: '#a08060'
})
const formError = ref('')
const tagInput = ref('')
const tagMessage = ref('')

const title = computed(() => {
  if (props.editingItem) {
    return props.mode === 'bookmark' ? '编辑书签' : '编辑分组'
  }
  return props.mode === 'bookmark' ? '添加书签' : '添加分组'
})

// 重置表单
function resetForm() {
  formData.value = {
    groupId: props.defaultGroupId || (props.groups[0]?.id ?? ''),
    title: '',
    url: '',
    favicon: '',
    description: '',
    tags: [],
    name: '',
    icon: 'folder',
    color: '#a08060'
  }
  formError.value = ''
  tagInput.value = ''
  tagMessage.value = ''
}

// 监听显示状态，初始化表单
watch(() => props.show, (val) => {
  if (val) {
    formError.value = ''
    tagInput.value = ''
    tagMessage.value = ''

    if (props.editingItem) {
      // 编辑模式：填充现有数据
      if (props.mode === 'bookmark') {
        formData.value = {
          groupId: props.editingItem.groupId,
          title: props.editingItem.title,
          url: props.editingItem.url,
          favicon: props.editingItem.favicon || '',
          description: props.editingItem.description || '',
          tags: Array.isArray(props.editingItem.tags)
            ? [...props.editingItem.tags]
            : [],
          name: '',
          icon: 'folder',
          color: '#a08060'
        }
      } else {
        formData.value = {
          groupId: '',
          title: '',
          url: '',
          favicon: '',
          description: '',
          tags: [],
          name: props.editingItem.name,
          icon: resolveGroupIcon(props.editingItem.icon, props.editingItem.name),
          color: props.editingItem.color || '#a08060'
        }
      }
    } else {
      resetForm()
    }
  }
})

function addTag() {
  const tag = normalizeNoteTag(tagInput.value)
  if (!tag) {
    tagMessage.value = '标签需为 1–32 个字符，且不能包含网址、网络地址、邮箱、密钥或敏感编号。'
    return false
  }

  if (formData.value.tags.length >= MAX_NOTE_TAGS) {
    tagMessage.value = `每个书签最多保留 ${MAX_NOTE_TAGS} 个标签。`
    return false
  }

  const duplicate = formData.value.tags.some(
    (item) => normalizeNoteTag(item).toLocaleLowerCase('zh-CN') === tag.toLocaleLowerCase('zh-CN')
  )
  if (duplicate) {
    tagMessage.value = '这个标签已经存在。'
    return false
  }

  formData.value.tags.push(tag)
  tagInput.value = ''
  tagMessage.value = ''
  return true
}

function removeTag(index) {
  formData.value.tags.splice(index, 1)
  tagMessage.value = ''
}

function normalizeWebUrl(value) {
  const input = String(value || '').trim()
  if (!input) return ''

  const withProtocol = /^[a-z][a-z\d+.-]*:/i.test(input)
    ? input
    : `https://${input}`

  try {
    const parsed = new URL(withProtocol)
    if (!['http:', 'https:'].includes(parsed.protocol)) return ''
    parsed.username = ''
    parsed.password = ''
    return parsed.toString()
  } catch {
    return ''
  }
}

// 自动获取 favicon
async function fetchFavicon() {
  if (!formData.value.url) return

  const normalizedUrl = normalizeWebUrl(formData.value.url)
  if (normalizedUrl) {
    try {
      const url = new URL(normalizedUrl)
      formData.value.url = normalizedUrl
      formData.value.favicon = `${url.origin}/favicon.ico`
    } catch {
      // normalizeWebUrl already validates this; leave the field untouched on failure.
    }
  }
}

// 提交表单
function handleSubmit() {
  formError.value = ''

  if (props.mode === 'bookmark') {
    if (tagInput.value.trim() && !addTag()) {
      formError.value = '请先修正尚未加入的标签。'
      return
    }

    if (!formData.value.title.trim() || !formData.value.url.trim()) {
      formError.value = '请填写书签标题和网址'
      return
    }

    if (!formData.value.groupId) {
      formError.value = '请先创建或选择一个分组'
      return
    }

    const normalizedUrl = normalizeWebUrl(formData.value.url)
    if (!normalizedUrl) {
      formError.value = '请输入有效的 http 或 https 网址'
      return
    }

    emit('submit', {
      mode: 'bookmark',
      data: {
        groupId: formData.value.groupId,
        title: formData.value.title.trim(),
        url: normalizedUrl,
        favicon: formData.value.favicon.trim(),
        description: formData.value.description.trim(),
        tags: [...formData.value.tags]
      }
    })
  } else {
    if (!formData.value.name.trim()) {
      formError.value = '请填写分组名称'
      return
    }
    emit('submit', {
      mode: 'group',
      data: {
        name: formData.value.name.trim(),
        icon: resolveGroupIcon(formData.value.icon, formData.value.name),
        color: formData.value.color
      }
    })
  }
}

function close() {
  emit('close')
}
</script>

<template>
  <Modal
    :show="show"
    :title="title"
    :initial-focus-selector="mode === 'group' ? '#group-name-field' : '#bookmark-title-field'"
    @close="close"
  >
    <!-- 书签表单 -->
    <template v-if="mode === 'bookmark'">
      <div class="form-group">
        <label class="form-label">分组</label>
        <select v-model="formData.groupId" class="input" :disabled="saving">
          <option v-for="group in groups" :key="group.id" :value="group.id">
            {{ group.name }}
          </option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">标题 *</label>
        <input
          id="bookmark-title-field"
          v-model="formData.title"
          type="text"
          class="input"
          placeholder="输入书签标题"
          :disabled="saving"
        >
      </div>
      <div class="form-group">
        <label class="form-label">URL *</label>
        <input
          v-model="formData.url"
          type="url"
          class="input"
          placeholder="https://example.com"
          :disabled="saving"
          @blur="fetchFavicon"
        >
      </div>
      <div class="form-group">
        <label class="form-label">Favicon</label>
        <input
          v-model="formData.favicon"
          type="text"
          class="input"
          placeholder="自动获取或手动输入"
          :disabled="saving"
        >
      </div>
      <div class="form-group">
        <label class="form-label">描述</label>
        <textarea
          v-model="formData.description"
          class="input"
          rows="2"
          placeholder="可选描述"
          :disabled="saving"
        />
      </div>
      <div class="form-group">
        <label class="form-label" for="bookmark-tags-field">标签</label>
        <div class="bookmark-tags-input">
          <span v-for="(tag, index) in formData.tags" :key="`${tag}-${index}`" class="bookmark-tag">
            {{ tag }}
            <button
              type="button"
              :aria-label="`移除标签 ${tag}`"
              :disabled="saving"
              @click="removeTag(index)"
            >
              <Icon name="close" :size="12" />
            </button>
          </span>
          <input
            id="bookmark-tags-field"
            v-model="tagInput"
            type="text"
            placeholder="输入标签后按回车"
            :aria-describedby="tagMessage ? 'bookmark-tags-message' : undefined"
            :disabled="saving"
            @keydown.enter.prevent="addTag"
          >
        </div>
        <p
          v-if="tagMessage"
          id="bookmark-tags-message"
          class="bookmark-tags-message"
          role="alert"
        >
          {{ tagMessage }}
        </p>
      </div>
    </template>

    <!-- 分组表单 -->
    <template v-else>
      <div class="form-group">
        <label class="form-label" for="group-name-field">名称 *</label>
        <input
          id="group-name-field"
          v-model="formData.name"
          type="text"
          class="input"
          placeholder="输入分组名称"
          :disabled="saving"
        >
      </div>
      <div class="form-group">
        <span class="form-label">分组图标</span>
        <div class="icon-picker" role="radiogroup" aria-label="选择分组图标">
          <button
            v-for="option in GROUP_ICON_OPTIONS"
            :key="option.name"
            class="icon-picker__item"
            :class="{ 'is-selected': formData.icon === option.name }"
            type="button"
            role="radio"
            :aria-checked="formData.icon === option.name"
            :aria-label="option.label"
            :disabled="saving"
            @click="formData.icon = option.name"
          >
            <span class="icon-picker__glyph" aria-hidden="true">
              <Icon :name="option.name" :size="18" />
            </span>
            <span>{{ option.label }}</span>
          </button>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="group-color-field">颜色</label>
        <input
          id="group-color-field"
          v-model="formData.color"
          type="color"
          class="input"
          style="height: 44px; padding: 4px;"
          :disabled="saving"
        >
      </div>
    </template>

    <div v-if="formError" class="form-error" role="alert">{{ formError }}</div>

    <template #footer>
      <Button type="ghost" :disabled="saving" @click="close">取消</Button>
      <Button type="primary" :loading="saving" @click="handleSubmit">
        {{ saving ? '保存中' : (editingItem ? '保存' : '添加') }}
      </Button>
    </template>
  </Modal>
</template>

<style scoped>
.form-group {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  margin-bottom: 6px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

textarea.input {
  resize: vertical;
  min-height: 60px;
}

.bookmark-tags-input {
  min-height: 44px;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  padding: 7px 9px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 13px;
}

.bookmark-tags-input:focus-within {
  border-color: var(--accent-color);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 14%, transparent);
}

.bookmark-tags-input input {
  min-width: 138px;
  flex: 1;
  padding: 5px 2px;
  color: var(--text-primary);
  background: transparent;
  border: 0;
  outline: 0;
  font: inherit;
  font-size: 13px;
}

.bookmark-tag {
  min-height: 28px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 4px 6px 4px 9px;
  color: var(--accent-color);
  background: var(--accent-bg);
  border-radius: 999px;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.bookmark-tag button {
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  padding: 0;
  color: currentColor;
  background: transparent;
  border: 0;
  border-radius: 50%;
  cursor: pointer;
}

.bookmark-tag button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent-color) 13%, transparent);
}

.bookmark-tag button:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 1px;
}

.bookmark-tags-message {
  margin: 6px 0 0;
  color: var(--error-color);
  font-size: 12px;
  line-height: 1.45;
}

.form-error {
  padding: 11px 13px;
  color: var(--error-color);
  background: color-mix(in srgb, var(--error-color) 9%, var(--bg-secondary));
  border: 1px solid color-mix(in srgb, var(--error-color) 34%, var(--border-color));
  border-radius: 12px;
  font-size: 13px;
}

.icon-picker {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.icon-picker__item {
  min-width: 0;
  display: grid;
  justify-items: center;
  gap: 6px;
  padding: 10px 6px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid transparent;
  border-radius: 13px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    border-color var(--transition-fast),
    transform var(--transition-fast);
}

.icon-picker__item:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
  transform: translateY(-1px);
}

.icon-picker__item:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 2px;
}

.icon-picker__item.is-selected {
  color: var(--accent-color);
  background: var(--accent-bg);
  border-color: color-mix(in srgb, var(--accent-color) 46%, transparent);
  box-shadow: 0 6px 18px color-mix(in srgb, var(--accent-color) 12%, transparent);
}

.icon-picker__glyph {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 10px;
  background: color-mix(in srgb, currentColor 9%, transparent);
}

@media (max-width: 520px) {
  .icon-picker {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (prefers-reduced-motion: reduce) {
  .icon-picker__item {
    transition: none;
  }

  .icon-picker__item:hover:not(:disabled) {
    transform: none;
  }
}
</style>
