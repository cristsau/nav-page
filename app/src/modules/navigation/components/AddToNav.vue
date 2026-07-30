<script setup>
import { ref, computed, watch } from 'vue'
import Modal from '@/shared/components/Modal.vue'
import Button from '@/shared/components/Button.vue'
import Icon from '@/shared/components/Icon.vue'
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
  // 分组字段
  name: '',
  icon: 'folder',
  color: '#a08060'
})
const formError = ref('')

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
    name: '',
    icon: 'folder',
    color: '#a08060'
  }
  formError.value = ''
}

// 监听显示状态，初始化表单
watch(() => props.show, (val) => {
  if (val) {
    if (props.editingItem) {
      // 编辑模式：填充现有数据
      if (props.mode === 'bookmark') {
        formData.value = {
          groupId: props.editingItem.groupId,
          title: props.editingItem.title,
          url: props.editingItem.url,
          favicon: props.editingItem.favicon || '',
          description: props.editingItem.description || '',
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
        description: formData.value.description.trim()
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
  <Modal :show="show" :title="title" @close="close">
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
    </template>

    <!-- 分组表单 -->
    <template v-else>
      <div class="form-group">
        <label class="form-label">名称 *</label>
        <input
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
        <label class="form-label">颜色</label>
        <input
          v-model="formData.color"
          type="color"
          class="input"
          style="height: 40px; padding: 4px;"
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
