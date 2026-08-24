<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useConfig } from '@/shared/composables/useConfig'
import Icon from '@/shared/components/Icon.vue'
import { searchWorkspace } from '@/shared/services/unifiedSearchApi'
import { createHighlightedSegments } from '@/shared/utils/unifiedSearch'
import { queryWorkspaceAssistant } from '@/shared/services/assistantApi'

const router = useRouter()
const {
  getSearchEngine,
  getQuickAccessSearchEngines,
  loadCustomSearchEngines,
  search,
  updateConfig
} = useConfig()

const searchShell = ref(null)
const queryInput = ref(null)
const query = ref('')
const isFocused = ref(false)
const showSwitcher = ref(false)
const isSearching = ref(false)
const searchError = ref('')
const searchResult = ref(null)
const copied = ref(false)
const isLocalSearching = ref(false)
const isAssistantSearching = ref(false)
const localSearchError = ref('')
const showLocalResults = ref(false)
const activeResultIndex = ref(-1)
const localSearchResult = ref({
  bookmarks: [],
  notes: [],
  all: [],
  total: 0,
  failedSources: []
})

let localSearchTimer = null
let localSearchSequence = 0
let assistantSearchSequence = 0

const currentEngine = computed(() => getSearchEngine())
const allEngines = computed(() => getQuickAccessSearchEngines())
const localResultGroups = computed(() => {
  let resultIndex = 0

  return [
    {
      id: 'bookmarks',
      label: '导航',
      icon: 'browser',
      items: localSearchResult.value.bookmarks.map((item) => ({
        ...item,
        resultIndex: resultIndex++
      }))
    },
    {
      id: 'notes',
      label: '笔记与备忘录',
      icon: 'note',
      items: localSearchResult.value.notes.map((item) => ({
        ...item,
        resultIndex: resultIndex++
      }))
    }
  ].filter((group) => group.items.length)
})
const flatLocalResults = computed(() => localResultGroups.value.flatMap((group) => group.items))
const shouldShowLocalPanel = computed(() => (
  showLocalResults.value &&
  Boolean(query.value.trim())
))

onMounted(async () => {
  await loadCustomSearchEngines()
  window.addEventListener('keydown', handleGlobalKeydown)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
})

onBeforeUnmount(() => {
  clearTimeout(localSearchTimer)
  window.removeEventListener('keydown', handleGlobalKeydown)
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
})

watch(query, (value) => {
  clearTimeout(localSearchTimer)
  assistantSearchSequence += 1
  isAssistantSearching.value = false
  activeResultIndex.value = -1
  localSearchError.value = ''
  searchResult.value = null
  searchError.value = ''

  const trimmed = value.trim()
  if (!trimmed) {
    showLocalResults.value = false
    isLocalSearching.value = false
    localSearchResult.value = {
      bookmarks: [],
      notes: [],
      all: [],
      total: 0,
      failedSources: []
    }
    return
  }

  showLocalResults.value = true
  isLocalSearching.value = true
  const sequence = ++localSearchSequence

  localSearchTimer = window.setTimeout(async () => {
    try {
      const result = await searchWorkspace(trimmed)
      if (sequence !== localSearchSequence) return
      localSearchResult.value = result
    } catch (error) {
      if (sequence !== localSearchSequence) return
      localSearchError.value = error.message || '站内搜索失败'
      localSearchResult.value = {
        bookmarks: [],
        notes: [],
        all: [],
        total: 0,
        failedSources: []
      }
    } finally {
      if (sequence === localSearchSequence) {
        isLocalSearching.value = false
      }
    }
  }, 180)
})

async function handleWebSearch() {
  const trimmed = query.value.trim()
  if (!trimmed || isSearching.value) return

  searchError.value = ''
  searchResult.value = null
  isSearching.value = true

  try {
    const outcome = await search(trimmed)

    if (outcome?.mode === 'ai') {
      searchResult.value = outcome.result
      showLocalResults.value = false
    }
  } catch (error) {
    searchError.value = error.message || '搜索失败，请稍后重试'
  } finally {
    isSearching.value = false
  }
}

function handleKeydown(event) {
  if (event.key === 'ArrowDown' && flatLocalResults.value.length) {
    event.preventDefault()
    showLocalResults.value = true
    activeResultIndex.value = Math.min(
      activeResultIndex.value + 1,
      flatLocalResults.value.length - 1
    )
    return
  }

  if (event.key === 'ArrowUp' && flatLocalResults.value.length) {
    event.preventDefault()
    showLocalResults.value = true
    activeResultIndex.value = Math.max(activeResultIndex.value - 1, 0)
    return
  }

  if (event.key === 'Escape') {
    showSwitcher.value = false
    showLocalResults.value = false
    queryInput.value?.blur()
    return
  }

  if (event.key !== 'Enter') return
  event.preventDefault()

  if (activeResultIndex.value >= 0) {
    const activeResult = flatLocalResults.value[activeResultIndex.value]
    if (activeResult) {
      openLocalResult(activeResult)
      return
    }
  }

  handleWebSearch()
}

function handleGlobalKeydown(event) {
  const target = event.target
  const isEditableTarget = target instanceof HTMLElement && (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  )
  const isCommandShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k'
  const isSlashShortcut = event.key === '/' && !isEditableTarget

  if (!isCommandShortcut && !isSlashShortcut) return

  event.preventDefault()
  queryInput.value?.focus()
  showLocalResults.value = Boolean(query.value.trim())
}

function handleDocumentPointerDown(event) {
  if (searchShell.value?.contains(event.target)) return
  showSwitcher.value = false
  showLocalResults.value = false
}

function handleInputFocus() {
  isFocused.value = true
  if (query.value.trim()) {
    showLocalResults.value = true
  }
}

function selectEngine(engineId) {
  updateConfig('searchEngine', engineId)
  showSwitcher.value = false
  searchResult.value = null
  searchError.value = ''
}

function openLocalResult(result) {
  if (result.kind === 'bookmark' && result.href) {
    try {
      const targetUrl = new URL(result.href)
      if (!['http:', 'https:'].includes(targetUrl.protocol)) return
      window.open(targetUrl.toString(), '_blank', 'noopener,noreferrer')
    } catch {
      return
    }
  } else if (result.kind === 'note') {
    router.push({
      path: '/whisper',
      query: {
        search: query.value.trim(),
        note: String(result.id)
      }
    })
  }

  showLocalResults.value = false
}

function closeResultPanel() {
  searchResult.value = null
  searchError.value = ''
  copied.value = false
}

async function handleAssistantQuery() {
  const trimmed = query.value.trim()
  if (!trimmed || isAssistantSearching.value) return

  isAssistantSearching.value = true
  searchError.value = ''
  searchResult.value = null
  showLocalResults.value = false
  const sequence = ++assistantSearchSequence

  try {
    const result = await queryWorkspaceAssistant(trimmed)
    if (sequence !== assistantSearchSequence) return
    searchResult.value = {
      ...result,
      label: result.mode === 'retrieval' ? '个人资料检索' : '个人资料助理',
      items: (result.sources || []).map((source) => ({
        ...source,
        source: source.sourceId,
        description: source.excerpt,
        url: source.href
      }))
    }
  } catch (error) {
    if (sequence !== assistantSearchSequence) return
    searchError.value = error.message || '个人资料助理暂时不可用'
  } finally {
    if (sequence === assistantSearchSequence) {
      isAssistantSearching.value = false
    }
  }
}

function sourceTarget(item) {
  return String(item?.url || '').startsWith('/') ? '_self' : '_blank'
}

function openExternalResult() {
  if (!searchResult.value?.externalUrl) return
  window.open(searchResult.value.externalUrl, '_blank', 'noopener,noreferrer')
}

function highlight(value) {
  return createHighlightedSegments(value, query.value)
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
  <div ref="searchShell" class="search-shell">
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

        <div v-if="showSwitcher" class="engine-switcher" role="menu" aria-label="搜索引擎">
          <button
            v-for="engine in allEngines"
            :key="engine.id"
            class="engine-switcher__item"
            type="button"
            role="menuitem"
            :class="{ 'is-active': currentEngine.id === engine.id }"
            @click="selectEngine(engine.id)"
          >
            <span class="engine-switcher__monogram" aria-hidden="true">{{ engine.icon }}</span>
            <span>{{ engine.name }}</span>
            <Icon v-if="currentEngine.id === engine.id" name="check" :size="15" />
          </button>
        </div>
      </div>

      <div class="search-box__field">
        <Icon class="search-box__field-icon" name="search" :size="18" />
        <input
          ref="queryInput"
          v-model="query"
          type="search"
          class="search-box__input"
          placeholder="搜索导航、笔记，或继续搜索 Web"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="workspace-search-results"
          :aria-expanded="shouldShowLocalPanel"
          :aria-activedescendant="activeResultIndex >= 0 ? `workspace-result-${activeResultIndex}` : undefined"
          @focus="handleInputFocus"
          @blur="isFocused = false"
          @keydown="handleKeydown"
        >
        <kbd class="search-box__shortcut">Ctrl K</kbd>
      </div>

      <button
        class="search-box__btn"
        type="button"
        :disabled="isSearching || !query.trim()"
        :aria-label="`使用 ${currentEngine.name} 搜索 Web`"
        @click="handleWebSearch"
      >
        <Icon :name="isSearching ? 'refresh' : 'external-link'" :size="17" />
        <span>{{ isSearching ? '搜索中' : 'Web 搜索' }}</span>
      </button>
    </div>

    <section
      v-if="shouldShowLocalPanel"
      id="workspace-search-results"
      class="workspace-results"
      role="listbox"
      aria-label="站内搜索结果"
    >
      <header class="workspace-results__header">
        <div>
          <div class="workspace-results__eyebrow">站内搜索</div>
          <div class="workspace-results__summary" aria-live="polite">
            <template v-if="isLocalSearching">正在检索导航与笔记</template>
            <template v-else>找到 {{ localSearchResult.total }} 项内容</template>
          </div>
        </div>
        <div class="workspace-results__header-actions">
          <button
            class="workspace-results__assistant"
            type="button"
            :disabled="isAssistantSearching"
            @click="handleAssistantQuery"
          >
            <Icon name="sparkles" :size="16" />
            {{ isAssistantSearching ? '整理中' : '问助理' }}
          </button>
          <button
            class="workspace-results__close"
            type="button"
            aria-label="关闭站内搜索结果"
            @click="showLocalResults = false"
          >
            <Icon name="close" :size="17" />
          </button>
        </div>
      </header>

      <div v-if="isLocalSearching" class="workspace-results__loading">
        <span class="workspace-results__loading-bar"></span>
        <span class="workspace-results__loading-bar"></span>
        <span class="workspace-results__loading-bar"></span>
      </div>

      <div v-else-if="localSearchError" class="workspace-results__message workspace-results__message--error">
        <Icon name="alert" :size="18" />
        <span>{{ localSearchError }}</span>
      </div>

      <template v-else>
        <div
          v-if="localSearchResult.failedSources?.length"
          class="workspace-results__message"
        >
          <Icon name="alert" :size="17" />
          <span>{{ localSearchResult.failedSources.join('、') }}暂时未完成检索，已显示其余结果。</span>
        </div>

        <div v-if="localResultGroups.length" class="workspace-results__groups">
          <section
            v-for="group in localResultGroups"
            :key="group.id"
            class="workspace-result-group"
          >
            <div class="workspace-result-group__title">
              <Icon :name="group.icon" :size="16" />
              <span>{{ group.label }}</span>
              <span class="workspace-result-group__count">{{ group.items.length }}</span>
            </div>

            <div class="workspace-result-group__list">
              <button
                v-for="item in group.items"
                :id="`workspace-result-${item.resultIndex}`"
                :key="`${item.kind}-${item.id}`"
                class="workspace-result-item"
                :class="{ 'is-active': activeResultIndex === item.resultIndex }"
                type="button"
                role="option"
                :aria-selected="activeResultIndex === item.resultIndex"
                @mouseenter="activeResultIndex = item.resultIndex"
                @click="openLocalResult(item)"
              >
                <span class="workspace-result-item__type">{{ item.kindLabel }}</span>
                <span class="workspace-result-item__body">
                  <span class="workspace-result-item__title">
                    <template v-for="(segment, index) in highlight(item.title)" :key="index">
                      <mark v-if="segment.match">{{ segment.text }}</mark>
                      <template v-else>{{ segment.text }}</template>
                    </template>
                  </span>
                  <span v-if="item.snippet" class="workspace-result-item__snippet">
                    <template v-for="(segment, index) in highlight(item.snippet)" :key="index">
                      <mark v-if="segment.match">{{ segment.text }}</mark>
                      <template v-else>{{ segment.text }}</template>
                    </template>
                  </span>
                  <span v-if="item.subtitle" class="workspace-result-item__meta">{{ item.subtitle }}</span>
                  <span v-if="item.matchReasons?.length" class="workspace-result-item__reason">
                    {{ item.matchReasons.join(' · ') }}
                  </span>
                </span>
                <Icon :name="item.kind === 'bookmark' ? 'external-link' : 'note'" :size="17" />
              </button>
            </div>
          </section>
        </div>

        <div v-else class="workspace-results__empty">
          <Icon name="search" :size="22" />
          <div>
            <div>站内没有匹配内容</div>
            <p>可继续使用 {{ currentEngine.name }} 搜索 Web。</p>
          </div>
        </div>
      </template>

      <footer class="workspace-results__footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>Enter</kbd> 打开</span>
        <span><kbd>Esc</kbd> 关闭</span>
      </footer>
    </section>

    <div v-if="isSearching || isAssistantSearching || searchError || searchResult" class="search-result-panel">
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

      <div v-if="isSearching || isAssistantSearching" class="search-result-panel__state">
        {{ isAssistantSearching ? '正在检索个人资料并整理来源...' : '正在请求 AI 搜索结果...' }}
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
            {{ searchResult.sources ? '站内来源' : (searchResult.mode === 'answer' ? '引用来源' : '搜索结果') }}
          </div>
          <div class="search-result-list">
            <a
              v-for="(item, index) in searchResult.items"
              :key="item.url || index"
              class="search-result-item"
              :href="item.url"
              :target="sourceTarget(item)"
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
  gap: 12px;
  width: min(100%, 760px);
  margin: 0 auto;
}

.search-box {
  position: relative;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  width: 100%;
  padding: 7px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--bg-card) 96%, #fff 4%), var(--bg-card));
  border: 1px solid color-mix(in srgb, var(--border-light) 76%, transparent);
  border-radius: 22px;
  box-shadow:
    0 14px 36px color-mix(in srgb, var(--text-primary) 8%, transparent),
    inset 0 1px rgba(255, 255, 255, 0.7);
  transition:
    border-color var(--transition-normal),
    box-shadow var(--transition-normal),
    transform var(--transition-normal);
}

.search-box:hover {
  border-color: color-mix(in srgb, var(--accent-color) 24%, var(--border-light));
}

.search-box.is-focused {
  border-color: color-mix(in srgb, var(--accent-color) 48%, var(--border-light));
  box-shadow:
    0 18px 46px color-mix(in srgb, var(--text-primary) 11%, transparent),
    0 0 0 4px color-mix(in srgb, var(--accent-color) 12%, transparent);
  transform: translateY(-1px);
}

.search-box__engine-wrap {
  position: relative;
  flex-shrink: 0;
}

.search-box__engine {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 44px;
  padding: 8px 12px 8px 9px;
  background: color-mix(in srgb, var(--bg-secondary) 84%, var(--bg-card));
  border: 1px solid transparent;
  border-radius: 16px;
  color: var(--text-primary);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.search-box__engine:hover {
  background: var(--bg-secondary);
  border-color: var(--border-light);
}

.search-box__icon,
.engine-switcher__monogram {
  display: inline-grid;
  place-items: center;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  color: var(--accent-color);
  background: var(--accent-bg);
  border: 1px solid color-mix(in srgb, var(--accent-color) 18%, transparent);
  border-radius: 10px;
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.02em;
}

.search-box__name {
  font-size: 13px;
  font-weight: 650;
  white-space: nowrap;
}

.engine-switcher {
  position: absolute;
  top: calc(100% + 11px);
  left: 0;
  z-index: 40;
  min-width: 218px;
  display: grid;
  gap: 4px;
  padding: 8px;
  background: color-mix(in srgb, var(--bg-card) 96%, transparent);
  border: 1px solid var(--border-light);
  border-radius: 18px;
  box-shadow: 0 18px 48px color-mix(in srgb, var(--text-primary) 16%, transparent);
  backdrop-filter: blur(18px);
}

.engine-switcher__item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 42px;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: 13px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.engine-switcher__item:hover,
.engine-switcher__item.is-active {
  background: var(--bg-secondary);
  border-color: var(--border-light);
}

.search-box__field {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding-left: 15px;
}

.search-box__field-icon {
  color: var(--text-muted);
}

.search-box__input {
  min-width: 0;
  flex: 1;
  border: none;
  background: transparent;
  padding: 12px 2px;
  font-size: 15px;
  color: var(--text-primary);
  outline: none;
}

.search-box__input::-webkit-search-cancel-button {
  display: none;
}

.search-box__input::placeholder {
  color: var(--text-muted);
}

.search-box__shortcut,
.workspace-results__footer kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 23px;
  padding: 2px 7px;
  border: 1px solid var(--border-light);
  border-bottom-color: color-mix(in srgb, var(--border-color) 72%, var(--border-light));
  border-radius: 7px;
  background: var(--bg-secondary);
  color: var(--text-muted);
  font: 600 10px/1 system-ui, sans-serif;
  white-space: nowrap;
}

.search-box__btn {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px 16px;
  background: var(--text-primary);
  color: var(--bg-card);
  border: none;
  border-radius: 16px;
  font-size: 13px;
  font-weight: 650;
  cursor: pointer;
  transition: transform var(--transition-fast), opacity var(--transition-fast);
}

.search-box__btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.search-box__btn:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.search-box__btn:disabled svg {
  animation: search-spin 0.9s linear infinite;
}

@keyframes search-spin {
  to { transform: rotate(360deg); }
}

.workspace-results {
  position: absolute;
  top: calc(100% + 2px);
  left: 0;
  z-index: 35;
  width: 100%;
  max-height: min(70vh, 620px);
  overflow: auto;
  padding: 12px;
  background: color-mix(in srgb, var(--bg-card) 95%, transparent);
  border: 1px solid var(--border-light);
  border-radius: 24px;
  box-shadow:
    0 24px 70px color-mix(in srgb, var(--text-primary) 18%, transparent),
    inset 0 1px rgba(255, 255, 255, 0.62);
  backdrop-filter: blur(22px);
}

.workspace-results__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 4px 5px 11px;
}

.workspace-results__eyebrow {
  color: var(--accent-color);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

.workspace-results__summary {
  margin-top: 4px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 650;
}

.workspace-results__header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.workspace-results__assistant {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 11px;
  border: 1px solid color-mix(in srgb, var(--accent-color) 24%, var(--border-light));
  border-radius: 11px;
  background: var(--accent-bg);
  color: var(--accent-color);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 650;
}

.workspace-results__assistant:disabled {
  cursor: wait;
  opacity: 0.62;
}

.workspace-results__close {
  width: 44px;
  height: 44px;
  display: grid;
  place-items: center;
  border: 1px solid transparent;
  border-radius: 11px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.workspace-results__close:hover {
  background: var(--bg-secondary);
  border-color: var(--border-light);
  color: var(--text-primary);
}

.workspace-results__loading {
  display: grid;
  gap: 8px;
  padding: 8px 4px 14px;
}

.workspace-results__loading-bar {
  height: 46px;
  border-radius: 14px;
  background:
    linear-gradient(
      90deg,
      var(--bg-secondary) 0%,
      color-mix(in srgb, var(--bg-secondary) 70%, var(--bg-card)) 50%,
      var(--bg-secondary) 100%
    );
  background-size: 220% 100%;
  animation: search-shimmer 1.15s linear infinite;
}

@keyframes search-shimmer {
  to { background-position: -220% 0; }
}

.workspace-results__groups {
  display: grid;
  gap: 14px;
}

.workspace-result-group__title {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 6px 7px;
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 650;
}

.workspace-result-group__count {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 20px;
  margin-left: 2px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg-secondary);
  color: var(--text-muted);
  font-size: 10px;
}

.workspace-result-group__list {
  display: grid;
  gap: 4px;
}

.workspace-result-item {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 11px 12px;
  border: 1px solid transparent;
  border-radius: 16px;
  background: transparent;
  color: var(--text-primary);
  text-align: left;
  cursor: pointer;
}

.workspace-result-item:hover,
.workspace-result-item.is-active {
  background: var(--bg-secondary);
  border-color: color-mix(in srgb, var(--accent-color) 18%, var(--border-light));
}

.workspace-result-item__type {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 48px;
  min-height: 28px;
  padding: 5px 8px;
  border-radius: 9px;
  background: var(--accent-bg);
  color: var(--accent-color);
  font-size: 10px;
  font-weight: 700;
  white-space: nowrap;
}

.workspace-result-item__body {
  min-width: 0;
  display: grid;
  gap: 3px;
}

.workspace-result-item__title,
.workspace-result-item__snippet,
.workspace-result-item__meta,
.workspace-result-item__reason {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.workspace-result-item__title {
  font-size: 14px;
  font-weight: 650;
}

.workspace-result-item__snippet {
  color: var(--text-secondary);
  font-size: 12px;
}

.workspace-result-item__meta {
  color: var(--text-muted);
  font-size: 10px;
}

.workspace-result-item__reason {
  color: var(--accent-color);
  font-size: 10px;
}

.workspace-result-item mark {
  padding: 0 2px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent-color) 22%, transparent);
  color: inherit;
}

.workspace-result-item > svg {
  color: var(--text-muted);
}

.workspace-results__message,
.workspace-results__empty {
  display: flex;
  align-items: center;
  gap: 11px;
  margin: 2px 0 10px;
  padding: 14px;
  border-radius: 15px;
  background: var(--bg-secondary);
  color: var(--text-secondary);
  font-size: 12px;
}

.workspace-results__message--error {
  color: var(--error-color);
}

.workspace-results__empty {
  min-height: 92px;
  justify-content: center;
}

.workspace-results__empty > svg {
  color: var(--accent-color);
}

.workspace-results__empty > div > div {
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 650;
}

.workspace-results__empty p {
  margin: 4px 0 0;
  color: var(--text-muted);
  font-size: 12px;
}

.workspace-results__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 14px;
  margin-top: 10px;
  padding: 10px 4px 1px;
  border-top: 1px solid var(--border-light);
  color: var(--text-muted);
  font-size: 10px;
}

.workspace-results__footer span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.search-result-panel {
  width: 100%;
  padding: 20px;
  background: color-mix(in srgb, var(--bg-card) 92%, var(--accent-color) 8%);
  border: 1px solid var(--border-light);
  border-radius: 24px;
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
  color: var(--error-color);
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

@media (max-width: 680px) {
  .search-box {
    grid-template-columns: auto minmax(0, 1fr) auto;
    border-radius: 20px;
  }

  .search-box__engine {
    padding-right: 9px;
  }

  .search-box__engine .search-box__name,
  .search-box__engine > svg,
  .search-box__shortcut,
  .search-box__btn span {
    display: none;
  }

  .search-box__field {
    padding-left: 9px;
  }

  .search-box__input {
    font-size: 14px;
  }

  .search-box__btn {
    width: 44px;
    padding: 0;
  }

  .engine-switcher {
    min-width: min(218px, calc(100vw - 40px));
  }

  .workspace-results {
    max-height: min(72vh, 560px);
    border-radius: 20px;
  }

  .workspace-result-item {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .workspace-result-item__type {
    display: none;
  }

  .workspace-results__footer {
    justify-content: flex-start;
    overflow-x: auto;
  }

  .search-result-panel__header {
    flex-direction: column;
  }
}

@media (prefers-reduced-motion: reduce) {
  .workspace-results__loading-bar {
    animation: none;
  }
}
</style>
