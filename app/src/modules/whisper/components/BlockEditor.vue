<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { DragHandle } from '@tiptap/extension-drag-handle-vue-3'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { TableKit } from '@tiptap/extension-table'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import Icon from '@/shared/components/Icon.vue'
import { useAuth } from '@/shared/composables/useAuth'
import {
  EMPTY_TIPTAP_DOCUMENT,
  isTiptapDocument,
  plainTextToTiptapDocument,
  removeTiptapImages,
  tiptapDocumentImageUrls
} from '@/shared/utils/noteRichContent'

const props = defineProps({
  modelValue: { type: Object, default: null },
  plainText: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  allowImages: { type: Boolean, default: true },
  noteId: { type: String, default: '' },
  realtime: { type: Boolean, default: false }
})
const emit = defineEmits(['update:modelValue', 'update:text', 'update:imageUrls', 'request-image', 'selection-change', 'collaboration-status'])
const { currentUser } = useAuth()
const slashOpen = ref(false)
const slashIndex = ref(0)
const collaborationStatus = ref(props.realtime ? 'loading' : 'disabled')
const collaborationEnabled = Boolean(props.realtime && props.noteId)
const ydoc = collaborationEnabled ? new Y.Doc() : null
const indexeddbProvider = collaborationEnabled
  ? new IndexeddbPersistence(`domo-nav-note-${props.noteId}`, ydoc)
  : null
const websocketProvider = collaborationEnabled
  ? new WebsocketProvider(
      `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/collaboration/ws`,
      props.noteId,
      ydoc,
      { connect: false }
    )
  : null

function collaborationUser() {
  const userId = String(currentUser.value?.id || props.noteId || 'collaborator')
  let hash = 0
  for (const character of userId) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
  const palette = ['#5e6ad2', '#3e8d7c', '#b46b55', '#8a63a8', '#b1843f', '#4f7ba8']
  return {
    name: String(currentUser.value?.username || '协作者').slice(0, 80),
    color: palette[Math.abs(hash) % palette.length]
  }
}

function initialContent() {
  if (isTiptapDocument(props.modelValue)) return props.modelValue
  if (props.plainText) return plainTextToTiptapDocument(props.plainText)
  return EMPTY_TIPTAP_DOCUMENT
}

function safeWebUrl(value) {
  try {
    const url = new URL(String(value || ''))
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : ''
  } catch {
    return ''
  }
}

const editor = useEditor({
  content: collaborationEnabled ? undefined : initialContent(),
  editable: !props.disabled,
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      ...(collaborationEnabled ? { undoRedo: false } : {})
    }),
    Underline,
    Highlight.configure({ multicolor: false }),
    Link.configure({
      autolink: true,
      openOnClick: false,
      defaultProtocol: 'https',
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' }
    }),
    Image.configure({ inline: false, allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: true } }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    Placeholder.configure({
      placeholder: '输入 / 选择内容块，或直接开始写作…',
      showOnlyCurrent: true
    }),
    ...(collaborationEnabled ? [
      Collaboration.configure({ document: ydoc, field: 'default' }),
      CollaborationCaret.configure({
        provider: websocketProvider,
        user: collaborationUser()
      })
    ] : [])
  ],
  editorProps: {
    attributes: {
      class: 'block-editor__surface',
      'aria-label': '笔记块编辑器'
    },
    handleKeyDown: (view, event) => {
      if (slashOpen.value && slashKeydown(event)) return true
      if (event.key !== '/') return false
      const parent = view.state.selection.$from.parent
      if (parent.type.name !== 'paragraph' || parent.textContent) return false
      event.preventDefault()
      slashOpen.value = true
      slashIndex.value = 0
      return true
    }
  },
  onUpdate: ({ editor: currentEditor }) => {
    const document = currentEditor.getJSON()
    emit('update:modelValue', document)
    emit('update:text', currentEditor.getText({ blockSeparator: '\n' }))
    emit('update:imageUrls', tiptapDocumentImageUrls(document))
  },
  onSelectionUpdate: ({ editor: currentEditor }) => {
    const selection = currentEditor.state.selection
    emit('selection-change', selection.empty ? null : {
      from: selection.from,
      to: selection.to,
      text: currentEditor.state.doc.textBetween(selection.from, selection.to, ' ').slice(0, 500)
    })
  }
})

watch(() => props.disabled, (disabled) => editor.value?.setEditable(!disabled))
watch(
  () => props.modelValue,
  (value) => {
    if (collaborationEnabled) return
    if (!editor.value || !isTiptapDocument(value)) return
    if (JSON.stringify(editor.value.getJSON()) !== JSON.stringify(value)) {
      editor.value.commands.setContent(value, { emitUpdate: false })
    }
  },
  { deep: true }
)

const blockLabel = computed(() => {
  if (editor.value?.isActive('heading', { level: 1 })) return '标题 1'
  if (editor.value?.isActive('heading', { level: 2 })) return '标题 2'
  if (editor.value?.isActive('heading', { level: 3 })) return '标题 3'
  if (editor.value?.isActive('codeBlock')) return '代码块'
  return '正文'
})

function run(command) {
  slashOpen.value = false
  command?.()
}

function changeBlockType(event) {
  const value = String(event?.target?.value || 'paragraph')
  const level = Number(value)
  if ([1, 2, 3].includes(level)) {
    editor.value?.chain().focus().setHeading({ level }).run()
    return
  }
  editor.value?.chain().focus().setParagraph().run()
}

function setLink() {
  const existing = editor.value?.getAttributes('link')?.href || ''
  const requested = window.prompt('输入链接地址', existing)
  if (requested === null) return
  if (!requested.trim()) {
    editor.value?.chain().focus().extendMarkRange('link').unsetLink().run()
    return
  }
  const href = safeWebUrl(requested.trim().includes('://') ? requested.trim() : `https://${requested.trim()}`)
  if (!href) return window.alert('请输入有效的 HTTP 或 HTTPS 地址')
  editor.value?.chain().focus().extendMarkRange('link').setLink({ href }).run()
}

const slashCommands = computed(() => [
  { label: '正文', hint: '普通段落', run: () => editor.value?.chain().focus().setParagraph().run() },
  { label: '标题 1', hint: '页面主标题', run: () => editor.value?.chain().focus().toggleHeading({ level: 1 }).run() },
  { label: '标题 2', hint: '章节标题', run: () => editor.value?.chain().focus().toggleHeading({ level: 2 }).run() },
  { label: '标题 3', hint: '小节标题', run: () => editor.value?.chain().focus().toggleHeading({ level: 3 }).run() },
  { label: '待办列表', hint: '可勾选任务', run: () => editor.value?.chain().focus().toggleTaskList().run() },
  { label: '项目列表', hint: '无序列表', run: () => editor.value?.chain().focus().toggleBulletList().run() },
  { label: '编号列表', hint: '有序列表', run: () => editor.value?.chain().focus().toggleOrderedList().run() },
  { label: '引用', hint: '突出一段内容', run: () => editor.value?.chain().focus().toggleBlockquote().run() },
  { label: '代码块', hint: '等宽技术内容', run: () => editor.value?.chain().focus().toggleCodeBlock().run() },
  { label: '分隔线', hint: '分隔章节', run: () => editor.value?.chain().focus().setHorizontalRule().run() },
  { label: '表格', hint: '3 × 3 表格', run: () => editor.value?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  ...(props.allowImages ? [{ label: '图片', hint: '从个人图床上传', run: () => emit('request-image') }] : [])
])

function slashKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    slashOpen.value = false
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    slashIndex.value = (slashIndex.value + 1) % slashCommands.value.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    slashIndex.value = (slashIndex.value - 1 + slashCommands.value.length) % slashCommands.value.length
  } else if (event.key === 'Enter') {
    event.preventDefault()
    run(slashCommands.value[slashIndex.value]?.run)
  } else return false
  return true
}

function insertImage(url, alt = '', title = '') {
  const src = safeWebUrl(url)
  if (src) editor.value?.chain().focus().setImage({ src, alt, title }).run()
}

function removeImage(url) {
  if (!editor.value || !url) return
  const nextDocument = removeTiptapImages(editor.value.getJSON(), url)
  editor.value.commands.setContent(nextDocument)
}

function insertText(text) {
  const content = plainTextToTiptapDocument(text).content || []
  editor.value?.chain().focus().insertContent(content).run()
}

function replaceText(text) {
  editor.value?.commands.setContent(plainTextToTiptapDocument(text))
}

defineExpose({
  focus: () => editor.value?.commands.focus(),
  getJSON: () => editor.value?.getJSON() || EMPTY_TIPTAP_DOCUMENT,
  getText: () => editor.value?.getText({ blockSeparator: '\n' }) || '',
  getSelection: () => {
    const selection = editor.value?.state?.selection
    if (!selection || selection.empty) return null
    return {
      from: selection.from,
      to: selection.to,
      text: editor.value.state.doc.textBetween(selection.from, selection.to, ' ').slice(0, 500)
    }
  },
  insertImage,
  removeImage,
  insertText,
  replaceText
})

function setCollaborationStatus(status) {
  collaborationStatus.value = status
  emit('collaboration-status', status)
}

onMounted(async () => {
  if (!collaborationEnabled) return
  websocketProvider.on('status', ({ status }) => {
    setCollaborationStatus(status === 'connected' ? 'connected' : 'offline')
  })
  websocketProvider.on('sync', (synced) => {
    if (!synced || !editor.value) return
    const config = ydoc.getMap('config')
    const fragment = ydoc.getXmlFragment('default')
    if (!config.get('initialContentLoaded')) {
      if (fragment.length === 0) editor.value.commands.setContent(initialContent())
      config.set('initialContentLoaded', true)
    }
    setCollaborationStatus('synced')
  })
  try {
    await indexeddbProvider.whenSynced
    if (!ydoc.getMap('config').get('initialContentLoaded') && ydoc.getXmlFragment('default').length > 0) {
      ydoc.getMap('config').set('initialContentLoaded', true)
    }
    setCollaborationStatus(navigator.onLine ? 'connecting' : 'offline')
    websocketProvider.connect()
  } catch {
    setCollaborationStatus('offline')
  }
})

onBeforeUnmount(() => {
  websocketProvider?.destroy()
  indexeddbProvider?.destroy()
  editor.value?.destroy()
  ydoc?.destroy()
})
</script>

<template>
  <div class="block-editor" :class="{ 'is-disabled': disabled }">
    <div v-if="collaborationEnabled" class="block-editor__collaboration" role="status">
      <span :class="`is-${collaborationStatus}`" aria-hidden="true" />
      {{ collaborationStatus === 'synced' || collaborationStatus === 'connected' ? '实时协作已连接' : collaborationStatus === 'offline' ? '离线编辑，联网后合并' : '正在连接协作服务' }}
    </div>
    <div v-if="editor" class="block-editor__toolbar" role="toolbar" aria-label="内容格式">
      <label class="block-editor__select">
        <span class="sr-only">内容块类型</span>
        <select
          :value="editor.isActive('heading', { level: 1 }) ? '1' : editor.isActive('heading', { level: 2 }) ? '2' : editor.isActive('heading', { level: 3 }) ? '3' : 'paragraph'"
          :disabled="disabled"
          @change="changeBlockType"
        >
          <option value="paragraph">正文</option>
          <option value="1">标题 1</option>
          <option value="2">标题 2</option>
          <option value="3">标题 3</option>
        </select>
      </label>
      <span class="block-editor__separator" aria-hidden="true"></span>
      <button type="button" aria-label="粗体" title="粗体" :class="{ 'is-active': editor.isActive('bold') }" :disabled="disabled" @click="editor.chain().focus().toggleBold().run()"><strong>B</strong></button>
      <button type="button" aria-label="斜体" title="斜体" :class="{ 'is-active': editor.isActive('italic') }" :disabled="disabled" @click="editor.chain().focus().toggleItalic().run()"><em>I</em></button>
      <button type="button" aria-label="下划线" title="下划线" :class="{ 'is-active': editor.isActive('underline') }" :disabled="disabled" @click="editor.chain().focus().toggleUnderline().run()"><u>U</u></button>
      <button type="button" aria-label="高亮" title="高亮" :class="{ 'is-active': editor.isActive('highlight') }" :disabled="disabled" @click="editor.chain().focus().toggleHighlight().run()">高亮</button>
      <button type="button" aria-label="链接" title="链接" :class="{ 'is-active': editor.isActive('link') }" :disabled="disabled" @click="setLink"><Icon name="link" :size="16" /></button>
      <span class="block-editor__separator" aria-hidden="true"></span>
      <button type="button" aria-label="待办列表" title="待办列表" :class="{ 'is-active': editor.isActive('taskList') }" :disabled="disabled" @click="editor.chain().focus().toggleTaskList().run()"><Icon name="check" :size="16" /></button>
      <button type="button" aria-label="项目列表" title="项目列表" :class="{ 'is-active': editor.isActive('bulletList') }" :disabled="disabled" @click="editor.chain().focus().toggleBulletList().run()"><Icon name="list" :size="16" /></button>
      <button type="button" aria-label="引用" title="引用" :class="{ 'is-active': editor.isActive('blockquote') }" :disabled="disabled" @click="editor.chain().focus().toggleBlockquote().run()"><Icon name="quote" :size="16" /></button>
      <button type="button" aria-label="代码块" title="代码块" :class="{ 'is-active': editor.isActive('codeBlock') }" :disabled="disabled" @click="editor.chain().focus().toggleCodeBlock().run()"><Icon name="code" :size="16" /></button>
      <button type="button" aria-label="插入表格" title="插入表格" :disabled="disabled" @click="editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()">表格</button>
      <template v-if="editor.isActive('table')">
        <button type="button" aria-label="在后方添加表格行" title="添加行" :disabled="disabled || !editor.can().addRowAfter()" @click="editor.chain().focus().addRowAfter().run()">+行</button>
        <button type="button" aria-label="在后方添加表格列" title="添加列" :disabled="disabled || !editor.can().addColumnAfter()" @click="editor.chain().focus().addColumnAfter().run()">+列</button>
        <button type="button" aria-label="删除当前表格行" title="删除行" :disabled="disabled || !editor.can().deleteRow()" @click="editor.chain().focus().deleteRow().run()">−行</button>
        <button type="button" aria-label="删除当前表格列" title="删除列" :disabled="disabled || !editor.can().deleteColumn()" @click="editor.chain().focus().deleteColumn().run()">−列</button>
        <button type="button" aria-label="删除表格" title="删除表格" :disabled="disabled || !editor.can().deleteTable()" @click="editor.chain().focus().deleteTable().run()">删表</button>
      </template>
      <button v-if="allowImages" type="button" aria-label="上传并插入图片" title="上传并插入图片" :disabled="disabled" @click="emit('request-image')"><Icon name="image" :size="16" /></button>
      <span class="block-editor__separator" aria-hidden="true"></span>
      <button type="button" aria-label="撤销" title="撤销" :disabled="disabled || !editor.can().undo()" @click="editor.chain().focus().undo().run()"><Icon name="undo" :size="16" /></button>
      <button type="button" aria-label="重做" title="重做" :disabled="disabled || !editor.can().redo()" @click="editor.chain().focus().redo().run()"><Icon name="redo" :size="16" /></button>
    </div>

    <div class="block-editor__canvas">
      <DragHandle v-if="editor && !disabled" :editor="editor" class="block-editor__drag-handle">
        <Icon name="grip-vertical" :size="16" />
        <span class="sr-only">拖动内容块</span>
      </DragHandle>
      <EditorContent :editor="editor" />
      <div v-if="slashOpen" class="block-editor__slash" role="listbox" aria-label="插入内容块">
        <header>
          <strong>插入内容块</strong>
          <kbd>Esc</kbd>
        </header>
        <button
          v-for="(command, index) in slashCommands"
          :key="command.label"
          type="button"
          role="option"
          :aria-selected="index === slashIndex"
          :class="{ 'is-active': index === slashIndex }"
          @mouseenter="slashIndex = index"
          @click="run(command.run)"
        >
          <span>{{ command.label }}</span>
          <small>{{ command.hint }}</small>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.block-editor { overflow: hidden; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 16px; }
.block-editor__collaboration { display: flex; min-height: 34px; padding: 7px 12px; align-items: center; gap: 7px; color: var(--text-muted); background: color-mix(in srgb, var(--bg-card) 82%, transparent); border-bottom: 1px solid var(--border-light); font-size: 11px; }
.block-editor__collaboration > span { width: 7px; height: 7px; border-radius: 999px; background: var(--warning-color, #c7924c); }
.block-editor__collaboration > span.is-synced,
.block-editor__collaboration > span.is-connected { background: var(--success-color, #66a36c); }
.block-editor__collaboration > span.is-connecting,
.block-editor__collaboration > span.is-loading { background: var(--accent-color); animation: collaboration-pulse 1s ease-in-out infinite; }
@keyframes collaboration-pulse { 50% { opacity: .35; transform: scale(.75); } }
.block-editor:focus-within { border-color: color-mix(in srgb, var(--accent-color) 70%, var(--border-light)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-color) 14%, transparent); }
.block-editor__toolbar { display: flex; min-height: 48px; padding: 5px 7px; align-items: center; gap: 3px; overflow-x: auto; background: color-mix(in srgb, var(--bg-card) 76%, transparent); border-bottom: 1px solid var(--border-light); scrollbar-width: thin; }
.block-editor__toolbar button,
.block-editor__select select { min-width: 38px; min-height: 38px; padding: 0 9px; color: var(--text-secondary); background: transparent; border: 1px solid transparent; border-radius: 9px; font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.block-editor__select select { min-width: 90px; color: var(--text-primary); background: var(--bg-secondary); }
.block-editor__toolbar button:hover,
.block-editor__toolbar button.is-active { color: var(--accent-color); background: var(--accent-bg); border-color: color-mix(in srgb, var(--accent-color) 30%, transparent); }
.block-editor__toolbar button:disabled { opacity: .4; cursor: not-allowed; }
.block-editor__separator { flex: 0 0 1px; width: 1px; height: 24px; margin: 0 3px; background: var(--border-light); }
.block-editor__canvas { position: relative; min-height: 280px; }
.block-editor__drag-handle { display: flex; width: 28px; height: 32px; align-items: center; justify-content: center; color: var(--text-muted); background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 8px; cursor: grab; }
.block-editor__drag-handle:active { cursor: grabbing; }
:deep(.block-editor__surface) { min-height: 280px; padding: 22px 28px 52px 38px; color: var(--text-primary); outline: none; font-size: 15px; line-height: 1.72; }
:deep(.block-editor__surface > *:first-child) { margin-top: 0; }
:deep(.block-editor__surface p) { margin: .35em 0; }
:deep(.block-editor__surface h1) { margin: 1em 0 .42em; font-size: 1.75rem; letter-spacing: -.035em; }
:deep(.block-editor__surface h2) { margin: .9em 0 .4em; font-size: 1.4rem; letter-spacing: -.025em; }
:deep(.block-editor__surface h3) { margin: .8em 0 .35em; font-size: 1.15rem; }
:deep(.block-editor__surface ul),
:deep(.block-editor__surface ol) { padding-left: 1.6rem; }
:deep(.block-editor__surface ul[data-type='taskList']) { padding: 0; list-style: none; }
:deep(.block-editor__surface ul[data-type='taskList'] li) { display: flex; gap: 9px; align-items: flex-start; }
:deep(.block-editor__surface ul[data-type='taskList'] label) { padding-top: 4px; }
:deep(.block-editor__surface ul[data-type='taskList'] li > div) { flex: 1; }
:deep(.block-editor__surface blockquote) { margin: 1em 0; padding-left: 15px; color: var(--text-secondary); border-left: 3px solid var(--accent-color); }
:deep(.block-editor__surface pre) { overflow: auto; padding: 14px 16px; color: var(--text-primary); background: var(--bg-primary); border: 1px solid var(--border-light); border-radius: 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
:deep(.block-editor__surface code:not(pre code)) { padding: .15em .35em; background: var(--accent-bg); border-radius: 5px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
:deep(.block-editor__surface mark) { color: inherit; background: color-mix(in srgb, var(--accent-color) 35%, transparent); border-radius: 3px; }
:deep(.block-editor__surface a) { color: var(--accent-color); text-decoration: underline; text-underline-offset: 3px; }
:deep(.block-editor__surface img) { display: block; max-width: 100%; height: auto; margin: 16px auto; border-radius: 14px; }
:deep(.block-editor__surface table) { width: 100%; margin: 16px 0; overflow: hidden; border-collapse: collapse; table-layout: fixed; }
:deep(.block-editor__surface th),
:deep(.block-editor__surface td) { position: relative; min-width: 80px; padding: 8px 10px; border: 1px solid var(--border-light); vertical-align: top; }
:deep(.block-editor__surface th) { background: var(--bg-card); font-weight: 650; }
:deep(.block-editor__surface .is-empty::before) { float: left; height: 0; color: var(--text-muted); content: attr(data-placeholder); pointer-events: none; }
.block-editor__slash { position: absolute; z-index: 10; top: 56px; left: 44px; display: grid; width: min(320px, calc(100% - 60px)); max-height: 360px; padding: 8px; overflow: auto; background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 14px; box-shadow: var(--shadow-lg); }
.block-editor__slash header { display: flex; padding: 6px 8px 9px; align-items: center; justify-content: space-between; color: var(--text-primary); font-size: 12px; }
.block-editor__slash kbd { color: var(--text-muted); font: inherit; }
.block-editor__slash button { display: grid; min-height: 48px; padding: 7px 10px; text-align: left; background: transparent; border: 0; border-radius: 9px; cursor: pointer; }
.block-editor__slash button.is-active { background: var(--accent-bg); }
.block-editor__slash span { color: var(--text-primary); font-size: 13px; font-weight: 650; }
.block-editor__slash small { color: var(--text-muted); font-size: 11px; }
.is-disabled { opacity: .76; }
@media (max-width: 640px) {
  .block-editor__toolbar button { min-width: 44px; min-height: 44px; }
  :deep(.block-editor__surface) { min-height: 240px; padding: 18px 18px 48px 28px; }
  .block-editor__slash { left: 12px; width: calc(100% - 24px); }
}
@media (prefers-reduced-motion: reduce) {
  .block-editor *, .block-editor *::before, .block-editor *::after { scroll-behavior: auto !important; transition: none !important; }
}
</style>
