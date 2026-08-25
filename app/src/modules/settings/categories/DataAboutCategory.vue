<script setup>
import DataSettings from '../components/DataSettings.vue'
</script>

<template>
  <div class="settings-category-stack">
    <DataSettings id="settings-data" tabindex="-1" />

    <section class="about-section" aria-labelledby="settings-about-title">
      <div class="about-section__brand">
        <img class="about-section__logo" src="/domo-logo.png" alt="">
        <h3 id="settings-about-title">DOMO NAV</h3>
      </div>
      <div class="about-section__info">
        <p class="about-section__version">版本 2.3.0</p>
        <p class="about-section__desc">
          面向个人与小团队的私有化导航工作台，已接入后端认证、PostgreSQL 云端数据、浏览器扩展和 AI 搜索代理。
        </p>
      </div>
      <div class="about-section__features" aria-label="主要能力">
        <span>后端认证</span>
        <span>PostgreSQL 云端数据</span>
        <span>浏览器扩展快速添加</span>
        <span>邮箱验证与审批</span>
        <span>AI 搜索代理</span>
      </div>
      <p class="about-section__signature">Design by CrisTsau</p>
    </section>
  </div>
</template>

<style scoped>
.settings-category-stack { display: grid; gap: 24px; }
.about-section {
  padding: 32px 24px;
  text-align: center;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
.about-section__brand { display: inline-flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.about-section__brand h3 { margin: 0; color: var(--text-primary); font-size: 1.6rem; letter-spacing: .14em; }
.about-section__logo {
  width: 52px;
  height: 52px;
  display: block;
  object-fit: contain;
  overflow: hidden;
  background: #fff;
  border: 1px solid var(--border-light);
  border-radius: 50%;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--text-primary) 10%, transparent);
}
.about-section__version { margin: 0 0 8px; color: var(--text-muted); font-size: .82rem; }
.about-section__desc { margin: 0 auto 20px; max-width: 640px; color: var(--text-secondary); font-size: .9rem; line-height: 1.7; }
.about-section__features { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; }
.about-section__features span { padding: 8px 14px; color: var(--text-secondary); font-size: .8rem; background: var(--bg-secondary); border-radius: var(--radius-full); }
.about-section__signature { margin: 18px 0 0; color: var(--text-muted); font-size: .75rem; letter-spacing: .08em; }
</style>
