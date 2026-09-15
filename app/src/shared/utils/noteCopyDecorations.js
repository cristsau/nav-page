import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { parseCopyableContent } from './copyableText.js'

// Read-only view decorations: no marks, attributes or copied data enter the note document.
export function createNoteCopyExtension(onCopy) {
  const key = new PluginKey('noteQuickCopy')
  function build(doc) {
    const blocks = []
    let source = ''
    doc.descendants((node, position) => {
      if (!node.isTextblock) return
      const text = node.textBetween(0, node.content.size, '', (leaf) => leaf.type.name === 'hardBreak' ? '\n' : '\uFFFC')
      blocks.push({ position, node, start: source.length, text })
      source += `${text}\n`
      return false
    })
    const lines = parseCopyableContent(source)
    const targets = new Map()
    const decorations = []
    let offset = 0
    let serial = 0
    let blockIndex = 0
    const register = (target) => {
      const id = String(serial++)
      targets.set(id, target)
      return { 'data-note-copy-id': id, 'aria-label': `复制${target.label}`, title: `复制${target.label}` }
    }
    for (const line of lines) {
      while (blockIndex < blocks.length && offset > blocks[blockIndex].start + blocks[blockIndex].text.length) blockIndex++
      const block = blocks[blockIndex]
      if (!block) { offset += line.raw.length + 1; continue }
      let cursor = block.position + 1 + offset - block.start
      for (const segment of line.segments) {
        if (segment.type === 'copy') {
          const target = { value: segment.copyValue || segment.value, label: segment.label }
          decorations.push(Decoration.inline(cursor, cursor + segment.value.length, {
            ...register(target), class: 'note-copy-token', role: 'button', tabindex: '0'
          }))
        }
        cursor += segment.value.length
      }
      const target = line.blockCopyTarget || line.copyTarget
      if (target && offset < 50_000 && serial < 1_000) {
        const attributes = register(target)
        decorations.push(Decoration.widget(cursor, () => {
          const button = document.createElement('button')
          button.type = 'button'
          button.className = `note-copy-line${line.blockCopyTarget ? ' is-address-block' : ''}`
          button.contentEditable = 'false'
          for (const [name, value] of Object.entries(attributes)) button.setAttribute(name, value)
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
          for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.7', 'aria-hidden': 'true' })) svg.setAttribute(name, value)
          const path = document.createElementNS(svg.namespaceURI, 'path')
          path.setAttribute('d', 'M9 9h11v11H9z M15 9V4H4v11h5')
          svg.appendChild(path)
          button.appendChild(svg)
          if (line.blockCopyTarget) button.appendChild(document.createTextNode('复制完整地址'))
          return button
        }, { side: 1 }))
      }
      offset += line.raw.length + 1
    }
    return { targets, decorations: DecorationSet.create(doc, decorations) }
  }
  function activate(view, event) {
    const element = event.target?.closest?.('[data-note-copy-id]')
    if (!element || !view.dom.contains(element)) return false
    // Keep modified-click navigation available for existing links.
    if (event.type === 'click' && (event.ctrlKey || event.metaKey) && event.target.closest('a[href]')) return false
    if (event.type === 'click' && !view.dom.ownerDocument.getSelection()?.isCollapsed) return false
    const target = key.getState(view.state)?.targets.get(element.getAttribute('data-note-copy-id'))
    if (!target) return false
    event.preventDefault()
    event.stopPropagation()
    onCopy(target)
    return true
  }
  return Extension.create({
    name: 'noteQuickCopy',
    addProseMirrorPlugins() {
      return [new Plugin({
        key,
        state: {
          init: (_, state) => build(state.doc),
          apply: (transaction, previous, _, state) => transaction.docChanged ? build(state.doc) : previous
        },
        props: {
          decorations: (state) => key.getState(state)?.decorations,
          handleDOMEvents: {
            click: activate,
            keydown: (view, event) => ['Enter', ' '].includes(event.key) ? activate(view, event) : false
          }
        }
      })]
    }
  })
}
