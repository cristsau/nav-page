<script setup>
import { computed, onMounted, ref } from 'vue'
import { useConfig } from '@/shared/composables/useConfig'
import Icon from '@/shared/components/Icon.vue'

const {
  getSearchEngine,
  getQuickAccessSearchEngines,
  loadCustomSearchEngines,
  search,
  updateConfig
} = useConfig()

const query = ref('')
const isFocused = ref(false)
const showSwitcher = ref(false)
const isSearching = ref(false)
const searchError = ref('')
const searchResult = ref(null)
const copied = ref(false)
const currentEngine = computed(() => getSearchEngine())
const allEngines = computed(() => getQuickAccessSearchEngines())

onMounted(async () => {
  await loadCustomSearchEngines()
})

async function handleSearch() {
  const trimmed = query.value.trim()
  if (!trimmed || isSearching.value) return

  searchError.value = ''
  searchResult.value = null
  isSearching.value = true

  try {
    const outcome = await search(trimmed)

    if (outcome?.mode === 'ai') {
      searchResult.value = outcome.result
    }
  } catch (error) {
    searchError.value = error.message || '搜索失败，请稍后重试'
  } finally {
    isSearching.value = false
  }
}

function handleKeydown(event) {
  if (event.key === 'Enter') {
    handleSearch()
  }
}

function selectEngine(engineId) {
  updateConfig('searchEngine', engineId)
  showSwitcher.value = false
  searchResult.value = null
  searchError.value = ''
}

function closeResultPanel() {
  searchResult.value = null
  searchError.value = ''
  copied.value = false
}

function openExternalResult() {
  if (!searchResult.value?.externalUrl) return
  window.open(searchResult.value.externalUrl, '_blank', 'noopener,noreferrer')
}

async function copyAnswer() {
  if (!searchResult.value?.answer) return

  try {
    await navigator.clipboard.writeText(searchResult.value.answer)
    copied.value = true
    window.setTimeout(() => {
      copied.value = false
    }, 1800)
  } catch {
    searchError.value = '复制失败，请手动选择答案文本'
  }
}
</script>

<template>
  <div class="search-shell">
    <div class="search-box" :class="{ 'is-focused': isFocused }">
      <div class="search-box__engine-wrap">
        <button
          class="search-box__engine"
          type="button"
          :aria-expanded="showSwitcher"
          aria-label="切换搜索引擎"
          @click="showSwitcher = !showSwitcher"
        >
          <span class="search-box__icon" aria-hidden="true">{{ currentEngine.icon }}</span>
          <span class="search-box__name">{{ currentEngine.name }}</span>
          <Icon name="more-horizontal" :size="15" />
        </button>

        <div v-if="showSwitcher" class="engine-switcher">
          <button
            v-for="engine in allEngines"
            :key="engine.id"
            class="engine-switcher__item"
            type="button"
            :class="{ 'is-active': currentEngine.id === engine.id }"
            @click="selectEngine(engine.id)"
          >
            <span>{{ engine.icon }}</span>
            <span>{{ engine.name }}</span>
          </button>
        </div>
      </div>

      <input
        v-model="query"
        type="text"
        class="search-box__input"
        :placeholder="`在 ${currentEngine.name} 搜索...`"
        @focus="isFocused = true"
        @blur="isFocused = false"
        @keydown="handleKeydown"
      >
      <button class="search-box__btn" type="button" :disabled="isSearching" @click="handleSearch">
        <Icon :name="isSearching ? 'refresh' : 'search'" :size="17" />
        <span>{{ isSearching ? '搜索中...' : '搜索' }}</span>
      </button>
    </div>

    <div v-if="isSearching || searchError || searchResult" class="search-result-panel">
      <div class="search-result-panel__header">
        <div>
          <div class="search-result-panel__title">
            {{ searchResult?.label || currentEngine.name }}
          </div>
          <div class="search-result-panel__meta">
            {{ searchResult?.query || query }}
            <span v-if="searchResult?.model"> · {{ searchResult.model }}</span>
          </div>
        </div>
        <button class="search-result-panel__close" type="button" aria-label="关闭搜索结果" @click="closeResultPanel">
          <Icon name="close" :size="16" /> 关闭
        </button>
      </div>

      <div v-if="isSearching" class="search-result-panel__state">
        正在请求 AI 搜索结果...
      </div>

      <div v-else-if="searchError" class="search-result-panel__state search-result-panel__state--error">
        {{ searchError }}
      </div>

      <template v-else-if="searchResult">
        <div v-if="searchResult.answer" class="search-result-panel__answer">
          {{ searchResult.answer }}
        </div>

        <div v-if="searchResult.items?.length" class="search-result-sources">
          <div class="search-result-sources__title">
            <Icon name="external-link" :size="15" />
            {{ searchResult.mode === 'answer' ? '引用来源' : '搜索结果' }}
          </div>
          <div class="search-result-list">
            <a
              v-for="(item, index) in searchResult.items"
              :key="item.url || index"
              class="search-result-item"
              :href="item.url"
              target="_blank"
              rel="noopener noreferrer"
            >
              <div class="search-result-item__source">{{ item.source || '搜索结果' }}</div>
              <div class="search-result-item__title">{{ item.title }}</div>
              <div v-if="item.description" class="search-result-item__desc">{{ item.description }}</div>
              <div class="search-result-item__url">{{ item.url }}</div>
            </a>
          </div>
        </div>

        <div class="search-result-panel__actions">
          <button
            v-if="searchResult.answer"
            class="search-result-panel__link"
            type="button"
            @click="copyAnswer"
          >
            <Icon :name="copied ? 'check' : 'copy'" :size="16" />
            {{ copied ? '已复制' : '复制答案' }}
          </button>
          <button
            v-if="searchResult.externalUrl"
            class="search-result-panel__link"
            type="button"
            @click="openExternalResult"
          >
            <Icon name="external-link" :size="16" />
            在原始站点打开
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.search-shell {
  position: relative;
  display: grid;
  gap: 16px;
}

.search-box {
  position: relative;
  display: flex;
  align-items: center;
  max-width: 640px;
  margin: 0 auto;
  background: var(--bg-card);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-card);
  padding: 6px;
  transition: all var(--transition-normal) var(--ease-smooth);
}

.search-box:hover {
  box-shadow: var(--shadow-card-hover);
}

.search-box.is-focused {
  transform: scale(1.02);
  box-shadow: var(--shadow-lg);
}

.search-box__engine-wrap {
  position: relative;
  flex-shrink: 0;
}

.search-box__engine {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-secondary);
  border: none;
  border-radius: var(--radius-lg);
  color: var(--text-primary);
  cursor: pointer;
}

.search-box__icon {
  min-width: 27px;
  padding: 4px 6px;
  color: var(--accent-color);
  background: var(--accent-bg);
  border-radius: 9px;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
}

.search-box__name {
  font-size: 14px;
  font-weight: 500;
}

.search-box__chevron {
  font-size: 12px;
  color: var(--text-muted);
}

.engine-switcher {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 30;
  min-width: 180px;
  display: grid;
  gap: 6px;
  padding: 10px;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-radius: 18px;
  box-shadow: var(--shadow-card-hover);
}

.engine-switcher__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: none;
  border-radius: 12px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  cursor: pointer;
}

.engine-switcher__item.is-active {
  background: var(--accent-bg);
  box-shadow: 0 0 0 2px var(--accent-color);
}

.search-box__input {
  flex: 1;
  border: none;
  background: transparent;
  padding: 12px 16px;
  font-size: 16px;
  color: var(--text-primary);
  outline: none;
}

.search-box__input::placeholder {
  color: var(--text-muted);
}

.search-box__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px 24px;
  background: var(--accent-color);
  color: #fff;
  border: none;
  border-radius: var(--radius-lg);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
  flex-shrink: 0;
}

.search-box__btn:hover:not(:disabled) {
  background: var(--accent-hover);
  transform: scale(1.02);
}

.search-box__btn:disabled {
  opacity: 0.7;
  cursor: wait;
}

.search-box__btn:disabled svg {
  animation: search-spin 0.9s linear infinite;
}

@keyframes search-spin {
  to { transform: rotate(360deg); }
}

.search-result-panel {
  max-width: 960px;
  width: min(100%, 960px);
  margin: 0 auto;
  padding: 20px;
  background: color-mix(in srgb, var(--bg-card) 92%, var(--accent-color) 8%);
  border: 1px solid var(--border-light);
  border-radius: 28px;
  box-shadow: var(--shadow-card-hover);
}

.search-result-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.search-result-panel__title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.search-result-panel__meta {
  margin-top: 6px;
  color: var(--text-muted);
  font-size: 13px;
}

.search-result-panel__close,
.search-result-panel__link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 16px;
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: none;
  border-radius: 999px;
  cursor: pointer;
}

.search-result-panel__answer {
  padding: 16px 18px;
  background: var(--bg-secondary);
  border-radius: 20px;
  color: var(--text-primary);
  line-height: 1.8;
  white-space: pre-wrap;
}

.search-result-sources {
  margin-top: 14px;
}

.search-result-sources__title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 4px 10px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.search-result-panel__state {
  padding: 16px 18px;
  background: var(--bg-secondary);
  border-radius: 20px;
  color: var(--text-secondary);
}

.search-result-panel__state--error {
  color: #d65c5c;
}

.search-result-list {
  display: grid;
  gap: 12px;
}

.search-result-item {
  display: grid;
  gap: 6px;
  padding: 16px 18px;
  background: var(--bg-secondary);
  border-radius: 20px;
  color: inherit;
  text-decoration: none;
  transition: transform var(--transition-fast), box-shadow var(--transition-fast);
}

.search-result-item:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-card);
}

.search-result-item__source {
  font-size: 12px;
  color: var(--text-muted);
}

.search-result-item__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
}

.search-result-item__desc {
  color: var(--text-secondary);
  line-height: 1.6;
}

.search-result-item__url {
  color: var(--accent-color);
  font-size: 12px;
  word-break: break-all;
}

.search-result-panel__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}

@media (max-width: 640px) {
  .search-box {
    flex-direction: column;
    border-radius: var(--radius-lg);
    padding: 8px;
  }

  .search-box__engine-wrap,
  .search-box__engine,
  .search-box__input,
  .search-box__btn {
    width: 100%;
  }

  .search-box__engine {
    justify-content: center;
    margin-bottom: 8px;
  }

  .engine-switcher {
    right: 0;
    min-width: unset;
  }

  .search-box__input {
    text-align: center;
  }

  .search-box__btn {
    margin-top: 8px;
  }

  .search-result-panel__header {
    flex-direction: column;
  }
}
</style>
