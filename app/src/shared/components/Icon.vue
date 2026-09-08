<script setup>
import { computed } from 'vue'

const props = defineProps({
  name: {
    type: String,
    required: true
  },
  size: {
    type: [Number, String],
    default: 20
  },
  strokeWidth: {
    type: [Number, String],
    default: 1.8
  },
  label: {
    type: String,
    default: ''
  }
})

const iconPaths = {
  'chevron-right': [ ['path', { d: 'm9 18 6-6-6-6' }] ],
  'scan-face': [
    ['path', { d: 'M4 7V4h3M17 4h3v3M20 17v3h-3M7 20H4v-3M9 9v1M15 9v1M12 9v4h-1M9 16c1.5 1 4.5 1 6 0' }]
  ],
  alert: [
    ['path', { d: 'M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z' }],
    ['path', { d: 'M12 9v4' }],
    ['path', { d: 'M12 17h.01' }]
  ],
  'arrow-left': [
    ['path', { d: 'm15 18-6-6 6-6' }]
  ],
  bell: [
    ['path', { d: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9' }],
    ['path', { d: 'M10 21h4' }]
  ],
  'bell-off': [
    ['path', { d: 'M13.7 21h-3.4' }],
    ['path', { d: 'M18.6 8.6A6 6 0 0 0 8 5.3' }],
    ['path', { d: 'M6 8c0 7-3 7-3 9h14' }],
    ['path', { d: 'm3 3 18 18' }]
  ],
  book: [
    ['path', { d: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20' }],
    ['path', { d: 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z' }]
  ],
  briefcase: [
    ['rect', { x: 3, y: 7, width: 18, height: 13, rx: 2 }],
    ['path', { d: 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2' }]
  ],
  browser: [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ['path', { d: 'M3 9h18' }],
    ['path', { d: 'M8 6.5h.01M12 6.5h.01' }]
  ],
  calendar: [
    ['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }],
    ['path', { d: 'M16 3v4M8 3v4M3 11h18' }]
  ],
  check: [
    ['path', { d: 'm5 12 4 4L19 6' }]
  ],
  'chevron-down': [
    ['path', { d: 'm6 9 6 6 6-6' }]
  ],
  'circle-check': [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'm8 12 2.7 2.7L16.5 9' }]
  ],
  'circle-x': [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'm9 9 6 6m0-6-6 6' }]
  ],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 7v5l3 2' }]
  ],
  cloud: [
    ['path', { d: 'M17.5 19H6a4 4 0 0 1-.6-8A6.5 6.5 0 0 1 18 9.5a4.8 4.8 0 0 1-.5 9.5Z' }]
  ],
  close: [
    ['path', { d: 'M6 6l12 12M18 6 6 18' }]
  ],
  command: [
    ['path', { d: 'M9 7V5a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v14a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V7Z' }]
  ],
  code: [
    ['path', { d: 'm8 9-3 3 3 3M16 9l3 3-3 3M14 5l-4 14' }]
  ],
  compass: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'm15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9 4.9-2.1Z' }]
  ],
  copy: [
    ['rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }],
    ['path', { d: 'M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2' }]
  ],
  download: [
    ['path', { d: 'M12 3v12m0 0 4-4m-4 4-4-4' }],
    ['path', { d: 'M5 21h14' }]
  ],
  database: [
    ['ellipse', { cx: 12, cy: 5, rx: 8, ry: 3 }],
    ['path', { d: 'M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5' }],
    ['path', { d: 'M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7' }]
  ],
  edit: [
    ['path', { d: 'M12 20h9' }],
    ['path', { d: 'M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z' }]
  ],
  extension: [
    ['path', { d: 'M9 3h6v4h3a3 3 0 1 1 0 6h-3v8H9v-3a3 3 0 1 0-6 0v3H3v-8h3a3 3 0 1 0 0-6H3V3h6Z' }]
  ],
  'external-link': [
    ['path', { d: 'M15 4h5v5M14 10l6-6' }],
    ['path', { d: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]
  ],
  folder: [
    ['path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }]
  ],
  archive: [
    ['rect', { x: 3, y: 4, width: 18, height: 5, rx: 1 }],
    ['path', { d: 'M5 9v11h14V9M10 13h4' }]
  ],
  attachment: [
    ['path', { d: 'm21.4 11.6-8.9 8.9a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 1 1-2.8-2.8l8.5-8.5' }]
  ],
  forward: [
    ['path', { d: 'm15 8 5 4-5 4v-3H9a5 5 0 0 0-5 5v-2a7 7 0 0 1 7-7h4Z' }]
  ],
  'grip-vertical': [
    ['circle', { cx: 9, cy: 5, r: 1 }],
    ['circle', { cx: 15, cy: 5, r: 1 }],
    ['circle', { cx: 9, cy: 12, r: 1 }],
    ['circle', { cx: 15, cy: 12, r: 1 }],
    ['circle', { cx: 9, cy: 19, r: 1 }],
    ['circle', { cx: 15, cy: 19, r: 1 }]
  ],
  heart: [
    ['path', { d: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z' }]
  ],
  image: [
    ['rect', { x: 3, y: 3, width: 18, height: 18, rx: 2 }],
    ['circle', { cx: 8.5, cy: 8.5, r: 1.5 }],
    ['path', { d: 'm21 15-5-5L5 21' }]
  ],
  key: [
    ['circle', { cx: 7.5, cy: 15.5, r: 4.5 }],
    ['path', { d: 'm10.7 12.3 8.8-8.8M15 8l2 2M17 6l2 2' }]
  ],
  link: [
    ['path', { d: 'M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1' }],
    ['path', { d: 'M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1' }]
  ],
  list: [
    ['path', { d: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' }]
  ],
  lock: [
    ['rect', { x: 5, y: 10, width: 14, height: 11, rx: 2 }],
    ['path', { d: 'M8 10V7a4 4 0 0 1 8 0v3' }]
  ],
  logout: [
    ['path', { d: 'M10 17l5-5-5-5M15 12H3' }],
    ['path', { d: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4' }]
  ],
  mail: [
    ['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }],
    ['path', { d: 'm3 7 9 6 9-6' }]
  ],
  menu: [
    ['path', { d: 'M4 7h16M4 12h16M4 17h16' }]
  ],
  'more-horizontal': [
    ['circle', { cx: 5, cy: 12, r: 1 }],
    ['circle', { cx: 12, cy: 12, r: 1 }],
    ['circle', { cx: 19, cy: 12, r: 1 }]
  ],
  moon: [
    ['path', { d: 'M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7Z' }]
  ],
  note: [
    ['path', { d: 'M4 3h13l3 3v15H4Z' }],
    ['path', { d: 'M14 3v5h6M8 12h8M8 16h6' }]
  ],
  palette: [
    ['path', { d: 'M12 3a9 9 0 0 0 0 18h1.5a1.5 1.5 0 0 0 0-3H12a2 2 0 0 1 0-4h2.5A6.5 6.5 0 0 0 21 7.5 4.5 4.5 0 0 0 16.5 3Z' }],
    ['circle', { cx: 7.5, cy: 10.5, r: 0.8 }],
    ['circle', { cx: 10, cy: 7, r: 0.8 }],
    ['circle', { cx: 14, cy: 6.5, r: 0.8 }]
  ],
  pin: [
    ['path', { d: 'm12 17 5-5-2-2 1-5-1-1-5 1-2-2-5 5 2 2 5-1 2 2-5 5' }],
    ['path', { d: 'm7 17-4 4' }]
  ],
  plus: [
    ['path', { d: 'M12 5v14M5 12h14' }]
  ],
  refresh: [
    ['path', { d: 'M20 11a8 8 0 0 0-14.9-4L3 10' }],
    ['path', { d: 'M3 4v6h6M4 13a8 8 0 0 0 14.9 4l2.1-3' }],
    ['path', { d: 'M21 20v-6h-6' }]
  ],
  reply: [
    ['path', { d: 'm9 8-5 4 5 4v-3h6a5 5 0 0 1 5 5v-2a7 7 0 0 0-7-7H9Z' }]
  ],
  'reply-all': [
    ['path', { d: 'm7 8-5 4 5 4v-3h6a5 5 0 0 1 5 5v-2a7 7 0 0 0-7-7H7Z' }],
    ['path', { d: 'm12 8-2.5 2M12 16l-2.5-2' }]
  ],
  redo: [
    ['path', { d: 'M21 7v6h-6' }],
    ['path', { d: 'M3 17a9 9 0 0 1 14.7-6.9L21 13' }]
  ],
  search: [
    ['circle', { cx: 11, cy: 11, r: 7 }],
    ['path', { d: 'm20 20-4-4' }]
  ],
  settings: [
    ['circle', { cx: 12, cy: 12, r: 3 }],
    ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z' }]
  ],
  shield: [
    ['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z' }],
    ['path', { d: 'm9 12 2 2 4-4' }]
  ],
  share: [
    ['circle', { cx: 18, cy: 5, r: 2.5 }],
    ['circle', { cx: 6, cy: 12, r: 2.5 }],
    ['circle', { cx: 18, cy: 19, r: 2.5 }],
    ['path', { d: 'm8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5' }]
  ],
  quote: [
    ['path', { d: 'M3 21c3 0 7-1 7-8V5H3v8h4c0 3-1 5-4 6' }],
    ['path', { d: 'M14 21c3 0 7-1 7-8V5h-7v8h4c0 3-1 5-4 6' }]
  ],
  sparkles: [
    ['path', { d: 'm12 3 1.1 3.2L16 8l-2.9 1.8L12 13l-1.1-3.2L8 8l2.9-1.8Z' }],
    ['path', { d: 'm5 14 .8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8Z' }],
    ['path', { d: 'm19 13 .7 1.8 1.8.7-1.8.7L19 18l-.7-1.8-1.8-.7 1.8-.7Z' }]
  ],
  star: [
    ['path', { d: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z' }]
  ],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    ['path', { d: 'M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4' }]
  ],
  tag: [
    ['path', { d: 'M20 13 13 20l-9-9V4h7Z' }],
    ['circle', { cx: 8.5, cy: 8.5, r: 1 }]
  ],
  trash: [
    ['path', { d: 'M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6M10 11v5M14 11v5' }]
  ],
  upload: [
    ['path', { d: 'M12 16V4' }],
    ['path', { d: 'm7 9 5-5 5 5' }],
    ['path', { d: 'M5 20h14' }]
  ],
  undo: [
    ['path', { d: 'M3 7v6h6' }],
    ['path', { d: 'M21 17a9 9 0 0 0-14.7-6.9L3 13' }]
  ],
  user: [
    ['circle', { cx: 12, cy: 7, r: 4 }],
    ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]
  ],
  users: [
    ['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }],
    ['circle', { cx: 9, cy: 7, r: 4 }],
    ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' }]
  ]
}

const parts = computed(() => iconPaths[props.name] || iconPaths.alert)
const pixelSize = computed(() => typeof props.size === 'number' ? `${props.size}px` : props.size)
</script>

<template>
  <svg
    class="app-icon"
    :width="pixelSize"
    :height="pixelSize"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
  >
    <component
      :is="part[0]"
      v-for="(part, index) in parts"
      :key="index"
      v-bind="part[1]"
    />
  </svg>
</template>

<style scoped>
.app-icon {
  display: block;
  flex: 0 0 auto;
}
</style>
