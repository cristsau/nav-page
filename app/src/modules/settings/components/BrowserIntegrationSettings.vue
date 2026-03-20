<script setup>
import { computed, ref } from 'vue'

const copiedText = ref('')

const navUrl = computed(() => window.location.origin)
const quickAddUrl = computed(() => `${window.location.origin}/quick-add`)
const extensionDownloadUrl = computed(() => `${window.location.origin}/downloads/nav-extension.zip`)
const extensionGuideUrl = computed(() => `${window.location.origin}/downloads/nav-extension/README.html`)
const iphoneShortcutTemplate = computed(() => `${window.location.origin}/quick-add?url={{链接}}&title={{标题}}`)

async function copyText(value, label) {
  await navigator.clipboard.writeText(value)
  copiedText.value = `${label} 已复制`
  window.setTimeout(() => {
    copiedText.value = ''
  }, 2200)
}

function openLink(url) {
  window.open(url, '_blank', 'noopener')
}
</script>

<template>
  <div class="settings-section">
    <h3 class="settings-section__title">浏览器集成</h3>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">设为浏览器启动页</div>
        <div class="settings-item__desc">
          浏览器安全限制下，网页不能直接替你修改启动页；这里提供一键复制地址和设置说明。
        </div>
      </div>
      <div class="settings-item__control settings-item__control--stack">
        <button class="btn btn--secondary" @click="copyText(navUrl, 'NAV 地址')">复制 NAV 地址</button>
        <p class="helper-text">Chrome / Edge：打开浏览器设置，搜索“启动时”，选择“打开特定网页”，填入上面的 NAV 地址。</p>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">安装浏览器扩展</div>
        <div class="settings-item__desc">
          浏览器不允许网站静默安装扩展，所以这里改成最接近真实可用的方案：下载扩展包并引导安装。
        </div>
      </div>
      <div class="settings-item__control settings-item__control--stack">
        <button class="btn btn--primary" @click="openLink(extensionDownloadUrl)">下载扩展包</button>
        <button class="btn btn--secondary" @click="openLink(extensionGuideUrl)">查看安装说明</button>
        <p class="helper-text">Chrome / Edge：打开“扩展程序”页面，启用“开发者模式”，再选择“加载已解压的扩展程序”。</p>
      </div>
    </div>

    <div class="settings-item">
      <div class="settings-item__info">
        <div class="settings-item__label">iPhone 快速添加当前页</div>
        <div class="settings-item__desc">
          iPhone 端最稳的方案是用“快捷指令 + Safari 分享菜单”打开 NAV 的快速添加页。
        </div>
      </div>
      <div class="settings-item__control settings-item__control--stack">
        <button class="btn btn--secondary" @click="openLink(quickAddUrl)">打开快速添加页</button>
        <button class="btn btn--secondary" @click="copyText(iphoneShortcutTemplate, 'iPhone 模板地址')">复制 iPhone 模板地址</button>
        <p class="helper-text">在 iPhone“快捷指令”中创建一个接收 Safari 分享内容的快捷指令，把链接和标题拼到这个模板后打开即可。</p>
      </div>
    </div>

    <div v-if="copiedText" class="copied-tip">{{ copiedText }}</div>
  </div>
</template>

<style scoped>
.settings-section {
  margin-bottom: 24px;
  padding: 20px;
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.settings-section__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border-light);
}

.settings-item {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 0;
  border-bottom: 1px solid var(--border-light);
}

.settings-item:last-child {
  border-bottom: none;
}

.settings-item__info {
  flex: 1;
}

.settings-item__label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}

.settings-item__desc {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

.settings-item__control {
  flex-shrink: 0;
}

.settings-item__control--stack {
  display: grid;
  gap: 10px;
  width: 280px;
}

.helper-text {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-muted);
}

.btn {
  padding: 10px 16px;
  border: none;
  border-radius: 14px;
  cursor: pointer;
}

.btn--primary {
  background: var(--accent-color);
  color: #fff;
}

.btn--secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.copied-tip {
  margin-top: 14px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 13px;
}

@media (max-width: 720px) {
  .settings-item {
    flex-direction: column;
  }

  .settings-item__control--stack {
    width: 100%;
  }
}
</style>
