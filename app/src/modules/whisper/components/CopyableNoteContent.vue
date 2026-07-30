<script setup>
import { computed } from 'vue'
import Icon from '@/shared/components/Icon.vue'
import { parseCopyableContent } from '@/shared/utils/copyableText'

const props = defineProps({
  content: {
    type: String,
    default: ''
  }
})

const emit = defineEmits(['copy'])
const lines = computed(() => parseCopyableContent(props.content))

function requestCopy(value, label) {
  const normalized = String(value ?? '').trim()
  if (!normalized) return

  emit('copy', {
    value: normalized,
    label: label || '内容'
  })
}

function getCopyAriaLabel(line, label) {
  const target = label === '整行' ? '整行内容' : label
  return `复制第 ${line.id + 1} 行的${target}`
}

function getTokenAriaLabel(line, label, segmentIndex) {
  const ordinal = line.segments
    .slice(0, segmentIndex + 1)
    .filter((segment) => segment.type === 'copy')
    .length
  return `复制第 ${line.id + 1} 行第 ${ordinal} 个${label}`
}
</script>

<template>
  <div class="copyable-content" role="document" aria-label="可复制的笔记正文">
    <div
      v-for="line in lines"
      :key="line.id"
      class="copyable-line"
      :class="{ 'has-copy-target': line.copyTarget }"
    >
      <span class="copyable-line__text">
        <template v-for="(segment, index) in line.segments" :key="`${line.id}-${index}`">
          <span v-if="segment.type === 'text'">{{ segment.value }}</span>
          <button
            v-else
            type="button"
            class="copyable-token"
            :class="`is-${segment.kind}`"
            :title="`复制${segment.label}`"
            :aria-label="getTokenAriaLabel(line, segment.label, index)"
            @click.stop="requestCopy(segment.value, segment.label)"
          >
            {{ segment.value }}
            <span class="copyable-token__hint" aria-hidden="true">
              <Icon name="copy" :size="12" />
            </span>
          </button>
        </template>
      </span>

      <button
        v-if="line.copyTarget"
        type="button"
        class="copyable-line__action"
        :title="line.copyTarget.label === '整行' ? '复制整行' : `复制${line.copyTarget.label}`"
        :aria-label="getCopyAriaLabel(line, line.copyTarget.label)"
        @click.stop="requestCopy(line.copyTarget.value, line.copyTarget.label)"
      >
        <Icon name="copy" :size="13" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.copyable-content {
  color: var(--text-primary);
  font: inherit;
  line-height: 1.8;
}

.copyable-line {
  position: relative;
  min-height: 1.8em;
  margin: 0 -7px;
  padding: 0 34px 0 7px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  transition:
    background var(--transition-fast),
    box-shadow var(--transition-fast);
}

.copyable-line.has-copy-target:hover,
.copyable-line.has-copy-target:focus-within {
  background: color-mix(in srgb, var(--accent-bg) 72%, transparent);
  box-shadow: inset 2px 0 0 color-mix(in srgb, var(--accent-color) 64%, transparent);
}

.copyable-line__action {
  position: absolute;
  top: 50%;
  right: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  color: var(--accent-color);
  background: var(--bg-card);
  border: 1px solid color-mix(in srgb, var(--accent-color) 24%, var(--border-light));
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
  opacity: 0;
  cursor: copy;
  transform: translate(3px, -50%);
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast),
    background var(--transition-fast);
}

.copyable-line:hover .copyable-line__action,
.copyable-line:focus-within .copyable-line__action,
.copyable-line__action:focus-visible {
  opacity: 1;
  transform: translate(0, -50%);
}

.copyable-line__action:hover,
.copyable-line__action:focus-visible {
  background: var(--accent-bg);
  outline: 2px solid color-mix(in srgb, var(--accent-color) 35%, transparent);
  outline-offset: 1px;
}

.copyable-token {
  position: relative;
  display: inline;
  margin: -1px 0;
  padding: 1px 3px;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 5px;
  font: inherit;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
  cursor: copy;
  transition:
    color var(--transition-fast),
    background var(--transition-fast),
    box-shadow var(--transition-fast);
}

.copyable-token:hover,
.copyable-token:focus-visible {
  color: var(--accent-color);
  background: var(--accent-bg);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent-color) 32%, transparent);
  outline: none;
}

.copyable-token__hint {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 5px);
  z-index: 4;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 22px;
  color: #fff;
  background: var(--accent-color);
  border-radius: 7px;
  box-shadow: var(--shadow-sm);
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 4px);
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.copyable-token:hover .copyable-token__hint,
.copyable-token:focus-visible .copyable-token__hint {
  opacity: 1;
  transform: translate(-50%, 0);
}

@media (hover: none) {
  .copyable-line.has-copy-target {
    display: flex;
    align-items: center;
    min-height: 48px;
  }

  .copyable-line__text {
    min-width: 0;
  }

  .copyable-token {
    display: inline-flex;
    align-items: center;
    min-height: 44px;
    margin: -4px 0;
    padding: 4px 6px;
    color: color-mix(in srgb, var(--text-primary) 86%, var(--accent-color));
    text-decoration: underline;
    text-decoration-color: color-mix(in srgb, var(--accent-color) 45%, transparent);
    text-decoration-style: dotted;
    text-underline-offset: 3px;
  }

  .copyable-token__hint {
    display: none;
  }

  .copyable-line__action {
    width: 44px;
    height: 44px;
    right: 0;
    background: transparent;
    box-shadow: none;
    opacity: 0.4;
    transform: translate(0, -50%);
  }
}
</style>
