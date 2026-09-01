import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  EMAIL_ATTACHMENT_TRANSLATION_LIMITS,
  EmailAttachmentTranslationError,
  extractEmailAttachmentTranslationInput,
  extractEmailAttachmentTranslationInputAsync,
  isTranslatableEmailAttachmentMetadata
} from '../src/lib/emailAttachmentTranslation.js'
import {
  buildDocx,
  buildPdf,
  buildPptx,
  buildXlsx,
  buildZip
} from './helpers/emailDocumentFixtures.js'

test('attachment translation accepts only declared or strongly named text formats', () => {
  assert.equal(isTranslatableEmailAttachmentMetadata({ contentType: 'text/plain' }), true)
  assert.equal(isTranslatableEmailAttachmentMetadata({ contentType: 'application/problem+json' }), true)
  assert.equal(isTranslatableEmailAttachmentMetadata({ contentType: 'application/xml' }), true)
  assert.equal(isTranslatableEmailAttachmentMetadata({
    contentType: 'application/octet-stream',
    filename: 'notes.md'
  }), true)
  assert.equal(isTranslatableEmailAttachmentMetadata({
    contentType: 'application/pdf',
    filename: 'report.pdf'
  }), true)
  assert.equal(isTranslatableEmailAttachmentMetadata({
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: 'report.docx'
  }), true)
  assert.equal(isTranslatableEmailAttachmentMetadata({
    contentType: 'application/octet-stream',
    filename: 'slides.pptx'
  }), true)
  assert.equal(isTranslatableEmailAttachmentMetadata({
    contentType: 'application/pdf',
    filename: 'mismatch.docx'
  }), false)
})

test('attachment translation extracts bounded UTF-8 text without executing or parsing markup', () => {
  const source = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('<script>do not execute</script>\nHello world', 'utf8')
  ])
  const result = extractEmailAttachmentTranslationInput({
    filename: 'mail.html',
    contentType: 'text/html; charset=utf-8',
    content: source
  })

  assert.equal(result.text, '<script>do not execute</script>\nHello world')
  assert.equal(result.filename, 'mail.html')
  assert.equal(result.contentType, 'text/html')
  assert.equal(result.sourceBytes, source.length)
  assert.equal(result.sourceCharacters, result.text.length)
})

test('synchronous text extraction refuses documents, oversized, binary and unsupported encodings explicitly', () => {
  const cases = [
    {
      value: { filename: 'report.pdf', contentType: 'application/pdf', content: Buffer.from('%PDF-1.7') },
      code: 'EMAIL_ATTACHMENT_TRANSLATION_UNSUPPORTED_TYPE',
      statusCode: 415
    },
    {
      value: {
        filename: 'large.txt',
        contentType: 'text/plain',
        content: Buffer.alloc(EMAIL_ATTACHMENT_TRANSLATION_LIMITS.maximumBytes + 1, 0x61)
      },
      code: 'EMAIL_ATTACHMENT_TRANSLATION_TOO_LARGE',
      statusCode: 413
    },
    {
      value: {
        filename: 'long.txt',
        contentType: 'text/plain',
        content: Buffer.from('a'.repeat(EMAIL_ATTACHMENT_TRANSLATION_LIMITS.maximumCharacters + 1))
      },
      code: 'EMAIL_ATTACHMENT_TRANSLATION_TEXT_TOO_LARGE',
      statusCode: 413
    },
    {
      value: {
        filename: 'binary.txt',
        contentType: 'text/plain',
        content: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 65])
      },
      code: 'EMAIL_ATTACHMENT_TRANSLATION_BINARY_CONTENT',
      statusCode: 422
    },
    {
      value: {
        filename: 'utf16.txt',
        contentType: 'text/plain',
        content: Buffer.from([0xff, 0xfe, 0x41, 0x00])
      },
      code: 'EMAIL_ATTACHMENT_TRANSLATION_UNSUPPORTED_ENCODING',
      statusCode: 422
    }
  ]

  for (const item of cases) {
    assert.throws(
      () => extractEmailAttachmentTranslationInput(item.value),
      (error) => error instanceof EmailAttachmentTranslationError
        && error.code === item.code
        && error.statusCode === item.statusCode
    )
  }
})

test('attachment translation rejects malformed UTF-8 instead of replacing bytes silently', () => {
  assert.throws(
    () => extractEmailAttachmentTranslationInput({
      filename: 'bad.txt',
      contentType: 'text/plain',
      content: Buffer.from([0xc3, 0x28])
    }),
    (error) => error.code === 'EMAIL_ATTACHMENT_TRANSLATION_INVALID_TEXT'
  )
})

test('document extraction preserves PDF pages, DOCX body, PPTX slides and XLSX worksheets', async () => {
  const cases = [
    {
      filename: 'report.pdf',
      contentType: 'application/pdf',
      content: buildPdf('Hello PDF'),
      format: 'pdf',
      marker: '[PDF 第 1 页]',
      text: 'Hello PDF',
      unitType: 'page'
    },
    {
      filename: 'report.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: buildDocx('Hello DOCX'),
      format: 'docx',
      marker: '[文档正文]',
      text: 'Hello DOCX',
      unitType: 'document'
    },
    {
      filename: 'slides.pptx',
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      content: buildPptx('Hello PPTX'),
      format: 'pptx',
      marker: '[幻灯片 1]',
      text: 'Hello PPTX',
      unitType: 'slide'
    },
    {
      filename: 'table.xlsx',
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      content: buildXlsx('Hello XLSX'),
      format: 'xlsx',
      marker: '[工作表 1：Inbox]',
      text: 'A1: Hello XLSX',
      unitType: 'sheet'
    }
  ]

  for (const item of cases) {
    const result = await extractEmailAttachmentTranslationInputAsync(item)
    assert.equal(result.sourceFormat, item.format)
    assert.match(result.text, new RegExp(item.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(result.text, new RegExp(item.text))
    assert.equal(result.sourceUnits[0].type, item.unitType)
    assert.equal(result.sourceUnits[0].index, 1)
    assert.equal(result.sourceBytes, item.content.length)
  }
})

test('document extraction rejects encrypted, macro, external and embedded OOXML content', async () => {
  const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
  const documentXml = '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>safe</w:t></w:r></w:p></w:body></w:document>'
  const cases = [
    {
      content: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]),
      code: 'EMAIL_ATTACHMENT_TRANSLATION_ENCRYPTED'
    },
    {
      content: buildZip([
        { name: '[Content_Types].xml', content: contentTypes },
        { name: 'word/document.xml', content: documentXml, encrypted: true }
      ]),
      code: 'EMAIL_ATTACHMENT_TRANSLATION_ENCRYPTED'
    },
    {
      content: buildZip([
        { name: '[Content_Types].xml', content: contentTypes },
        { name: 'word/document.xml', content: documentXml },
        { name: 'word/vbaProject.bin', content: 'macro' }
      ]),
      code: 'EMAIL_ATTACHMENT_TRANSLATION_MACRO'
    },
    {
      content: buildZip([
        { name: '[Content_Types].xml', content: contentTypes },
        { name: 'word/document.xml', content: documentXml },
        {
          name: 'word/_rels/document.xml.rels',
          content: '<Relationships xmlns="urn:r"><Relationship Id="r1" TargetMode="External" Target="https://example.com/payload"/></Relationships>'
        }
      ]),
      code: 'EMAIL_ATTACHMENT_TRANSLATION_EXTERNAL_RELATIONSHIP'
    },
    {
      content: buildZip([
        { name: '[Content_Types].xml', content: contentTypes },
        { name: 'word/document.xml', content: documentXml },
        { name: 'word/embeddings/object1.bin', content: 'embedded' }
      ]),
      code: 'EMAIL_ATTACHMENT_TRANSLATION_EMBEDDED_OBJECT'
    },
    {
      content: buildZip([
        { name: '[Content_Types].xml', content: contentTypes },
        { name: 'word/document.xml', content: '<!DOCTYPE x [<!ENTITY y "boom">]><w:document xmlns:w="urn:w"><w:p><w:r><w:t>&y;</w:t></w:r></w:p></w:document>' }
      ]),
      code: 'EMAIL_ATTACHMENT_TRANSLATION_UNSAFE_XML'
    },
    {
      content: buildZip([
        { name: '[Content_Types].xml', content: contentTypes },
        { name: 'word/document.xml', content: documentXml },
        { name: 'WORD/DOCUMENT.XML', content: documentXml }
      ]),
      code: 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID'
    }
  ]

  for (const item of cases) {
    await assert.rejects(
      extractEmailAttachmentTranslationInputAsync({
        filename: 'unsafe.docx',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        content: item.content
      }),
      (error) => error instanceof EmailAttachmentTranslationError
        && error.code === item.code
    )
  }
})

test('document extraction enforces archive count, compression ratio, character and time limits', async () => {
  const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'
  const documentXml = '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>safe</w:t></w:r></w:p></w:body></w:document>'
  const compressionBomb = buildZip([
    { name: '[Content_Types].xml', content: contentTypes },
    { name: 'word/document.xml', content: documentXml },
    { name: 'word/media/repeated.bin', content: Buffer.alloc(256 * 1024, 0x41) }
  ])

  const base = {
    filename: 'bounded.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
  const cases = [
    {
      value: { ...base, content: compressionBomb },
      options: {},
      code: 'EMAIL_ATTACHMENT_TRANSLATION_COMPRESSION_BOMB'
    },
    {
      value: { ...base, content: buildDocx('entry count') },
      options: { maximumArchiveEntries: 1 },
      code: 'EMAIL_ATTACHMENT_TRANSLATION_ARCHIVE_LIMIT'
    },
    {
      value: { ...base, content: buildDocx('source size') },
      options: { maximumDocumentBytes: 100 },
      code: 'EMAIL_ATTACHMENT_TRANSLATION_TOO_LARGE'
    },
    {
      value: { ...base, content: buildDocx('x'.repeat(500)) },
      options: { maximumCharacters: 100 },
      code: 'EMAIL_ATTACHMENT_TRANSLATION_TEXT_TOO_LARGE'
    },
    {
      value: { ...base, content: buildDocx('timeout') },
      options: { timeoutMs: 1 },
      code: 'EMAIL_ATTACHMENT_TRANSLATION_TIMEOUT'
    }
  ]
  for (const item of cases) {
    await assert.rejects(
      extractEmailAttachmentTranslationInputAsync(item.value, item.options),
      (error) => error.code === item.code
    )
  }
})

test('PDF extraction rejects encryption and refuses OCR when no text layer exists', async () => {
  await assert.rejects(
    extractEmailAttachmentTranslationInputAsync({
      filename: 'encrypted.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('%PDF-1.4\n1 0 obj << /Encrypt 2 0 R >>\nendobj\n%%EOF', 'latin1')
    }),
    (error) => error.code === 'EMAIL_ATTACHMENT_TRANSLATION_ENCRYPTED'
  )
  await assert.rejects(
    extractEmailAttachmentTranslationInputAsync({
      filename: 'scan.pdf',
      contentType: 'application/pdf',
      content: buildPdf('')
    }),
    (error) => error.code === 'EMAIL_ATTACHMENT_TRANSLATION_NO_TEXT_LAYER'
  )
})

test('document translation remains ownership-bound and does not persist extracted plaintext', () => {
  const workerSource = readFileSync(new URL('../src/lib/emailDocumentTextWorker.js', import.meta.url), 'utf8')
  const routeSource = readFileSync(new URL('../src/routes/email.js', import.meta.url), 'utf8')
  assert.doesNotMatch(workerSource, /node:fs|writeFile|appendFile|createWriteStream|tmpdir/)
  assert.doesNotMatch(workerSource, /node:(?:child_process|http|https|net|tls|dns)|\b(?:exec|execFile|spawn|fork)\s*\(/)
  assert.match(workerSource, /globalThis\.fetch\s*=\s*async\s*\(\)\s*=>\s*\{[\s\S]*Network access is disabled/)
  assert.match(routeSource, /location\.user_id = \$3/)
  assert.match(routeSource, /await extractEmailAttachmentTranslationInputAsync\(attachment\)/)
  assert.match(routeSource, /finally \{[\s\S]*attachment\?\.content[\s\S]*fill\(0\)/)
  assert.doesNotMatch(routeSource, /INSERT INTO email_[\s\S]{0,300}sourceUnits/)
})
