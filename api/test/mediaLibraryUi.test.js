import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  formatMediaBytes,
  formatMediaDimensions,
  mediaCanDelete,
  mediaCanShare,
  mediaCleanupHasFailures,
  mediaCleanupMessage,
  mediaDeletionMessage,
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

test('media deletion messages distinguish provider disposition and cache cleanup', () => {
  assert.equal(mediaDeletionMessage({ deletion: {
    disposition: 'source_deleted',
    cacheInvalidated: true,
    cachePurgeSucceeded: true,
    localCacheInvalidated: false
  } }), '图床源文件已删除，全局缓存已清理，公开链接已失效')
  assert.equal(mediaDeletionMessage({ deletion: {
    disposition: 'source_deleted',
    cacheInvalidated: true,
    cachePurgeSucceeded: false,
    localCacheInvalidated: true
  } }), '图床源文件已删除；当前节点缓存已清理，其他节点可能短暂可访问')
  assert.equal(mediaDeletionMessage({ deletion: {
    disposition: 'legacy_detached',
    cacheInvalidated: false
  } }), '旧图床记录已解除引用，源文件无法物理删除；缓存清理不完整，公开链接可能短暂可访问')
  assert.equal(mediaDeletionMessage({ deletion: {
    disposition: 'already_missing',
    cacheInvalidated: true,
    cachePurgeSucceeded: true,
    localCacheInvalidated: false
  } }), '原文件此前已不存在，图床记录已清理，全局缓存已清理，公开链接已失效')
  assert.equal(mediaCleanupMessage([
    { state: 'deleted', deletion: { disposition: 'detached', cacheInvalidated: false } },
    { state: 'delete_failed', deletion: null }
  ]), '图片清理：仅解除图床引用 1 张；清理失败 1 张，可在图片库重试；缓存未完全清理 1 张，链接可能短暂可访问')
  assert.equal(mediaCleanupMessage([{
    state: 'deleted',
    deletion: {
      disposition: 'source_deleted',
      cacheInvalidated: true,
      cachePurgeSucceeded: false,
      localCacheInvalidated: true
    }
  }]), '图片清理：源文件已删除 1 张；仅当前节点缓存已清理 1 张，其他节点可能短暂可访问')
  assert.equal(mediaCleanupHasFailures([
    { state: 'deleted' },
    { state: 'delete_failed' }
  ]), true)
  assert.equal(mediaCleanupHasFailures([{ state: 'deleted' }]), false)
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
  assert.match(source, /改为“自动”后会进入清理范围/)
  assert.match(source, /图片仍被笔记引用，不能清理图床记录/)
  assert.match(source, /error\.status === 409/)
  assert.match(source, /复制或分享前会自动设为长期保留/)
  assert.match(source, /await ensureKeptForSharing\(image\)/)
  assert.match(source, /updated\.state === 'deleted'/)
  assert.match(source, /mediaDeletionMessage\(updated/)
  assert.match(source, /能否物理删除取决于来源/)
  assert.doesNotMatch(source, /永久删除|删除原图|安全清理原图/)
  assert.doesNotMatch(source, /删除后公开链接立即失效/)
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
  assert.match(source, /deletion: payload\.deletion \|\| image\.deletion \|\| null/)
})

test('shared navigation, time and command surfaces expose the media library', async () => {
  const [router, primaryNavigation, appNavigation, whisper, commands, editor] = await Promise.all([
    sourceFile('router/index.js'),
    sourceFile('shared/components/PrimaryNavigation.vue'),
    sourceFile('shared/navigation/appNavigation.js'),
    sourceFile('modules/whisper/Whisper.vue'),
    sourceFile('shared/components/CommandPalette.vue'),
    sourceFile('modules/whisper/components/NoteEditor.vue')
  ])

  assert.match(router, /path: '\/media'/)
  assert.match(primaryNavigation, /aria-label="主要页面"/)
  assert.match(appNavigation, /label: '图片库'/)
  assert.match(appNavigation, /path: '\/media'/)
  assert.match(whisper, /mediaCleanupMessage\(mediaCleanup\)/)
  assert.match(whisper, /mediaCleanupHasFailures\(mediaCleanup\) \? 'error' : 'success'/)
  assert.match(commands, /id: 'go-media'/)
  assert.match(editor, /没有其他笔记引用且图片未设为“长期保留”/)
  assert.doesNotMatch(editor, /图床原文件暂不自动删除/)
})
