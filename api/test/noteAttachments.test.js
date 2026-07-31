import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertAttachmentsAllowedForEncryption,
  normalizeNoteAttachments
} from '../src/lib/noteAttachments.js'

const validAttachment = {
  id: '550e8400-e29b-41d4-a716-446655440000',
  url: 'https://pic.skrskr.net/file/example-image',
  name: '示例图片.png',
  mime: 'image/png',
  size: 4096,
  createdAt: '2026-07-31T00:00:00.000Z'
}

test('normalizes an attachment from the configured image-bed origin', () => {
  assert.deepEqual(
    normalizeNoteAttachments([validAttachment], {
      allowedOrigin: 'https://pic.skrskr.net',
      strict: true
    }),
    [validAttachment]
  )
})

test('rejects cross-origin and non-image attachment metadata', () => {
  assert.throws(
    () => normalizeNoteAttachments([{
      ...validAttachment,
      url: 'https://example.com/file/example-image'
    }], {
      allowedOrigin: 'https://pic.skrskr.net',
      strict: true
    }),
    /图片附件包含无效/
  )

  assert.throws(
    () => normalizeNoteAttachments([{
      ...validAttachment,
      mime: 'image/svg+xml'
    }], {
      allowedOrigin: 'https://pic.skrskr.net',
      strict: true
    }),
    /图片附件包含无效/
  )
})

test('encrypted notes reject public image attachments', () => {
  assert.throws(
    () => assertAttachmentsAllowedForEncryption(true, [validAttachment]),
    /加密笔记不能添加图片附件/
  )
})
