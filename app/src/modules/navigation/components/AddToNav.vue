<script setup>
import { ref, computed, watch } from 'vue'
import Modal from '@/shared/components/Modal.vue'
import Button from '@/shared/components/Button.vue'

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
  icon: 'D',
  color: '#3b82f6'
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
    icon: 'D',
    color: '#3b82f6'
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
          icon: 'D',
          color: '#3b82f6'
        }
      } else {
        formData.value = {
          groupId: '',
          title: '',
          url: '',
          favicon: '',
          description: '',
          name: props.editingItem.name,
          icon: props.editingItem.icon,
          color: props.editingItem.color
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
        icon: formData.value.icon,
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
            {{ group.icon }} {{ group.name }}
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
        <label class="form-label">图标或短文字</label>
        <input
          v-model="formData.icon"
          type="text"
          class="input"
          maxlength="4"
          placeholder="例如 D、工、AI"
          :disabled="saving"
        >
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
</style>
