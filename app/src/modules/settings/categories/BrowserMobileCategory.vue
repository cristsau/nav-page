<script setup>
import BrowserIntegrationSettings from '../components/BrowserIntegrationSettings.vue'
</script>

<template>
  <div class="settings-category-stack">
    <BrowserIntegrationSettings id="settings-browser" tabindex="-1" />
  </div>
</template>

<style scoped>
.settings-category-stack { display: grid; gap: 24px; }
</style>
