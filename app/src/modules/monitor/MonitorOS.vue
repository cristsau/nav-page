<script setup>
import { computed } from 'vue'
const props = defineProps({ os: String })
const label = computed(() => props.os?.trim() || '操作系统未上报')
const short = computed(() => {
  const value = label.value
  const known = /Windows|Ubuntu|Debian|AlmaLinux|Rocky|CentOS|Alpine|Fedora|Arch|FreeBSD|OpenBSD|macOS|Darwin|openSUSE|SUSE|Linux/i.exec(value)
  return known ? (known[0] === 'Darwin' ? 'macOS' : known[0]) : props.os?.trim().split(/\s+/)[0] || '未知'
})
</script>

<template>
  <span class="node-os" :title="label" :aria-label="`操作系统：${label}`">
    <svg v-if="/windows/i.test(label)" width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1 2.5 7 1.7v5.8H1zm7-1L15 .5v7H8zM1 8.5h6v5.8l-6-.8zm7 0h7v7l-7-1z"/></svg>
    <svg v-else width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><path d="m4 6 2 2-2 2m4 0h3"/></svg>
    <span>{{short}}</span>
  </span>
</template>

<style scoped>
.node-os{display:inline-flex;align-items:center;gap:3px;flex:none;max-width:78px;color:var(--text-secondary);font-size:10px;font-weight:400;line-height:16px;white-space:nowrap}
.node-os>span{overflow:hidden;text-overflow:ellipsis}.node-os svg{flex:none}
@media(max-width:650px){.node-os{max-width:54px;gap:2px;font-size:9px}.node-os svg{width:12px;height:12px}.node-os>span{display:none}}
</style>
