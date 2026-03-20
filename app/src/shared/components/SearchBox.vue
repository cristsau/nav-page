<script setup>
import { computed, onMounted, ref } from 'vue'
import { useConfig } from '@/shared/composables/useConfig'

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
const currentEngine = computed(() => getSearchEngine())
const allEngines = computed(() => getQuickAccessSearchEngines())

onMounted(async () => {
  await loadCustomSearchEngines()
})

function handleSearch() {
  const trimmed = query.value.trim()
  if (trimmed) {
    search(trimmed)
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
}
</script>

<template>
  <div class="search-box" :class="{ 'is-focused': isFocused }">
    <div class="search-box__engine-wrap">
      <button class="search-box__engine" @click="showSwitcher = !showSwitcher">
        <span class="search-box__icon">{{ currentEngine.icon }}</span>
        <span class="search-box__name">{{ currentEngine.name }}</span>
        <span class="search-box__chevron">▾</span>
      </button>

      <div v-if="showSwitcher" class="engine-switcher">
        <button
          v-for="engine in allEngines"
          :key="engine.id"
          class="engine-switcher__item"
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
    <button class="search-box__btn" @click="handleSearch">
      <span>搜索</span>
    </button>
  </div>
</template>

<style scoped>
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
  font-size: 18px;
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

.search-box__btn:hover {
  background: var(--accent-hover);
  transform: scale(1.02);
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
}
</style>
