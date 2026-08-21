<script setup>
import { useAuth } from '@/shared/composables/useAuth'
import AccountSecuritySettings from '../components/AccountSecuritySettings.vue'
import SecurityAuditSettings from '../components/SecurityAuditSettings.vue'

defineOptions({ name: 'SecurityAuditCategory' })

const { backendAuthEnabled, currentUser } = useAuth()
</script>

<template>
  <div class="settings-category-stack">
    <AccountSecuritySettings
      v-if="backendAuthEnabled"
      id="settings-security"
      tabindex="-1"
    />
    <SecurityAuditSettings
      v-if="backendAuthEnabled && currentUser?.role === 'admin'"
      id="settings-security-audit"
      tabindex="-1"
    />
    <section v-if="!backendAuthEnabled" class="settings-category-empty" role="status">
      <h3>账号安全由当前设备管理</h3>
      <p>启用服务端账号体系后，这里会显示登录设备、恢复码、会话与安全审计。</p>
    </section>
  </div>
</template>

<style scoped>
.settings-category-stack { display: grid; gap: 24px; }
.settings-category-empty {
  padding: 28px;
  color: var(--text-secondary);
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
}
.settings-category-empty h3 { margin: 0 0 8px; color: var(--text-primary); font-size: 1.15rem; }
.settings-category-empty p { margin: 0; line-height: 1.65; }
</style>
