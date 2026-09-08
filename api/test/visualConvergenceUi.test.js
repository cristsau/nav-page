import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const readSource = (relativePath) => readFile(
  new URL(`../../${relativePath}`, import.meta.url),
  'utf8'
)

test('navigation keeps real behavior while converging on the compact reference layout', async () => {
  const [navigation, group, item] = await Promise.all([
    readSource('app/src/modules/navigation/Navigation.vue'),
    readSource('app/src/modules/navigation/components/NavGroup.vue'),
    readSource('app/src/modules/navigation/components/NavItem.vue')
  ])

  assert.match(navigation, /<h1 class="search-section__title">统一搜索<\/h1>/)
  assert.match(navigation, /\.search-section :deep\(\.search-box\)[\s\S]*min-height: 52px/)
  assert.match(navigation, /\.search-section :deep\(\.search-shell\)[\s\S]*width: 100%/)
  assert.match(group, /grid-template-columns: repeat\(auto-fill, minmax\(220px, 1fr\)\)/)
  assert.match(group, /role="tablist" aria-label="导航分组"/)
  assert.match(group, /v-for="\(bookmark, bookmarkIndex\) in visibleBookmarks"/)
  assert.match(group, /activeBookmarks\.value\.slice\(0, visibleCount\.value\)/)
  assert.match(group, /:sort-count="activeBookmarks.length"/)
  assert.match(item, /class="bookmark-card__body"/)
  assert.match(item, /grid-template-columns: auto minmax\(0, 1fr\)/)
  assert.match(item, /-webkit-line-clamp: 2/)
  assert.match(item, /bookmark-card__monogram/)

  for (const behavior of [
    "emit('ai'",
    "emit('edit'",
    "emit('delete'",
    "emit('toggleSelection'",
    "emit('sortMove'"
  ]) {
    assert.match(item, new RegExp(behavior.replace(/[()']/g, '\\$&')))
  }

  assert.match(item, /class="bookmark-card__more"/)
  assert.match(item, /@dragstart\.stop="startBookmarkDrag"/)
  assert.doesNotMatch(`${navigation}\n${group}\n${item}`, /Math\.random|\.innerHTML\s*=/)
})

test('navigation, time and media share a 1200px compact content rhythm', async () => {
  const [navigation, whisper, noteCard, media] = await Promise.all([
    readSource('app/src/modules/navigation/Navigation.vue'),
    readSource('app/src/modules/whisper/Whisper.vue'),
    readSource('app/src/modules/whisper/components/NoteCard.vue'),
    readSource('app/src/modules/media/MediaLibrary.vue')
  ])

  assert.match(navigation, /max-width: var\(--max-width\)/)
  assert.match(whisper, /max-width: 1200px/)
  assert.match(media, /width: min\(1200px, 100%\)/)
  assert.match(media, /\.media-hero h1 \{[^}]*font-size: 1\.25rem/)
  assert.doesNotMatch(media, /3\.25rem/)

  assert.match(whisper, /class="section section--pinned"/)
  assert.match(whisper, /class="section section--diary"/)
  assert.match(whisper, /class="section section--memo"/)
  assert.match(whisper, /class="content__rail content__rail--memos"/)
  assert.match(whisper, /class="content__rail content__rail--diary"/)
  assert.match(whisper, /grid-template-columns: repeat\(auto-fill, minmax\(min\(100%, 420px\), 1fr\)\)/)
  assert.match(whisper, /@media \(max-width: 900px\)/)
  assert.match(whisper, /\.header \{[\s\S]*?position: relative;[\s\S]*?width: min\(1200px, 100%\)/)
  assert.doesNotMatch(whisper, /\.header \{[\s\S]*?position: sticky;/)
  assert.doesNotMatch(whisper, /grid-row:\s*1\s*\/\s*span/)
  assert.match(noteCard, /runAction\('preview'\)/)
  assert.match(noteCard, /emit\('share'/)
  assert.match(noteCard, /runAction\('ai'\)/)
  assert.match(noteCard, /runAction\('copyExtract'\)/)
  assert.match(noteCard, /runAction\('edit'\)/)
  assert.match(whisper, /<NotePreview[\s\S]*@copy-value="handleCopyValue"/)
})

test('converged layouts retain focus, touch and reduced-motion protections', async () => {
  const [navigation, group, item, whisper, noteCard, media] = await Promise.all([
    readSource('app/src/modules/navigation/Navigation.vue'),
    readSource('app/src/modules/navigation/components/NavGroup.vue'),
    readSource('app/src/modules/navigation/components/NavItem.vue'),
    readSource('app/src/modules/whisper/Whisper.vue'),
    readSource('app/src/modules/whisper/components/NoteCard.vue'),
    readSource('app/src/modules/media/MediaLibrary.vue')
  ])

  assert.match(navigation, /\.search-section :deep\(\.search-box__engine\),[\s\S]*?min-height: 44px/)
  assert.match(navigation, /\.management-heading__modes button:focus-visible/)
  assert.match(navigation, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.management-bar button/)

  assert.match(group, /\.groups-tabs__main \{[\s\S]*?min-height: 44px/)
  assert.match(group, /\.groups-tabs__main:focus-visible/)
  assert.match(group, /@media \(hover: none\) and \(pointer: coarse\), \(max-width: 760px\)[\s\S]*?\.groups-tabs__sort-actions button \{[\s\S]*?width: 44px;[\s\S]*?height: 44px/)
  assert.match(group, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.bookmark-card--add/)

  assert.match(item, /\.bookmark-card__more \{[\s\S]*?width: 44px;[\s\S]*?height: 44px/)
  assert.match(item, /\.bookmark-card__more:focus-visible/)
  assert.match(item, /@media \(hover: none\) and \(pointer: coarse\), \(max-width: 760px\)[\s\S]*?\.bookmark-card__selection,[\s\S]*?width: 44px;[\s\S]*?height: 44px/)
  assert.match(item, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.bookmark-card__main/)

  assert.match(whisper, /\.filter-tab \{[\s\S]*?min-height: 44px/)
  assert.match(whisper, /\.filter-tab:focus-visible,[\s\S]*?\.memo-status-filter button:focus-visible/)
  assert.match(whisper, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.toast-leave-active[\s\S]*?\.loading__spinner/)

  assert.match(noteCard, /\.note-card__id:focus-visible,[\s\S]*?\.action-btn:focus-visible/)
  assert.match(noteCard, /@media \(hover: none\), \(pointer: coarse\), \(any-hover: none\), \(any-pointer: coarse\)[\s\S]*?\.note-card__id \{[\s\S]*?min-width: 44px;[\s\S]*?min-height: 44px/)
  assert.match(noteCard, /@media \(hover: none\), \(pointer: coarse\), \(any-hover: none\), \(any-pointer: coarse\)[\s\S]*?\.action-btn \{[\s\S]*?width: 44px;[\s\S]*?height: 44px/)
  assert.match(noteCard, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.note-card__actions/)

  assert.match(media, /\.media-card__overlay-actions button \{[^}]*width: 44px; height: 44px/)
  assert.match(media, /button:focus-visible, a:focus-visible, input:focus-visible/)
  assert.match(media, /@media \(hover: none\), \(pointer: coarse\), \(any-hover: none\), \(any-pointer: coarse\)/)
  assert.match(media, /@media \(prefers-reduced-motion: reduce\)/)
})
