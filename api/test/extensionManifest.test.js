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

test('browser extension uses least-privilege default access and exposes quick add', async () => {
  const manifestUrl = new URL('../../extension/manifest.json', import.meta.url)
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'))

  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.version, '1.1.1')
  assert.deepEqual(manifest.host_permissions, ['https://nav.skrskr.net/*'])
  assert.equal(manifest.permissions.includes('notifications'), false)
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'))
  assert.ok(manifest.commands['quick-add-last-group'])
  assert.equal(manifest.icons['128'], 'assets/domo-logo.png')
  assert.equal(manifest.action.default_icon, 'assets/domo-logo.png')
})

test('website and extension use the exact same supplied brand image', async () => {
  const siteLogoUrl = new URL('../../app/public/domo-logo.png', import.meta.url)
  const extensionLogoUrl = new URL('../../extension/assets/domo-logo.png', import.meta.url)
  const indexUrl = new URL('../../app/index.html', import.meta.url)
  const popupUrl = new URL('../../extension/popup.html', import.meta.url)
  const optionsUrl = new URL('../../extension/options.html', import.meta.url)

  const [siteLogo, extensionLogo, indexHtml, popupHtml, optionsHtml] = await Promise.all([
    readFile(siteLogoUrl),
    readFile(extensionLogoUrl),
    readFile(indexUrl, 'utf8'),
    readFile(popupUrl, 'utf8'),
    readFile(optionsUrl, 'utf8')
  ])

  const digest = (content) => createHash('sha256').update(content).digest('hex')
  const suppliedLogoDigest = 'e7b2785916ca75f2b5ae2002b591eeb6b713c149ceb161b07a2653cbf96cba82'

  assert.equal(digest(siteLogo), suppliedLogoDigest)
  assert.equal(digest(extensionLogo), suppliedLogoDigest)
  assert.match(indexHtml, /href="\/domo-logo\.png"/)
  assert.match(popupHtml, /src="\.\/assets\/domo-logo\.png"/)
  assert.match(optionsHtml, /src="\.\/assets\/domo-logo\.png"/)
  assert.doesNotMatch(`${popupHtml}\n${optionsHtml}`, /domo-(?:avatar|mark)\.svg/)
})

test('downloadable extension archive matches the reviewed source files', async () => {
  const archiveUrl = new URL('../../app/public/downloads/nav-extension.zip', import.meta.url)
  const archiveEntries = readZipEntries(await readFile(archiveUrl))

  for (const relativePath of [
    'manifest.json',
    'background.js',
    'popup.js',
    'popup.html',
    'options.html',
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

  assert.equal(archiveEntries.has('assets/domo-avatar.svg'), false)
  assert.equal(archiveEntries.has('assets/domo-mark.svg'), false)
})
