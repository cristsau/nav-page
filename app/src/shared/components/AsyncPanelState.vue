<script setup>
import Modal from './Modal.vue'
defineProps({ error: Object })
defineEmits(['close'])
</script>
<template>
  <Modal show :title="error ? '编辑器暂时未能加载' : '正在打开编辑器…'" @close="$emit('close')">
    <div class="async-panel" role="status" aria-live="polite">
      <p v-if="error">编辑工具下载失败，请关闭后检查网络，必要时刷新页面再试。没有修改笔记内容。</p>
      <p v-else>首次打开需要加载编辑工具，笔记内容未改变。</p>
      <button type="button" @click="$emit('close')">关闭</button>
    </div>
  </Modal>
</template>
<style scoped>
.async-panel { color:var(--text-primary); }
p { margin:12px 0; color:var(--text-secondary); }
button { margin-top:16px; min-height:44px; padding:0 18px; background:var(--bg-secondary); border-radius:8px; }
</style>
