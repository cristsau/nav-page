<script setup>
import { onBeforeUnmount, watch } from 'vue'
import Highlight from '@tiptap/extension-highlight'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { TableKit } from '@tiptap/extension-table'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import TextAlign from '@tiptap/extension-text-align'
import Underline from '@tiptap/extension-underline'
import StarterKit from '@tiptap/starter-kit'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import {
  EMPTY_TIPTAP_DOCUMENT,
  plainTextToTiptapDocument,
  sanitizeTiptapDocumentForClient
} from '@/shared/utils/noteRichContent'

const props = defineProps({
  document: { type: Object, default: null },
  plainText: { type: String, default: '' }
})

function content() {
  const safeDocument = sanitizeTiptapDocumentForClient(props.document)
  if (safeDocument) return safeDocument
  if (props.plainText) return plainTextToTiptapDocument(props.plainText)
  return EMPTY_TIPTAP_DOCUMENT
}

const editor = useEditor({
  content: content(),
  editable: false,
  extensions: [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    Underline,
    Highlight.configure({ multicolor: false }),
    Link.configure({
      openOnClick: true,
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' }
    }),
    Image.configure({ inline: false, allowBase64: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    TextAlign.configure({ types: ['heading', 'paragraph'] })
  ],
  editorProps: {
    attributes: {
      class: 'block-content__surface',
      'aria-label': '笔记正文'
    }
  }
})

watch(
  [() => props.document, () => props.plainText],
  () => editor.value?.commands.setContent(content(), { emitUpdate: false }),
  { deep: true }
)

onBeforeUnmount(() => editor.value?.destroy())
</script>

<template>
  <EditorContent class="block-content" :editor="editor" />
</template>

<style scoped>
.block-content { min-width: 0; color: var(--text-primary); }
:deep(.block-content__surface) { min-width: 0; color: inherit; outline: none; font: inherit; line-height: 1.82; overflow-wrap: anywhere; }
:deep(.block-content__surface > *:first-child) { margin-top: 0; }
:deep(.block-content__surface > *:last-child) { margin-bottom: 0; }
:deep(.block-content__surface p) { margin: .48em 0; }
:deep(.block-content__surface h1) { margin: 1.15em 0 .48em; font-size: clamp(1.55rem, 4vw, 2rem); letter-spacing: -.035em; line-height: 1.2; }
:deep(.block-content__surface h2) { margin: 1.05em 0 .45em; font-size: clamp(1.3rem, 3vw, 1.55rem); letter-spacing: -.025em; line-height: 1.28; }
:deep(.block-content__surface h3) { margin: .95em 0 .4em; font-size: 1.16rem; line-height: 1.35; }
:deep(.block-content__surface ul),
:deep(.block-content__surface ol) { padding-left: 1.55rem; }
:deep(.block-content__surface ul[data-type='taskList']) { padding: 0; list-style: none; }
:deep(.block-content__surface ul[data-type='taskList'] li) { display: flex; gap: 9px; align-items: flex-start; }
:deep(.block-content__surface ul[data-type='taskList'] label) { padding-top: 5px; }
:deep(.block-content__surface ul[data-type='taskList'] li > div) { flex: 1; }
:deep(.block-content__surface blockquote) { margin: 1em 0; padding-left: 15px; color: var(--text-secondary); border-left: 3px solid var(--accent-color); }
:deep(.block-content__surface pre) { overflow: auto; padding: 14px 16px; color: var(--text-primary); background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 12px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
:deep(.block-content__surface code:not(pre code)) { padding: .15em .35em; background: var(--accent-bg); border-radius: 5px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
:deep(.block-content__surface mark) { color: inherit; background: color-mix(in srgb, var(--accent-color) 35%, transparent); border-radius: 3px; }
:deep(.block-content__surface a) { color: var(--accent-color); text-decoration: underline; text-underline-offset: 3px; }
:deep(.block-content__surface img) { display: block; max-width: 100%; height: auto; margin: 18px auto; border-radius: 14px; }
:deep(.block-content__surface table) { width: 100%; margin: 16px 0; border-collapse: collapse; table-layout: fixed; }
:deep(.block-content__surface th),
:deep(.block-content__surface td) { min-width: 80px; padding: 8px 10px; border: 1px solid var(--border-light); vertical-align: top; }
:deep(.block-content__surface th) { background: var(--bg-secondary); font-weight: 650; }
</style>
