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
  icon: '📁',
  color: '#3b82f6'
})

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
    icon: '📁',
    color: '#3b82f6'
  }
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
          icon: '📁',
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

// 自动获取 favicon
async function fetchFavicon() {
  if (!formData.value.url) return

  try {
    const url = new URL(formData.value.url)
    formData.value.favicon = `${url.origin}/favicon.ico`
  } catch (e) {
    // URL 格式无效
  }
}

// 提交表单
function handleSubmit() {
  if (props.mode === 'bookmark') {
    if (!formData.value.title.trim() || !formData.value.url.trim()) {
      return
    }
    emit('submit', {
      mode: 'bookmark',
      data: {
        groupId: formData.value.groupId,
        title: formData.value.title.trim(),
        url: formData.value.url.trim(),
        favicon: formData.value.favicon.trim(),
        description: formData.value.description.trim()
      }
    })
  } else {
    if (!formData.value.name.trim()) {
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
        <select v-model="formData.groupId" class="input">
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
        >
      </div>
      <div class="form-group">
        <label class="form-label">URL *</label>
        <input
          v-model="formData.url"
          type="url"
          class="input"
          placeholder="https://example.com"
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
        >
      </div>
      <div class="form-group">
        <label class="form-label">描述</label>
        <textarea
          v-model="formData.description"
          class="input"
          rows="2"
          placeholder="可选描述"
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
        >
      </div>
      <div class="form-group">
        <label class="form-label">图标</label>
        <input
          v-model="formData.icon"
          type="text"
          class="input"
          placeholder="选择一个 emoji"
        >
      </div>
      <div class="form-group">
        <label class="form-label">颜色</label>
        <input
          v-model="formData.color"
          type="color"
          class="input"
          style="height: 40px; padding: 4px;"
        >
      </div>
    </template>

    <template #footer>
      <Button type="ghost" @click="close">取消</Button>
      <Button type="primary" @click="handleSubmit">
        {{ editingItem ? '保存' : '添加' }}
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
</style>
