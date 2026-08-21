<script setup>
import UserManagementSettings from '../components/UserManagementSettings.vue'

defineOptions({ name: 'UserManagementCategory' })
</script>

<template>
  <div id="settings-users" class="settings-category-stack" tabindex="-1">
    <UserManagementSettings />
  </div>
</template>

<style scoped>
.settings-category-stack { display: grid; gap: 24px; }
</style>
