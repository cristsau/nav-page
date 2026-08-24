<script setup>
import BrowserIntegrationSettings from '../components/BrowserIntegrationSettings.vue'
import WebPushSettings from '../components/WebPushSettings.vue'
</script>

<template>
  <div class="settings-category-stack">
    <BrowserIntegrationSettings id="settings-browser" tabindex="-1" />
    <WebPushSettings />
  </div>
</template>

<style scoped>
.settings-category-stack { display: grid; gap: 24px; }
</style>
