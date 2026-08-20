<script setup>
import GeneralSettings from '../components/GeneralSettings.vue'
import AppearanceSettings from '../components/AppearanceSettings.vue'
</script>

<template>
  <div class="settings-category-stack">
    <GeneralSettings />
    <AppearanceSettings />
  </div>
</template>

<style scoped>
.settings-category-stack { display: grid; gap: 24px; }
</style>
