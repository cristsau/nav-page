<script setup>
import SearchSettings from '../components/SearchSettings.vue'
</script>

<template>
  <div class="settings-category-stack">
    <SearchSettings id="settings-search" tabindex="-1" />
  </div>
</template>

<style scoped>
.settings-category-stack { display: grid; gap: 24px; }
</style>
