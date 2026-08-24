import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { mapPublicNote, mapPublicShare } from '../src/lib/notes.js'

const publicRecord = {
  id: 'private-note-id',
  number_id: 1000,
  user_id: 'private-user-id',
  type: 'memo',
  title: '部署摘要',
  content: '服务名称：nav-api',
  encrypted: false,
  password_hash: 'private-password-hash',
  pinned: true,
  tags: ['部署', '状态'],
  attachments: [
    {
      id: '550e8400-e29b-41d4-a716-446655440000',
      url: 'https://pic.skrskr.net/file/nav-api.png',
      name: 'nav-api.png',
      mime: 'image/png',
      size: 1024,
      createdAt: '2026-07-31T03:00:00.000Z'
    }
  ],
  entry_date: null,
  mood: '',
  due_at: '2026-08-01T00:00:00.000Z',
  completed: false,
  created_at: '2026-07-31T03:00:00.000Z',
  updated_at: '2026-07-31T04:00:00.000Z',
  share_id: 'private-share-id',
  share_code: 'private-code',
  share_expire_at: null,
  share_view_count: 42
}

test('public note DTO exposes only reader-facing fields', () => {
  const note = mapPublicNote(publicRecord, {
    allowedAttachmentOrigin: 'https://pic.skrskr.net'
  })

  assert.deepEqual(note, {
    title: '部署摘要',
    content: '服务名称：nav-api',
    contentFormat: 'plain',
    contentJson: null,
    tags: ['部署', '状态'],
    attachments: [
      {
        url: 'https://pic.skrskr.net/file/nav-api.png',
        name: 'nav-api.png'
      }
    ],
    entryDate: null
  })

  for (const privateField of [
    'id',
    'numberId',
    'userId',
    'encrypted',
    'pinned',
    'dueAt',
    'completed',
    'createdAt',
    'updatedAt',
    'share',
    'viewCount'
  ]) {
    assert.equal(privateField in note, false)
  }
})

test('public note DTO rejects images outside the configured image-bed origin', () => {
  const note = mapPublicNote({
    ...publicRecord,
    attachments: [
      {
        ...publicRecord.attachments[0],
        url: 'https://tracking.example/file/pixel.png'
      }
    ]
  }, {
    allowedAttachmentOrigin: 'https://pic.skrskr.net'
  })

  assert.deepEqual(note.attachments, [])
  assert.deepEqual(mapPublicNote(publicRecord).attachments, [])
})

test('public share DTO does not expose IDs, access code, expiry or view count', () => {
  const share = mapPublicShare({
    id: 'private-share-id',
    note_id: 'private-note-id',
    user_id: 'private-user-id',
    code: 'private-code',
    expire_at: '2026-08-01T00:00:00.000Z',
    view_count: 42,
    created_at: '2026-07-31T03:00:00.000Z'
  })

  assert.deepEqual(share, {
    date: '2026-07-31'
  })
})

test('public share date uses the owner-facing Asia/Shanghai calendar date', () => {
  assert.deepEqual(mapPublicShare({
    created_at: '2026-07-30T16:30:00.000Z'
  }), {
    date: '2026-07-31'
  })

  assert.deepEqual(mapPublicShare({
    created_at: '2026-07-31T23:30:00-07:00'
  }), {
    date: '2026-08-01'
  })
})

test('public share route uses the public DTO and no-store/noindex headers', async () => {
  const routeUrl = new URL('../src/routes/notes.js', import.meta.url)
  const source = await readFile(routeUrl, 'utf8')
  const publicRouteIndex = source.indexOf("fastify.get('/shares/:code'")

  assert.ok(publicRouteIndex >= 0)
  const publicRouteSource = source.slice(publicRouteIndex)

  assert.match(publicRouteSource, /skipSession: true/)
  assert.match(publicRouteSource, /Cache-Control', 'private, no-store'/)
  assert.match(publicRouteSource, /X-Robots-Tag', 'noindex, noarchive, nofollow'/)
  assert.match(publicRouteSource, /share: mapPublicShare\(result\.share\)/)
  assert.match(publicRouteSource, /note: mapPublicNote\(result\.note,/)
  assert.match(publicRouteSource, /allowedAttachmentOrigin: getImgBedOrigin\(config\.imgBedBaseUrl\)/)
  assert.doesNotMatch(publicRouteSource, /share: mapShare\(/)
  assert.doesNotMatch(publicRouteSource, /note: mapNote\(/)
  assert.doesNotMatch(publicRouteSource, /SELECT\s+\*/m)
  assert.doesNotMatch(publicRouteSource, /SELECT\s+n\.\*/m)
})

test('public share client omits credentials and reports HTTP status', async () => {
  const serviceUrl = new URL('../../app/src/shared/services/notesApi.js', import.meta.url)
  const source = await readFile(serviceUrl, 'utf8')
  const publicFetchIndex = source.indexOf('export async function fetchBackendShareByCode')
  const nextExportIndex = source.indexOf('export async function', publicFetchIndex + 1)
  const publicFetchSource = source.slice(publicFetchIndex, nextExportIndex)

  assert.ok(publicFetchIndex >= 0)
  assert.match(publicFetchSource, /credentials: 'omit'/)
  assert.match(publicFetchSource, /error\.status = response\.status/)
})

test('public share route explicitly skips browser and API session resolution', async () => {
  const routerUrl = new URL('../../app/src/router/index.js', import.meta.url)
  const authPluginUrl = new URL('../src/plugins/auth.js', import.meta.url)
  const [routerSource, authPluginSource] = await Promise.all([
    readFile(routerUrl, 'utf8'),
    readFile(authPluginUrl, 'utf8')
  ])
  const skipDecisionIndex = routerSource.indexOf('const shouldResolveSession = !to.meta.skipSession')
  const sessionIndex = routerSource.indexOf('await initAuth()')

  assert.match(routerSource, /publicShell: true/)
  assert.match(routerSource, /skipSession: true/)
  assert.ok(skipDecisionIndex >= 0)
  assert.ok(sessionIndex > skipDecisionIndex)
  assert.match(routerSource, /if \(!shouldResolveSession\) \{\s+return true\s+\}/)
  assert.doesNotMatch(routerSource, /fetchBackendSession/)
  assert.match(authPluginSource, /if \(request\.routeOptions\.config\?\.skipSession\) return/)
})

test('public share view is an article without internal type, count or decrypt UI', async () => {
  const viewUrl = new URL('../../app/src/modules/whisper/ShareView.vue', import.meta.url)
  const managerUrl = new URL('../../app/src/modules/whisper/components/ShareManager.vue', import.meta.url)
  const [source, managerSource] = await Promise.all([
    readFile(viewUrl, 'utf8'),
    readFile(managerUrl, 'utf8')
  ])

  assert.match(source, /<article[^>]+class="share-article"/)
  assert.match(source, /<CopyableNoteContent/)
  assert.match(source, /<BlockContent/)
  assert.match(source, /noindex, noarchive, nofollow/)
  assert.match(source, /link\[rel="canonical"\]/)
  assert.match(source, /resolvePublicAppOrigin/)
  assert.match(source, /MANAGED_META_PROPERTIES/)
  assert.match(source, /querySelectorAll\(`meta\[property=/)
  assert.doesNotMatch(source, /window\.location\.origin/)
  assert.match(managerSource, /buildPublicShareUrl/)
  assert.doesNotMatch(managerSource, /window\.location\.origin/)
  assert.doesNotMatch(source, /showPasswordModal|handleDecrypt|decrypt\(/)
  assert.doesNotMatch(source, />备忘录<|>日记<|浏览\s*\{\{/)
})

test('public shell defers private settings and keeps public metadata authoritative', async () => {
  const appUrl = new URL('../../app/src/App.vue', import.meta.url)
  const configUrl = new URL('../../app/src/shared/composables/useConfig.js', import.meta.url)
  const themeUrl = new URL('../../app/src/shared/composables/useTheme.js', import.meta.url)
  const [appSource, configSource, themeSource] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(configUrl, 'utf8'),
    readFile(themeUrl, 'utf8')
  ])

  assert.match(appSource, /Boolean\(route\.meta\.publicShell\)/)
  assert.match(appSource, /useTheme\(\{ defer: publicShell \}\)/)
  assert.match(appSource, /useConfig\(\{ defer: publicShell \}\)/)
  assert.match(appSource, /PUBLIC_SHELL_TOKENS/)
  assert.match(appSource, /root\.classList\.remove\('dark'\)/)
  assert.match(appSource, /root\.style\.setProperty\(name, value, 'important'\)/)
  assert.match(appSource, /root\.style\.setProperty\(name, state\.value, state\.priority\)/)
  assert.match(appSource, /if \(publicShell\.value\) return \{\}/)
  assert.match(configSource, /if \(unref\(options\.defer\)\) return/)
  assert.match(configSource, /if \(root\.classList\.contains\('public-shell'\)\) return/)
  assert.match(themeSource, /if \(unref\(options\.defer\)\) return/)
  assert.match(themeSource, /if \(root\.classList\.contains\('public-shell'\)\) return/)
})
