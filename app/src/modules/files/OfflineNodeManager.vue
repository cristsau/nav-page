<script setup>
import { computed, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'
const props = defineProps({ node: { type: Object, required: true }, disabled: Boolean })
const emit = defineEmits(['change'])
const open = ref(false), editing = ref(false), name = ref(''), address = ref(''), selected = ref(''), stopped = ref(false)
const candidate = computed(() => props.node.candidates?.find(item => item.id === selected.value))
const stamp = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未连接'
function resetProfile() { name.value = props.node.name || ''; address.value = props.node.address || '' }
function edit() { resetProfile(); editing.value = true }
watch(() => props.node.preparing, () => { selected.value = ''; stopped.value = false; resetProfile() })
watch(() => props.node.id, () => { selected.value = ''; stopped.value = false; editing.value = false; resetProfile() })
watch(selected, () => { stopped.value = false })
watch(candidate, value => { if (!value) stopped.value = false })
function change(action) {
  if (props.disabled) return
  emit('change', { action, ...(action === 'profile' || action === 'activate' ? { name: name.value, address: address.value } : {}),
    ...(action === 'activate' ? { id: selected.value, oldNodeStopped: stopped.value } : {}) })
}
</script>
<template>
  <section class="node-manager" aria-label="下载节点管理">
    <button class="node-summary" :aria-expanded="open" aria-controls="offline-node-settings" @click="open = !open">
      <span><Icon name="cloud" :size="16" /><strong>{{ node.name || '下载节点' }}</strong><span class="node-state">{{ node.preparing ? '准备更换中' : node.online ? '在线' : '等待连接' }}</span></span>
      <Icon name="chevron-down" :size="16" :class="{ expanded: open }" />
    </button>
    <div v-if="open" id="offline-node-settings" class="node-body">
      <dl><div><dt>服务器地址</dt><dd>{{ node.address || '未填写' }}</dd></div><div><dt>节点编号</dt><dd class="node-id">{{ node.id || '旧版节点（兼容模式）' }}</dd></div><div><dt>最近连接</dt><dd>{{ stamp(node.lastSeen) }}</dd></div></dl>
      <p class="node-help">节点主动连接 NAV。地址用于区分服务器，修改地址不会迁移程序或任务。切换需先在新服务器安装节点并安全配置连接凭据。</p>
      <div v-if="!node.preparing && !editing" class="node-actions"><button :disabled="disabled" @click="edit">编辑节点资料</button><button :disabled="disabled" @click="change('prepare')">准备更换服务器</button></div>
      <form v-if="editing && !node.preparing" @submit.prevent="change('profile')">
        <label for="node-profile-name">节点名称</label><input id="node-profile-name" v-model="name" maxlength="64" required :disabled="disabled" placeholder="例如：离线下载节点" />
        <label for="node-profile-address">服务器 IP / 域名（可选）</label><input id="node-profile-address" v-model="address" maxlength="253" :disabled="disabled" autocomplete="off" spellcheck="false" placeholder="仅填写 IP 或域名" />
        <div class="node-actions"><button type="button" :disabled="disabled" @click="editing = false">收起编辑</button><button class="primary" :disabled="disabled || !name.trim()">保存资料</button></div>
      </form>
      <div v-if="node.preparing" class="node-migration">
        <p class="migration-note" role="status">已暂停接收新任务，已有任务继续处理。可随时退出更换流程。</p>
        <ol><li>处理全部任务与缓存：{{ node.blockers.unfinished }} 项未完成，{{ node.blockers.cleanup }} 项待清理。暂停、失败或需核对的任务须先处理。</li><li>停止旧节点，等待至少 45 秒无连接。{{ node.online ? '旧节点仍在线。' : node.ready ? '检查已通过。' : '正在等待检查通过。' }}</li><li>在新机启用节点身份后，对照新机的节点编号选择并确认。不要复制旧机的 node-id.json。</li></ol>
        <form @submit.prevent="change('activate')">
          <label for="replacement-node">待接入节点</label><select id="replacement-node" v-model="selected" :disabled="disabled"><option value="" disabled>请选择新节点</option><option v-for="item in node.candidates" :key="item.id" :value="item.id">{{ item.id }}</option></select>
          <small v-if="!node.candidates.length">尚无新节点连接；连接后会自动显示。</small><small v-else-if="candidate">最近连接：{{ stamp(candidate.lastSeen) }}</small>
          <label for="replacement-name">新节点名称</label><input id="replacement-name" v-model="name" required maxlength="64" :disabled="disabled" placeholder="例如：新下载服务器" />
          <label for="replacement-address">新服务器 IP / 域名（可选）</label><input id="replacement-address" v-model="address" maxlength="253" :disabled="disabled" autocomplete="off" spellcheck="false" placeholder="仅填写 IP 或域名" />
          <label class="node-confirm"><input v-model="stopped" type="checkbox" :disabled="disabled || !candidate" />我已停止旧节点，并核对新节点编号</label>
          <div class="node-actions"><button type="button" :disabled="disabled" @click="change('cancel')">退出更换</button><button class="primary" :disabled="disabled || !node.ready || !candidate || !stopped || !name.trim()">确认切换到新节点</button></div>
        </form>
      </div>
    </div>
  </section>
</template>
<style scoped>
.node-manager{border:1px solid var(--border-color);border-radius:8px;overflow:hidden;font-size:13px}.node-summary{display:flex;align-items:center;justify-content:space-between;width:100%;padding:12px!important;background:transparent;color:var(--text-primary);text-align:left}.node-summary>span{display:flex;align-items:center;gap:8px;min-width:0}.node-summary strong{overflow-wrap:anywhere}.node-state{color:var(--text-secondary);font-size:11px;flex-shrink:0}.node-summary svg{flex-shrink:0}.expanded{transform:rotate(180deg)}.node-body{padding:0 14px 14px;display:grid;gap:12px}.node-body dl{margin:0;display:grid;gap:8px}.node-body dl>div{display:grid;grid-template-columns:90px minmax(0,1fr);gap:8px}.node-body dt{color:var(--text-secondary)}.node-body dd{margin:0;overflow-wrap:anywhere}.node-id{font-family:ui-monospace,monospace}.node-help,.node-body small{color:var(--text-secondary);font-size:12px;line-height:1.7;margin:0}.node-body form{display:grid;gap:8px;padding:0}.node-body label{font-size:12px}.node-body input:not([type=checkbox]),.node-body select{width:100%;min-width:0;min-height:40px;border:1px solid var(--border-color);border-radius:6px;background:var(--bg-primary);color:var(--text-primary);padding:8px;box-sizing:border-box}.node-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}.node-body button{min-height:40px}.node-confirm{display:flex;align-items:center;gap:8px;min-height:44px}.node-confirm input{width:18px;height:18px;flex-shrink:0;accent-color:var(--accent-color)}.node-migration{display:grid;gap:12px}.migration-note{padding:10px;background:var(--accent-bg);border-radius:6px;margin:0;line-height:1.7}.node-migration ol{margin:0;padding-left:20px;line-height:1.8;color:var(--text-secondary)}.node-body :is(input,select,button):focus-visible,.node-summary:focus-visible{outline:2px solid var(--accent-color);outline-offset:2px}.node-manager button:disabled{opacity:.5;cursor:not-allowed}@media(max-width:440px){.node-body{padding:0 12px 12px}.node-actions{display:grid;grid-template-columns:1fr 1fr}.node-body button,.node-body select,.node-body input:not([type=checkbox]){min-height:44px}.node-summary>span{flex-wrap:wrap}.node-state{margin-left:auto}}
</style>
<style scoped>
.node-manager button{font:inherit;cursor:pointer;border:1px solid var(--border-color);border-radius:6px;padding:8px 12px;background:var(--bg-primary);color:var(--text-primary)}.node-manager .node-summary{border:0;border-radius:0}.node-manager .primary{background:var(--accent-color);color:var(--accent-contrast,#fff);border-color:transparent}.node-actions button{white-space:normal}.node-body input,.node-body select{font:inherit}
</style>
