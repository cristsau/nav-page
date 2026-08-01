<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Icon from '@/shared/components/Icon.vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  }
})

const emit = defineEmits(['close', 'execute'])

const panelRef = ref(null)
const searchInputRef = ref(null)
const query = ref('')
const activeIndex = ref(0)
let previousBodyOverflow = ''
let bodyScrollLocked = false

const commands = [
  {
    id: 'go-navigation',
    group: '页面',
    label: '打开导航首页',
    description: '查看分组、书签和常用网站',
    keywords: '首页 导航 书签 网站 navigation home',
    icon: 'compass',
    path: '/'
  },
  {
    id: 'go-whisper',
    group: '页面',
    label: '打开笔记与备忘录',
    description: '查找日记、备忘录和资料',
    keywords: '笔记 备忘录 日记 时光 note memo diary',
    icon: 'note',
    path: '/whisper'
  },
  {
    id: 'go-media',
    group: '页面',
    label: '打开图片库',
    description: '管理笔记图片、引用和分享链接',
    keywords: '图片 图床 媒体 分享 清理 image media gallery',
    icon: 'image',
    path: '/media'
  },
  {
    id: 'go-settings',
    group: '页面',
    label: '打开设置',
    description: '管理主题、搜索与 AI 配置',
    keywords: '设置 配置 主题 搜索 AI 模型 settings',
    icon: 'settings',
    path: '/settings'
  },
  {
    id: 'create-bookmark',
    group: '快速操作',
    label: '新建书签',
    description: '复用导航页的添加书签流程',
    keywords: '添加 新建 收藏 链接 网址 bookmark link',
    icon: 'link',
    path: '/',
    action: 'create-bookmark'
  },
  {
    id: 'create-memo',
    group: '快速操作',
    label: '新建备忘录',
    description: '记录任务、资料或灵感',
    keywords: '添加 新建 备忘 待办 memo todo',
    icon: 'list',
    path: '/whisper',
    action: 'create-memo'
  },
  {
    id: 'view-due-reminders',
    group: '快速操作',
    label: '查看到期提醒',
    description: '查看已到期备忘录和未读提醒',
    keywords: '提醒 到期 逾期 截止时间 deadline reminder',
    icon: 'clock',
    path: '/whisper',
    action: 'view-due-reminders'
  },
  {
    id: 'create-diary',
    group: '快速操作',
    label: '新建日记',
    description: '记录今天发生的事情',
    keywords: '添加 新建 日记 diary journal',
    icon: 'book',
    path: '/whisper',
    action: 'create-diary'
  },
  {
    id: 'focus-site-search',
    group: '快速操作',
    label: '搜索导航与笔记',
    description: '聚焦首页站内搜索，也可以继续搜索 Web',
    keywords: '搜索 查找 导航 笔记 web search',
    icon: 'search',
    path: '/',
    action: 'focus-site-search'
  }
]

const normalizedQuery = computed(() => query.value.trim().toLocaleLowerCase('zh-CN'))
const filteredCommands = computed(() => {
  if (!normalizedQuery.value) return commands

  const terms = normalizedQuery.value.split(/\s+/).filter(Boolean)
  return commands.filter((command) => {
    const haystack = [
      command.label,
      command.description,
      command.keywords,
      command.group
    ].join(' ').toLocaleLowerCase('zh-CN')

    return terms.every((term) => haystack.includes(term))
  })
})

const commandGroups = computed(() => {
  const groups = []

  for (const command of filteredCommands.value) {
    let group = groups.find((item) => item.name === command.group)
    if (!group) {
      group = { name: command.group, commands: [] }
      groups.push(group)
    }
    group.commands.push(command)
  }

  return groups
})

const activeCommand = computed(() => filteredCommands.value[activeIndex.value] || null)

watch(() => props.show, async (show) => {
  if (show) {
    if (!bodyScrollLocked) {
      previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      bodyScrollLocked = true
    }
    query.value = ''
    activeIndex.value = 0
    await nextTick()
    searchInputRef.value?.focus()
    return
  }

  if (bodyScrollLocked) {
    document.body.style.overflow = previousBodyOverflow
    bodyScrollLocked = false
  }
})

watch(query, () => {
  activeIndex.value = 0
})

watch(filteredCommands, (items) => {
  if (!items.length) {
    activeIndex.value = -1
  } else if (activeIndex.value < 0 || activeIndex.value >= items.length) {
    activeIndex.value = 0
  }
})

onBeforeUnmount(() => {
  if (bodyScrollLocked) {
    document.body.style.overflow = previousBodyOverflow
  }
})

function commandIndex(command) {
  return filteredCommands.value.findIndex((item) => item.id === command.id)
}

function requestClose() {
  emit('close')
}

function executeCommand(command = activeCommand.value) {
  if (!command) return
  emit('execute', command)
}

function handleKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }

  if (event.key === 'Tab') {
    const focusable = [...(panelRef.value?.querySelectorAll(
      'input:not([disabled]):not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'
    ) || [])]

    if (focusable.length < 2) {
      event.preventDefault()
      focusable[0]?.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
    return
  }

  if (event.target !== searchInputRef.value) return

  if (event.key === 'ArrowDown' && filteredCommands.value.length) {
    event.preventDefault()
    activeIndex.value = (activeIndex.value + 1) % filteredCommands.value.length
    return
  }

  if (event.key === 'ArrowUp' && filteredCommands.value.length) {
    event.preventDefault()
    activeIndex.value = (
      activeIndex.value - 1 + filteredCommands.value.length
    ) % filteredCommands.value.length
    return
  }

  if (event.key === 'Enter') {
    event.preventDefault()
    executeCommand()
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="command-palette">
      <div
        v-if="show"
        class="command-palette"
        role="presentation"
        @pointerdown.self="requestClose"
      >
        <section
          ref="panelRef"
          class="command-palette__dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="command-palette-title"
          aria-describedby="command-palette-description"
          @keydown="handleKeydown"
        >
          <header class="command-palette__header">
            <div>
              <p class="command-palette__eyebrow">DOMO NAV</p>
              <h2 id="command-palette-title">命令面板</h2>
              <p id="command-palette-description">搜索页面或直接执行常用操作</p>
            </div>
            <button
              class="command-palette__close"
              type="button"
              aria-label="关闭命令面板"
              @click="requestClose"
            >
              <Icon name="close" :size="18" />
            </button>
          </header>

          <label class="command-palette__search">
            <Icon name="search" :size="19" />
            <input
              ref="searchInputRef"
              v-model="query"
              type="search"
              role="combobox"
              autocomplete="off"
              aria-autocomplete="list"
              aria-controls="command-palette-list"
              :aria-expanded="filteredCommands.length > 0"
              :aria-activedescendant="activeCommand ? `command-option-${activeCommand.id}` : undefined"
              placeholder="搜索命令、页面或操作"
            >
            <kbd>Esc</kbd>
          </label>

          <div
            id="command-palette-list"
            class="command-palette__list"
            role="listbox"
            aria-label="可用命令"
          >
            <template v-if="filteredCommands.length">
              <section
                v-for="group in commandGroups"
                :key="group.name"
                class="command-palette__group"
                role="group"
                :aria-label="group.name"
              >
                <h3>{{ group.name }}</h3>
                <button
                  v-for="command in group.commands"
                  :id="`command-option-${command.id}`"
                  :key="command.id"
                  class="command-palette__option"
                  :class="{ 'is-active': commandIndex(command) === activeIndex }"
                  type="button"
                  role="option"
                  tabindex="-1"
                  :aria-selected="commandIndex(command) === activeIndex"
                  @mouseenter="activeIndex = commandIndex(command)"
                  @click="executeCommand(command)"
                >
                  <span class="command-palette__option-icon">
                    <Icon :name="command.icon" :size="19" />
                  </span>
                  <span class="command-palette__option-copy">
                    <strong>{{ command.label }}</strong>
                    <small>{{ command.description }}</small>
                  </span>
                  <span class="command-palette__enter" aria-hidden="true">Enter</span>
                </button>
              </section>
            </template>

            <div v-else class="command-palette__empty" role="status">
              <Icon name="search" :size="22" />
              <strong>没有匹配的命令</strong>
              <span>试试“笔记”“书签”或“设置”</span>
            </div>
          </div>

          <footer class="command-palette__footer" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
            <span><kbd>Enter</kbd> 执行</span>
            <span><kbd>Esc</kbd> 关闭</span>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.command-palette {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: grid;
  place-items: start center;
  padding: min(12vh, 112px) 20px 24px;
  overflow-y: auto;
  background: color-mix(in srgb, #1b1511 52%, transparent);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
}

.command-palette__dialog {
  width: min(680px, 100%);
  max-height: min(720px, calc(100dvh - 48px));
  overflow: hidden;
  color: var(--text-primary);
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--bg-card) 96%, white), var(--bg-card));
  border: 1px solid color-mix(in srgb, var(--border-color) 82%, var(--accent-color));
  border-radius: 24px;
  box-shadow:
    0 30px 90px rgba(26, 18, 12, 0.28),
    0 2px 10px rgba(26, 18, 12, 0.08);
}

.command-palette__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 24px 18px;
}

.command-palette__eyebrow {
  margin: 0 0 5px;
  color: var(--accent-color);
  font-size: 0.68rem;
  font-weight: 760;
  letter-spacing: 0.16em;
}

.command-palette__header h2 {
  margin: 0;
  font-size: clamp(1.28rem, 4vw, 1.65rem);
  line-height: 1.15;
  letter-spacing: -0.035em;
}

.command-palette__header p:last-child {
  margin: 7px 0 0;
  color: var(--text-secondary);
  font-size: 0.86rem;
}

.command-palette__close {
  display: grid;
  flex: 0 0 auto;
  width: 40px;
  height: 40px;
  padding: 0;
  place-items: center;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-light);
  border-radius: 13px;
  cursor: pointer;
}

.command-palette__close:hover,
.command-palette__close:focus-visible {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.command-palette__search {
  display: flex;
  align-items: center;
  gap: 11px;
  margin: 0 24px 10px;
  padding: 0 14px;
  color: var(--text-muted);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 15px;
  transition: border-color 0.18s ease, box-shadow 0.18s ease;
}

.command-palette__search:focus-within {
  color: var(--accent-color);
  border-color: color-mix(in srgb, var(--accent-color) 66%, var(--border-color));
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent-color) 12%, transparent);
}

.command-palette__search input {
  min-width: 0;
  height: 50px;
  flex: 1;
  color: var(--text-primary);
  font: inherit;
  font-size: 0.96rem;
  background: transparent;
  border: 0;
  outline: 0;
}

.command-palette__search input::placeholder {
  color: var(--text-muted);
}

.command-palette kbd {
  display: inline-flex;
  min-width: 24px;
  height: 23px;
  padding: 0 6px;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-family: inherit;
  font-size: 0.67rem;
  line-height: 1;
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 7px;
  box-shadow: 0 1px 0 var(--border-color);
}

.command-palette__list {
  max-height: min(430px, 52dvh);
  padding: 5px 14px 14px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.command-palette__group + .command-palette__group {
  margin-top: 8px;
}

.command-palette__group h3 {
  margin: 0;
  padding: 10px 10px 7px;
  color: var(--text-muted);
  font-size: 0.68rem;
  font-weight: 720;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

.command-palette__option {
  display: grid;
  width: 100%;
  grid-template-columns: 42px minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 10px;
  color: var(--text-primary);
  text-align: left;
  background: transparent;
  border: 0;
  border-radius: 14px;
  cursor: pointer;
}

.command-palette__option.is-active {
  background: color-mix(in srgb, var(--accent-bg) 72%, var(--bg-hover));
}

.command-palette__option-icon {
  display: grid;
  width: 42px;
  height: 42px;
  place-items: center;
  color: var(--accent-color);
  background: color-mix(in srgb, var(--accent-bg) 76%, var(--bg-card));
  border: 1px solid color-mix(in srgb, var(--accent-color) 18%, var(--border-light));
  border-radius: 13px;
}

.command-palette__option-copy {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.command-palette__option-copy strong {
  overflow: hidden;
  font-size: 0.91rem;
  font-weight: 680;
  line-height: 1.25;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-palette__option-copy small {
  overflow: hidden;
  color: var(--text-secondary);
  font-size: 0.76rem;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-palette__enter {
  color: var(--text-muted);
  font-size: 0.68rem;
  opacity: 0;
  transform: translateX(-4px);
  transition: opacity 0.16s ease, transform 0.16s ease;
}

.command-palette__option.is-active .command-palette__enter {
  opacity: 1;
  transform: translateX(0);
}

.command-palette__empty {
  display: grid;
  min-height: 190px;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: var(--text-muted);
  text-align: center;
}

.command-palette__empty strong {
  color: var(--text-primary);
  font-size: 0.94rem;
}

.command-palette__empty span {
  font-size: 0.78rem;
}

.command-palette__footer {
  display: flex;
  min-height: 44px;
  padding: 9px 24px;
  align-items: center;
  justify-content: flex-end;
  gap: 18px;
  color: var(--text-muted);
  font-size: 0.68rem;
  background: color-mix(in srgb, var(--bg-secondary) 72%, var(--bg-card));
  border-top: 1px solid var(--border-light);
}

.command-palette__footer span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.command-palette-enter-active,
.command-palette-leave-active {
  transition: opacity 0.2s ease;
}

.command-palette-enter-active .command-palette__dialog,
.command-palette-leave-active .command-palette__dialog {
  transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.2s ease;
}

.command-palette-enter-from,
.command-palette-leave-to {
  opacity: 0;
}

.command-palette-enter-from .command-palette__dialog,
.command-palette-leave-to .command-palette__dialog {
  opacity: 0;
  transform: translateY(-12px) scale(0.985);
}

@media (max-width: 640px) {
  .command-palette {
    align-items: end;
    padding: 16px 10px max(10px, env(safe-area-inset-bottom));
  }

  .command-palette__dialog {
    max-height: min(760px, calc(100dvh - 26px));
    border-radius: 24px 24px 18px 18px;
  }

  .command-palette__header {
    padding: 20px 18px 15px;
  }

  .command-palette__search {
    margin-right: 18px;
    margin-left: 18px;
  }

  .command-palette__list {
    max-height: min(440px, 53dvh);
    padding-right: 8px;
    padding-left: 8px;
  }

  .command-palette__option {
    min-height: 58px;
  }

  .command-palette__enter,
  .command-palette__footer {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .command-palette-enter-active,
  .command-palette-leave-active,
  .command-palette-enter-active .command-palette__dialog,
  .command-palette-leave-active .command-palette__dialog,
  .command-palette__search,
  .command-palette__enter {
    transition-duration: 0.01ms !important;
  }
}
</style>
