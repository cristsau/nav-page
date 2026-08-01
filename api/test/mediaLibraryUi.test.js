import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  formatMediaBytes,
  formatMediaDimensions,
  mediaCanDelete,
  mediaCanShare,
  mediaMarkdown,
  mediaNeedsRetention,
  mediaStatus,
  upsertMediaImage
} from '../../app/src/modules/media/mediaLibrary.js'

const sourceFile = (path) => fs.readFile(
  fileURLToPath(new URL(`../../app/src/${path}`, import.meta.url)),
  'utf8'
)

test('media library derives safe status and deletion behavior from references', () => {
  assert.equal(mediaStatus({ referenceCount: 2 }), 'referenced')
  assert.equal(mediaCanDelete({ references: [{ noteId: 'n1' }] }), false)
  assert.equal(mediaStatus({ status: 'delete_failed' }), 'cleanup_pending')
  assert.equal(mediaStatus({ status: 'delete_pending' }), 'cleanup_pending')
  assert.equal(mediaStatus({ missing: true, referenceCount: 1 }), 'missing')
  assert.equal(mediaCanDelete({ missing: true }), true)
  assert.equal(mediaCanShare({ missing: true, url: 'https://pic.example/a.webp' }), false)
  assert.equal(mediaCanShare({ url: 'https://pic.example/a.webp' }), true)
})

test('media sharing helpers preserve usable metadata', () => {
  assert.equal(mediaNeedsRetention({ retention: 'auto' }), true)
  assert.equal(mediaNeedsRetention({ retention: 'keep' }), false)
  assert.equal(mediaMarkdown({ name: '示例[图]', url: 'https://pic.example/a.webp' }), '![示例图](https://pic.example/a.webp)')
  assert.equal(formatMediaBytes(1_048_576), '1.0 MB')
  assert.equal(formatMediaDimensions({ width: 1280, height: 720 }), '1280 × 720')
})

test('media list updates retain order and merge server truth', () => {
  const original = [{ id: 'a', retention: 'auto' }, { id: 'b', retention: 'auto' }]
  assert.deepEqual(upsertMediaImage(original, { id: 'b', retention: 'keep' }), [
    { id: 'a', retention: 'auto' },
    { id: 'b', retention: 'keep' }
  ])
})

test('media page is responsive, accessible and truthful about destructive actions', async () => {
  const source = await sourceFile('modules/media/MediaLibrary.vue')

  assert.match(source, /class="media-waterfall"/)
  assert.match(source, /loading="lazy"/)
  assert.match(source, /IntersectionObserver/)
  assert.match(source, /aria-modal="true"/)
  assert.match(source, /handlePreviewKeydown/)
  assert.match(source, /!focusable\.includes\(document\.activeElement\)/)
  assert.match(source, /result\.complete === false/)
  assert.match(source, /删除后公开链接立即失效且无法恢复/)
  assert.match(source, /改为“自动”后会进入清理范围/)
  assert.match(source, /图片仍被笔记引用，不能删除原图/)
  assert.match(source, /error\.status === 409/)
  assert.match(source, /复制或分享前会自动设为长期保留/)
  assert.match(source, /await ensureKeptForSharing\(image\)/)
  assert.match(source, /updated\.state === 'deleted'/)
  assert.match(source, /\(any-pointer: coarse\)/)
  assert.match(source, /@media \(max-width: 420px\)/)
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/)
  assert.doesNotMatch(source, /[😀-🙏🌀-🫿]/u)
})

test('media API contract stays isolated in one frontend service', async () => {
  const source = await sourceFile('shared/services/mediaApi.js')

  assert.match(source, /\/media\/images\?\$\{search\.toString\(\)\}/)
  assert.match(source, /imagePath\(imageId, '\/retention'\)/)
  assert.match(source, /method: 'DELETE'/)
  assert.match(source, /imagePath\(imageId, '\/retry-delete'\)/)
  assert.match(source, /request\('\/media\/reconcile'/)
})

test('NAV, time and command surfaces expose the media library', async () => {
  const [router, navigation, whisper, commands, editor] = await Promise.all([
    sourceFile('router/index.js'),
    sourceFile('modules/navigation/Navigation.vue'),
    sourceFile('modules/whisper/Whisper.vue'),
    sourceFile('shared/components/CommandPalette.vue'),
    sourceFile('modules/whisper/components/NoteEditor.vue')
  ])

  assert.match(router, /path: '\/media'/)
  assert.match(navigation, /aria-label="打开图片库"/)
  assert.match(whisper, /aria-label="打开图片库"/)
  assert.match(commands, /id: 'go-media'/)
  assert.match(editor, /没有其他笔记引用且图片未设为“长期保留”/)
  assert.doesNotMatch(editor, /图床原文件暂不自动删除/)
})
