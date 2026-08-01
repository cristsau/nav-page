import { nextTick, readonly, ref } from 'vue'

export const COMMAND_ACTION_EVENT = 'domo-nav:command-action'

const commandPaletteOpen = ref(false)
let restoreFocusElement = null

export function dispatchCommandAction(action) {
  if (!action) return

  window.dispatchEvent(new CustomEvent(COMMAND_ACTION_EVENT, {
    detail: { action }
  }))
}

export function useCommandPalette() {
  function openCommandPalette(triggerElement = document.activeElement) {
    if (!commandPaletteOpen.value && triggerElement instanceof HTMLElement) {
      restoreFocusElement = triggerElement
    }

    commandPaletteOpen.value = true
  }

  async function closeCommandPalette({ restoreFocus = true } = {}) {
    const focusTarget = restoreFocusElement
    commandPaletteOpen.value = false
    restoreFocusElement = null

    if (!restoreFocus || !focusTarget?.isConnected) return

    await nextTick()
    focusTarget.focus()
  }

  function toggleCommandPalette(triggerElement = document.activeElement) {
    if (commandPaletteOpen.value) {
      closeCommandPalette()
    } else {
      openCommandPalette(triggerElement)
    }
  }

  function handleCommandPaletteShortcut(event) {
    const isShortcut = (
      (event.ctrlKey || event.metaKey)
      && !event.altKey
      && !event.shiftKey
      && event.key.toLowerCase() === 'k'
    )

    if (!isShortcut) return false

    event.preventDefault()
    event.stopImmediatePropagation()

    if (!event.repeat) {
      toggleCommandPalette(event.target)
    }

    return true
  }

  return {
    isOpen: readonly(commandPaletteOpen),
    openCommandPalette,
    closeCommandPalette,
    toggleCommandPalette,
    handleCommandPaletteShortcut
  }
}
