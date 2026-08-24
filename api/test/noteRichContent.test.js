import test from 'node:test'
import assert from 'node:assert/strict'
import {
  assertTiptapImagesAttached,
  sanitizeTiptapDocument,
  tiptapDocumentImageUrls,
  tiptapDocumentText
} from '../src/lib/noteRichContent.js'

const IMAGE_URL = 'https://pic.skrskr.net/file/user/image.png'

function documentWithImage(src = IMAGE_URL) {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: '部署摘要' }] },
      { type: 'taskList', content: [{
        type: 'taskItem',
        attrs: { checked: true },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '完成恢复演练' }] }]
      }] },
      { type: 'image', attrs: { src, alt: '架构图' } }
    ]
  }
}

test('rich content sanitizer preserves supported blocks and derives searchable text', () => {
  const sanitized = sanitizeTiptapDocument(documentWithImage(), {
    allowedImageOrigin: 'https://pic.skrskr.net'
  })
  assert.deepEqual(tiptapDocumentImageUrls(sanitized), [IMAGE_URL])
  assert.match(tiptapDocumentText(sanitized), /部署摘要/)
  assert.match(tiptapDocumentText(sanitized), /完成恢复演练/)
})

test('rich content rejects unsupported nodes and unapproved or detached images', () => {
  assert.throws(
    () => sanitizeTiptapDocument({ type: 'doc', content: [{ type: 'script' }] }),
    /Unsupported rich content node/
  )
  assert.throws(
    () => sanitizeTiptapDocument(documentWithImage('https://tracking.example/pixel.png'), {
      allowedImageOrigin: 'https://pic.skrskr.net'
    }),
    /unapproved image URL/
  )
  assert.throws(
    () => assertTiptapImagesAttached(documentWithImage(), []),
    /must be present in note attachments/
  )
  assert.doesNotThrow(() => assertTiptapImagesAttached(documentWithImage(), [{ url: IMAGE_URL }]))
  assert.throws(
    () => sanitizeTiptapDocument({
      type: 'doc',
      content: [{ type: 'text', text: 'orphan text' }]
    }),
    /not allowed inside doc/
  )
  assert.throws(
    () => sanitizeTiptapDocument({
      type: 'doc',
      content: [{
        type: 'table',
        content: [{ type: 'paragraph' }]
      }]
    }),
    /not allowed inside table/
  )
})
