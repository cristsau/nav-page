import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decorateIncomingAttachmentMetadata,
  fetchIncomingAttachment,
  normalizeIncomingAttachmentMetadata,
  safeAttachmentDownloadName
} from '../src/lib/emailIncomingAttachments.js'

const runtimeConfig = {
  emailSourceKey: 'mxroute',
  emailOwnerUsername: 'owner',
  imapHost: 'mail.example.test',
  imapPort: 993,
  imapSecure: true,
  imapUsername: 'owner@example.test',
  imapPasswordFile: '/run/secrets/imap',
  imapMailbox: 'INBOX'
}

test('incoming attachment identifiers are stable and metadata-only', () => {
  const first = normalizeIncomingAttachmentMetadata({
    filename: ' report.pdf ',
    contentType: 'APPLICATION/PDF',
    contentDisposition: 'attachment',
    contentId: '<report>',
    size: 128
  }, 0)
  const second = decorateIncomingAttachmentMetadata([{
    filename: ' report.pdf ',
    contentType: 'APPLICATION/PDF',
    contentDisposition: 'attachment',
    contentId: '<report>',
    size: 128,
    content: Buffer.from('must not escape')
  }])[0]
  assert.deepEqual(first, second)
  assert.match(first.id, /^[0-9a-f]{32}$/)
  assert.equal('content' in first, false)
  assert.equal(safeAttachmentDownloadName('../bad:name.pdf'), '_bad_name.pdf')
})

test('incoming attachment fetch validates UIDVALIDITY and returns only the selected attachment', async () => {
  const attachments = [
    { filename: 'one.txt', contentType: 'text/plain', content: Buffer.from('one') },
    { filename: 'two.txt', contentType: 'text/plain', content: Buffer.from('two') }
  ]
  const selectedId = decorateIncomingAttachmentMetadata(attachments)[1].id
  let closed = false
  let released = false
  class FakeImapClient {
    constructor() { this.usable = true; this.mailbox = { uidValidity: 55 } }
    async connect() {}
    async getMailboxLock(path, options) {
      assert.equal(path, 'INBOX')
      assert.equal(options.readOnly, true)
      return { release: () => { released = true } }
    }
    async fetchOne(uid, query, options) {
      assert.equal(uid, 7)
      assert.equal(options.uid, true)
      assert.ok(query.source.maxLength > 1)
      return { source: Buffer.from('raw message bytes') }
    }
    async logout() { closed = true }
  }
  const result = await fetchIncomingAttachment({
    folder_path: 'INBOX', uid: 7, uid_validity: 55, size_bytes: 17
  }, selectedId, runtimeConfig, {
    ImapClient: FakeImapClient,
    parseMessage: async () => ({ attachments }),
    readSecret: async () => 'secret',
    assertHost: async () => []
  })
  assert.equal(result.filename, 'two.txt')
  assert.equal(result.content.toString(), 'two')
  assert.equal(released, true)
  assert.equal(closed, true)
})

test('incoming attachment fetch refuses a stale UIDVALIDITY before fetching content', async () => {
  let fetched = false
  class FakeImapClient {
    constructor() { this.usable = true; this.mailbox = { uidValidity: 99 } }
    async connect() {}
    async getMailboxLock() { return { release() {} } }
    async fetchOne() { fetched = true }
    async logout() {}
  }
  await assert.rejects(() => fetchIncomingAttachment({
    folder_path: 'INBOX', uid: 7, uid_validity: 55, size_bytes: 100
  }, 'a'.repeat(32), runtimeConfig, {
    ImapClient: FakeImapClient,
    readSecret: async () => 'secret',
    assertHost: async () => []
  }), (error) => error.code === 'EMAIL_UIDVALIDITY_CHANGED')
  assert.equal(fetched, false)
})
