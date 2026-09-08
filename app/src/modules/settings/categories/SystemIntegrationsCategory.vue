<script setup>
import SystemIntegrationsSettings from '../components/SystemIntegrationsSettings.vue'
import AuthEmailStatus from '../components/AuthEmailStatus.vue'

defineOptions({ name: 'SystemIntegrationsCategory' })
</script>

<template>
  <div id="settings-system" class="settings-category-stack" tabindex="-1">
    <AuthEmailStatus />
    <SystemIntegrationsSettings />
  </div>
</template>

<style scoped>
.settings-category-stack { display: grid; gap: 24px; }
</style>
