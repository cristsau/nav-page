<script setup>
import { computed } from 'vue'
import { useTheme } from '@/shared/composables/useTheme'
import { useConfig } from '@/shared/composables/useConfig'

// 初始化主题
const { isDark } = useTheme()
// 初始化配置
const { config } = useConfig()

// 背景图样式
const bgStyle = computed(() => {
  const bgImage = config.value.style?.backgroundImage
  if (bgImage) {
    return {
      backgroundImage: `url(${bgImage})`,
      backgroundSize: 'cover',
      backgroundPosition: 'center',
      backgroundAttachment: 'fixed'
    }
  }
  return {}
})
</script>

<template>
  <div class="app" :class="{ 'dark': isDark }" :style="bgStyle">
    <router-view />
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  background-color: var(--bg-primary);
  color: var(--text-primary);
  transition: background-color 0.3s ease, color 0.3s ease;
}
</style>
