<script setup>
import SystemIntegrationsSettings from '../components/SystemIntegrationsSettings.vue'

defineOptions({ name: 'SystemIntegrationsCategory' })
</script>

<template>
  <div id="settings-system" class="settings-category-stack" tabindex="-1">
    <SystemIntegrationsSettings />
  </div>
</template>

<style scoped>
.settings-category-stack { display: grid; gap: 24px; }
</style>
