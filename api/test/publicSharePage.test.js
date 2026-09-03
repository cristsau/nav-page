import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  createPublicShareMetadata,
  createUnavailableShareMetadata,
  injectPublicShareMetadata,
  normalizePublicAppOrigin
} from '../src/lib/publicSharePage.js'

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="description" content="static description">
    <meta property="og:title" content="stale title">
    <link rel="canonical" href="https://stale.example/share">
    <title>Static title</title>
  </head>
  <body><div id="app"></div><script type="module" src="/assets/app-123.js"></script></body>
</html>`

test('public origin is fixed, bare and HTTPS in production', () => {
  assert.equal(
    normalizePublicAppOrigin('https://nav.skrskr.net', { production: true }),
    'https://nav.skrskr.net'
  )
  assert.throws(
    () => normalizePublicAppOrigin('https://nav.skrskr.net/subpath', { production: true }),
    /bare HTTPS origin/
  )
  assert.throws(
    () => normalizePublicAppOrigin('http://nav.skrskr.net', { production: true }),
    /bare HTTPS origin/
  )
  assert.throws(
    () => normalizePublicAppOrigin('', { production: true }),
    /required in production/
  )
})

test('dynamic share head replaces static metadata without duplicating managed tags', () => {
  const metadata = {
    title: '部署摘要 · DOMO NAV',
    description: '服务名称：nav-api',
    canonicalUrl: 'https://nav.skrskr.net/share/AbCd2345',
    imageUrl: 'https://nav.skrskr.net/brand/cristsau-lockup-v2.png',
    siteName: 'DOMO NAV'
  }
  const html = injectPublicShareMetadata(INDEX_HTML, metadata)

  assert.equal((html.match(/<title\b/gi) || []).length, 1)
  assert.equal((html.match(/name="description"/gi) || []).length, 1)
  assert.equal((html.match(/property="og:title"/gi) || []).length, 1)
  assert.equal((html.match(/rel="canonical"/gi) || []).length, 1)
  assert.match(html, /<title>部署摘要 · DOMO NAV<\/title>/)
  assert.match(html, /name="referrer" content="no-referrer"/)
  assert.match(html, /property="og:type" content="article"/)
  assert.match(html, /name="twitter:card" content="summary_large_image"/)
  assert.match(html, /src="\/assets\/app-123\.js"/)
  assert.doesNotMatch(html, /static description|stale title|Static title/)
})

test('dynamic metadata escapes hostile note text and keeps a fixed canonical origin', () => {
  const metadata = createPublicShareMetadata({
    code: 'AbCd2345',
    title: '"><script>alert(1)</script>',
    content: 'hello" onmouseover="alert(2)',
    attachments: []
  }, {
    appOrigin: 'https://nav.skrskr.net',
    imgBedBaseUrl: 'https://pic.skrskr.net'
  })
  const html = injectPublicShareMetadata(INDEX_HTML, metadata)

  assert.equal(metadata.canonicalUrl, 'https://nav.skrskr.net/share/AbCd2345')
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.match(html, /hello&quot; onmouseover=&quot;alert\(2\)/)
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/)
})

test('public share image accepts only the configured image-bed origin', () => {
  const attachment = {
    id: '550e8400-e29b-41d4-a716-446655440000',
    url: 'https://other.example/file/preview.png',
    name: 'preview.png',
    mime: 'image/png',
    size: 1024,
    createdAt: '2026-07-31T03:00:00.000Z'
  }
  const metadata = createPublicShareMetadata({
    code: 'AbCd2345',
    title: '部署摘要',
    content: '服务名称：nav-api',
    attachments: [attachment]
  }, {
    appOrigin: 'https://nav.skrskr.net',
    imgBedBaseUrl: 'https://pic.skrskr.net'
  })

  assert.equal(metadata.imageUrl, 'https://nav.skrskr.net/brand/cristsau-lockup-v2.png')
})

test('invalid share codes are never reflected into canonical URLs', () => {
  const metadata = createUnavailableShareMetadata(
    'bad/code?<script>',
    { appOrigin: 'https://nav.skrskr.net' }
  )

  assert.equal(metadata.canonicalUrl, 'https://nav.skrskr.net/')
})

test('top-level HTML route skips sessions and never increments share views', async () => {
  const [appSource, routeSource] = await Promise.all([
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/routes/publicSharePage.js', import.meta.url), 'utf8')
  ])

  assert.match(appSource, /app\.register\(publicSharePageRoutes\)/)
  assert.doesNotMatch(appSource, /publicSharePageRoutes,\s*\{\s*prefix:/)
  assert.match(routeSource, /fastify\.get\('\/share\/:code'/)
  assert.match(routeSource, /skipSession:\s*true/)
  assert.match(routeSource, /Referrer-Policy', 'no-referrer'/)
  assert.match(routeSource, /readFile\(config\.frontendIndexPath,\s*'utf8'\)/)
  assert.doesNotMatch(routeSource, /\bUPDATE\b|view_count\s*=\s*view_count\s*\+/i)
})
