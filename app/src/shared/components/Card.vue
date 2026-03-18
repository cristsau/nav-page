<script setup>
defineProps({
  clickable: {
    type: Boolean,
    default: false
  },
  padding: {
    type: String,
    default: '16px'
  }
})

const emit = defineEmits(['click'])
</script>

<template>
  <div
    class="card"
    :class="{ 'card--clickable': clickable }"
    :style="{ padding }"
    @click="clickable && $emit('click')"
  >
    <slot />
  </div>
</template>

<style scoped>
.card {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  transition: box-shadow var(--transition), border-color var(--transition);
}

.card:hover {
  box-shadow: var(--shadow-sm);
}

.card--clickable {
  cursor: pointer;
}

.card--clickable:hover {
  border-color: var(--accent-color);
}
</style>
