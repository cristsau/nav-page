<script setup>
import Icon from '@/shared/components/Icon.vue'

const props = defineProps({
  value: {
    type: [String, Number],
    default: ''
  },
  label: {
    type: String,
    default: '内容'
  }
})

const emit = defineEmits(['copy'])

function requestCopy() {
  const value = String(props.value ?? '').trim()
  if (!value) return

  emit('copy', {
    value,
    label: props.label
  })
}
</script>

<template>
  <button
    type="button"
    class="copyable-value"
    :title="`复制${label}`"
    :aria-label="`复制${label}`"
    @click.stop="requestCopy"
  >
    <span class="copyable-value__text"><slot>{{ value }}</slot></span>
    <span class="copyable-value__icon" aria-hidden="true">
      <Icon name="copy" :size="13" />
    </span>
  </button>
</template>

<style scoped>
.copyable-value {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  min-width: 0;
  min-height: 24px;
  margin: -2px -5px;
  padding: 2px 5px;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font: inherit;
  text-align: inherit;
  cursor: copy;
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    box-shadow var(--transition-fast);
}

.copyable-value__text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.copyable-value:hover,
.copyable-value:focus-visible {
  color: var(--accent-color);
  background: var(--accent-bg);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-color) 28%, transparent);
  outline: none;
}

.copyable-value__icon {
  display: inline-flex;
  flex: 0 0 auto;
  opacity: 0;
  transform: translateX(-3px);
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.copyable-value:hover .copyable-value__icon,
.copyable-value:focus-visible .copyable-value__icon {
  opacity: 1;
  transform: translateX(0);
}

@media (hover: none) {
  .copyable-value {
    min-height: 44px;
    padding: 6px 7px;
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent-color) 42%, transparent);
    text-decoration-style: dotted;
    text-underline-offset: 3px;
  }

  .copyable-value__icon {
    opacity: 0.58;
    transform: none;
  }
}
</style>
