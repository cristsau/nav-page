<script setup>
import { ref } from 'vue'
import { useConfig } from '@/shared/composables/useConfig'

const { config, getSearchEngine, search, searchEngines } = useConfig()

const query = ref('')
const isFocused = ref(false)

function handleSearch() {
  if (query.value.trim()) {
    search(query.value.trim())
  }
}

function handleKeydown(e) {
  if (e.key === 'Enter') {
    handleSearch()
  }
}

const currentEngine = getSearchEngine()
</script>

<template>
  <div class="search-box" :class="{ 'is-focused': isFocused }">
    <div class="search-box__engine">
      <span class="search-box__icon">{{ currentEngine.icon }}</span>
      <span class="search-box__name">{{ currentEngine.name }}</span>
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
  display: flex;
  align-items: center;
  max-width: 600px;
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

.search-box__engine {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-lg);
  flex-shrink: 0;
}

.search-box__icon {
  font-size: 18px;
}

.search-box__name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
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

.search-box__btn:active {
  transform: scale(0.98);
}

@media (max-width: 640px) {
  .search-box {
    flex-direction: column;
    border-radius: var(--radius-lg);
    padding: 8px;
  }

  .search-box__engine {
    width: 100%;
    justify-content: center;
    margin-bottom: 8px;
  }

  .search-box__input {
    width: 100%;
    text-align: center;
  }

  .search-box__btn {
    width: 100%;
    margin-top: 8px;
  }
}
</style>
