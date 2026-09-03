import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

function readZipEntries(archive) {
  let eocdOffset = -1
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset
      break
    }
  }

  assert.notEqual(eocdOffset, -1, 'ZIP end record not found')

  const entries = new Map()
  const entryCount = archive.readUInt16LE(eocdOffset + 10)
  let offset = archive.readUInt32LE(eocdOffset + 16)

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(archive.readUInt32LE(offset), 0x02014b50)

    const method = archive.readUInt16LE(offset + 10)
    const compressedSize = archive.readUInt32LE(offset + 20)
    const fileNameLength = archive.readUInt16LE(offset + 28)
    const extraLength = archive.readUInt16LE(offset + 30)
    const commentLength = archive.readUInt16LE(offset + 32)
    const localOffset = archive.readUInt32LE(offset + 42)
    const fileName = archive
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString('utf8')
      .replaceAll('\\', '/')

    assert.equal(archive.readUInt32LE(localOffset), 0x04034b50)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const compressed = archive.subarray(dataStart, dataStart + compressedSize)
    const content = method === 0
      ? compressed
      : method === 8
        ? inflateRawSync(compressed)
        : null

    if (content) entries.set(fileName, content)
    offset += 46 + fileNameLength + extraLength + commentLength
  }

  return entries
}

function canonicalExtensionContent(relativePath, content) {
  if (relativePath.endsWith('.png')) {
    return content
  }

  return Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'))
}

function pngDimensions(content) {
  assert.equal(content.subarray(1, 4).toString('ascii'), 'PNG')
  assert.equal(content.subarray(12, 16).toString('ascii'), 'IHDR')
  return {
    width: content.readUInt32BE(16),
    height: content.readUInt32BE(20)
  }
}

test('browser extension uses least-privilege default access and exposes quick add', async () => {
  const manifestUrl = new URL('../../extension/manifest.json', import.meta.url)
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))

  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.version, '1.2.0')
  assert.deepEqual(manifest.host_permissions, ['https://nav.skrskr.net/*'])
  assert.equal(manifest.permissions.includes('notifications'), false)
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'))
  assert.ok(manifest.commands['quick-add-last-group'])
  const expectedIcons = {
    16: 'assets/cristsau-mark-16.png',
    32: 'assets/cristsau-mark-32.png',
    48: 'assets/cristsau-mark-48.png',
    128: 'assets/cristsau-mark-128.png'
  }
  assert.deepEqual(manifest.icons, expectedIcons)
  assert.deepEqual(manifest.action.default_icon, expectedIcons)
})

test('website, PWA and extension use the reviewed CrisTsau brand derivatives', async () => {
  const indexUrl = new URL('../../app/index.html', import.meta.url)
  const manifestUrl = new URL('../../app/public/manifest.webmanifest', import.meta.url)
  const serviceWorkerUrl = new URL('../../app/public/sw.js', import.meta.url)
  const popupUrl = new URL('../../extension/popup.html', import.meta.url)
  const optionsUrl = new URL('../../extension/options.html', import.meta.url)

  const [indexHtml, pwaManifestSource, serviceWorker, popupHtml, optionsHtml] = await Promise.all([
    readFile(indexUrl, 'utf8'),
    readFile(manifestUrl, 'utf8'),
    readFile(serviceWorkerUrl, 'utf8'),
    readFile(popupUrl, 'utf8'),
    readFile(optionsUrl, 'utf8')
  ])
  const pwaManifest = JSON.parse(pwaManifestSource)
  const expectedAssets = [
    ['../../app/public/brand/cristsau-lockup-v2.png', 1200, 630, '1e8cb95310014c86cde060418d45a7521bb54d11ebf0eefdc00415a66d07bfe2'],
    ['../../app/public/icons/cristsau-mark-64-v2.png', 64, 64, '5901e4b252429164f4e82029793e2fb16558ca22410a6f72be9dd6576feabdde'],
    ['../../app/public/icons/cristsau-badge-96-v2.png', 96, 96, 'bb89a11208df38f2153246b3e670a5d5365f82ef2d7ba50714c8b9829116c985'],
    ['../../app/public/icons/cristsau-mark-180-v2.png', 180, 180, 'e6c33ec802d2d7094939aed6781d72edcb1bed18195e6a5d067e31dc32be4e36'],
    ['../../app/public/icons/cristsau-mark-192-v2.png', 192, 192, 'cd23cdf513e99b2b0c0e5998e71649eb6e87010de66889be1b4963d0b29be1a0'],
    ['../../app/public/icons/cristsau-mark-512-v2.png', 512, 512, 'd7653cc9dd9b048f1ccb54196b06318bb75d4e043edfff27955f0d7101dea24b'],
    ['../../app/public/icons/cristsau-mark-maskable-512-v2.png', 512, 512, '792f222456d5510ced68149079f66d39ebfe0ceb8f8a9a3769e5a490c698fb1f'],
    ['../../app/public/domo-logo.png', 512, 512, 'd7653cc9dd9b048f1ccb54196b06318bb75d4e043edfff27955f0d7101dea24b'],
    ['../../app/public/icons/apple-touch-icon-180-v1.png', 180, 180, 'e6c33ec802d2d7094939aed6781d72edcb1bed18195e6a5d067e31dc32be4e36'],
    ['../../app/public/icons/pwa-192-v1.png', 192, 192, 'cd23cdf513e99b2b0c0e5998e71649eb6e87010de66889be1b4963d0b29be1a0'],
    ['../../app/public/icons/pwa-512-v1.png', 512, 512, 'd7653cc9dd9b048f1ccb54196b06318bb75d4e043edfff27955f0d7101dea24b'],
    ['../../extension/assets/cristsau-mark-16.png', 16, 16, 'a82d48cc12278d770f9f8b932b4f85db725f20f0db2ee31e773b359651372566'],
    ['../../extension/assets/cristsau-mark-32.png', 32, 32, '37adec293ffc9a84ea58413ceb4ec24ce99d7838c3db1b948de1168e9103676c'],
    ['../../extension/assets/cristsau-mark-48.png', 48, 48, '4308824c022b51f93b20a872f7e55ecc5799aaecdaed9f327a2fefc7f37f4c32'],
    ['../../extension/assets/cristsau-mark-128.png', 128, 128, '6fbcab5e23e26a9321b493eff519fbedbd450844e943efff420fd12a670c9a39'],
    ['../../extension/assets/cristsau-mark-256.png', 256, 256, '0af20ef67a42f196441557e059c3d51c1d53bb069d72221685633504de0925e8'],
    ['../../extension/assets/domo-logo.png', 256, 256, '0af20ef67a42f196441557e059c3d51c1d53bb069d72221685633504de0925e8']
  ]

  const digest = (content) => createHash('sha256').update(content).digest('hex')
  for (const [path, width, height, expectedDigest] of expectedAssets) {
    const content = await readFile(new URL(path, import.meta.url))
    assert.deepEqual(pngDimensions(content), { width, height }, path)
    assert.equal(digest(content), expectedDigest, path)
  }

  assert.match(indexHtml, /href="\/icons\/cristsau-mark-64-v2\.png"/)
  assert.match(indexHtml, /href="\/icons\/cristsau-mark-180-v2\.png"/)
  assert.deepEqual(
    pwaManifest.icons.map(({ src, sizes, purpose }) => ({ src, sizes, purpose })),
    [
      { src: '/icons/cristsau-mark-192-v2.png', sizes: '192x192', purpose: 'any' },
      { src: '/icons/cristsau-mark-512-v2.png', sizes: '512x512', purpose: 'any' },
      { src: '/icons/cristsau-mark-maskable-512-v2.png', sizes: '512x512', purpose: 'maskable' }
    ]
  )
  assert.match(serviceWorker, /domonav-shell-v6/)
  assert.match(serviceWorker, /cristsau-mark-192-v2\.png/)
  assert.match(serviceWorker, /badge: '\/icons\/cristsau-badge-96-v2\.png'/)
  assert.match(popupHtml, /src="\.\/assets\/cristsau-mark-256\.png"/)
  assert.match(optionsHtml, /src="\.\/assets\/cristsau-mark-256\.png"/)
  assert.doesNotMatch(`${indexHtml}\n${pwaManifestSource}\n${serviceWorker}\n${popupHtml}\n${optionsHtml}`, /domo-logo\.png|pwa-(?:192|512)-v1|apple-touch-icon-180-v1/)
})

test('downloadable extension archive matches the reviewed source files', async () => {
  const archiveUrl = new URL('../../app/public/downloads/nav-extension.zip', import.meta.url)
  const archiveEntries = readZipEntries(await readFile(archiveUrl))

  for (const relativePath of [
    'manifest.json',
    'background.js',
    'README.md',
    'popup.js',
    'popup.html',
    'popup.css',
    'options.js',
    'options.html',
    'options.css',
    'assets/cristsau-mark-16.png',
    'assets/cristsau-mark-32.png',
    'assets/cristsau-mark-48.png',
    'assets/cristsau-mark-128.png',
    'assets/cristsau-mark-256.png',
    'assets/domo-logo.png'
  ]) {
    const sourceUrl = new URL(`../../extension/${relativePath}`, import.meta.url)
    const source = await readFile(sourceUrl)
    const archived = archiveEntries.get(relativePath)

    assert.ok(archived, `${relativePath} is missing from nav-extension.zip`)
    const canonicalSource = canonicalExtensionContent(relativePath, source)
    const canonicalArchived = canonicalExtensionContent(relativePath, archived)
    assert.equal(
      createHash('sha256').update(canonicalArchived).digest('hex'),
      createHash('sha256').update(canonicalSource).digest('hex'),
      `${relativePath} differs between source and nav-extension.zip`
    )
  }

  assert.equal(archiveEntries.has('assets/domo-logo.png'), true)
})
