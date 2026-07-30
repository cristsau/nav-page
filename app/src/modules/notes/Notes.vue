<script setup>
import { useRouter } from 'vue-router'
import Icon from '@/shared/components/Icon.vue'

const router = useRouter()

function goBack() {
  router.push('/')
}
</script>

<template>
  <div class="container">
    <header class="header">
      <div class="header__left">
        <button class="icon-btn" type="button" aria-label="返回导航页" title="返回导航页" @click="goBack">
          <Icon name="arrow-left" :size="20" />
        </button>
        <h1 class="header__title">便签</h1>
      </div>
    </header>

    <div class="empty-state">
      <div class="empty-state__icon">
        <Icon name="note" :size="34" />
      </div>
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
