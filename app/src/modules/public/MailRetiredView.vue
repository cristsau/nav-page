<script setup>
import Icon from '@/shared/components/Icon.vue'
</script>

<template>
  <main class="retired-mail">
    <Icon name="compass" :size="36" />
    <h1>DOMO NAV 邮箱功能已下线</h1>
    <p>请继续在原邮箱服务中收发邮件。DOMO NAV 将专注于导航、时光与 AI 助理。</p>
    <router-link to="/">返回导航</router-link>
  </main>
</template>

<style scoped>
.retired-mail { display: grid; justify-items: center; gap: 20px; max-width: 720px; margin: 10vh auto; padding: 24px; text-align: center; color: var(--text-primary); }
.retired-mail h1 { font-size: clamp(1.4rem, 4vw, 2rem); }
.retired-mail p { line-height: 1.8; color: var(--text-secondary); }
.retired-mail a { padding: 14px 24px; color: var(--accent-color); border: 1px solid var(--border-color); border-radius: 14px; }
</style>
