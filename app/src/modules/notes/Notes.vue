<script setup>
import { useRouter } from 'vue-router'
import Button from '@/shared/components/Button.vue'

const router = useRouter()

function goBack() {
  router.push('/')
}
</script>

<template>
  <div class="container">
    <header class="header">
      <div class="header__left">
        <button class="icon-btn" @click="goBack">←</button>
        <h1 class="header__title">便签</h1>
      </div>
    </header>

    <div class="empty-state">
      <div class="empty-state__icon">📝</div>
      <div class="empty-state__text">
        便签模块开发中...
      </div>
      <p class="empty-state__desc">
        将支持 Notion 风格的块编辑器、Markdown、标签系统等功能
      </p>
    </div>
  </div>
</template>

<style scoped>
.header__left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.empty-state__desc {
  margin-top: 8px;
  color: var(--text-muted);
  font-size: 14px;
}
</style>
