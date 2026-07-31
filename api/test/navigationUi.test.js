import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  buildBookmarkAiPrompt,
  resolveBookmarkAiProvider,
  resolveBookmarkPresentation,
  resolveGroupIcon,
  sanitizeBookmarkUrl
} from '../../app/src/modules/navigation/navigationUi.js'

test('legacy group text and emoji are converted to supported Lucide icons', () => {
  assert.equal(resolveGroupIcon('briefcase', '工作'), 'briefcase')
  assert.equal(resolveGroupIcon('💻', '开发工具'), 'code')
  assert.equal(resolveGroupIcon('⭐', '我的收藏'), 'pin')
  assert.equal(resolveGroupIcon('D', '未分类'), 'folder')
})

test('bookmark AI provider prioritizes the configured ChatGPT backend', () => {
  const config = {
    search: {
      providers: {
        brave: { enabled: true, apiKeyConfigured: true },
        chatgpt: { enabled: true, apiKeyConfigured: true }
      }
    }
  }

  assert.equal(resolveBookmarkAiProvider(config), 'chatgpt')
  assert.equal(resolveBookmarkAiProvider({ search: { providers: {} } }), '')
})

test('bookmark AI ignores retired providers and skips enabled providers that are not ready', () => {
  const config = {
    search: {
      providers: {
        chatgpt: { enabled: true, apiKeyConfigured: false },
        openclaw: {
          enabled: true,
          endpoint: 'https://openclaw.example.test/v1/chat/completions'
        },
        brave: { enabled: true, apiKeyConfigured: true }
      }
    }
  }

  assert.equal(resolveBookmarkAiProvider(config), 'brave')
})

test('bookmark URL sent for AI analysis excludes credentials, query and fragment', () => {
  assert.equal(
    sanitizeBookmarkUrl('https://user:secret@example.com/docs?id=token#private'),
    'https://example.com/docs'
  )
  assert.equal(sanitizeBookmarkUrl('javascript:alert(1)'), '')
})

test('bookmark presentation is stable, useful and does not reveal URL secrets', () => {
  const bookmark = {
    title: 'Linux DO 公告',
    url: 'https://user:secret@linux.do/c/announcements/42?token=private#staff'
  }
  const first = resolveBookmarkPresentation(bookmark)
  const second = resolveBookmarkPresentation(bookmark)

  assert.equal(first.hue, second.hue)
  assert.equal(first.monogram, 'LI')
  assert.equal(first.subtitle, 'linux.do/c/announcements')
  assert.equal(first.fullSubtitle, 'https://linux.do/c/announcements/42')
  assert.doesNotMatch(JSON.stringify(first), /secret|private|staff/)
  assert.equal(
    resolveBookmarkPresentation({ title: '坏链接', url: 'not a url?token=secret' }).subtitle,
    '网址格式无效'
  )
})

test('bookmark AI prompt contains actionable structure and only the sanitized URL', () => {
  const prompt = buildBookmarkAiPrompt({
    title: '产品文档',
    description: '团队使用说明',
    url: 'https://example.com/guide?api_key=secret#admin'
  })

  assert.match(prompt, /用途判断/)
  assert.match(prompt, /推荐标签/)
  assert.match(prompt, /不要声称已经读取或核验网页正文/)
  assert.match(prompt, /https:\/\/example\.com\/guide/)
  assert.doesNotMatch(prompt, /api_key|secret|#admin/)
})

test('bookmark AI setup action focuses the search settings section', async () => {
  const [navigation, settings] = await Promise.all([
    fs.readFile(
      fileURLToPath(new URL('../../app/src/modules/navigation/Navigation.vue', import.meta.url)),
      'utf8'
    ),
    fs.readFile(
      fileURLToPath(new URL('../../app/src/modules/settings/Settings.vue', import.meta.url)),
      'utf8'
    )
  ])

  assert.match(navigation, /query:\s*\{\s*section:\s*'search'\s*\}/)
  assert.match(settings, /id="settings-search"/)
  assert.match(settings, /focusRequestedSection/)
  assert.match(settings, /scrollIntoView/)
})
