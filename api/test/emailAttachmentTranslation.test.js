import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EMAIL_ATTACHMENT_TRANSLATION_LIMITS,
  EmailAttachmentTranslationError,
  extractEmailAttachmentTranslationInput,
  isTranslatableEmailAttachmentMetadata
} from '../src/lib/emailAttachmentTranslation.js'

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
  }), false)
  assert.equal(isTranslatableEmailAttachmentMetadata({
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: 'report.docx'
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

test('attachment translation refuses PDF, oversized, binary and unsupported encodings explicitly', () => {
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
