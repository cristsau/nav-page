import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import { createSmtpTransport } from '../src/lib/mailOutbox.js'
import { freezeOutgoingMime } from '../src/lib/emailSentMessage.js'
import { classifyAuthSmtpFailure } from '../src/lib/authEmailDelivery.js'

// Synthetic loopback SMTP only. No provider, credentials, DNS or real mailbox.
async function fixture(t, { reject = false } = {}) {
  const messages = [], recipients = [], sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    socket.setEncoding('utf8')
    socket.write('220 fixture.example.test ESMTP\r\n')
    let pending = '', data = null
    socket.on('data', chunk => {
      pending += chunk
      let end
      while ((end = pending.indexOf('\r\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 2)
        if (data !== null) {
          if (line === '.') {
            messages.push(data.join('\r\n') + '\r\n'); data = null
            socket.write('250 queued synthetic message\r\n')
          } else data.push(line.replace(/^\.\./, '.'))
        } else if (/^(EHLO|HELO) /i.test(line)) socket.write('250-fixture.example.test\r\n250 8BITMIME\r\n')
        else if (/^MAIL FROM:/i.test(line)) socket.write('250 sender accepted\r\n')
        else if (/^RCPT TO:/i.test(line)) {
          recipients.push(line)
          socket.write(reject ? '550 synthetic rejection\r\n' : '250 recipient accepted\r\n')
        } else if (line === 'DATA') { data = []; socket.write('354 send data\r\n') }
        else if (line === 'QUIT') socket.end('221 bye\r\n')
        else socket.write('250 ok\r\n')
      }
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: server.address().port,
    secure: false, ignoreTLS: true, connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 3000 })
  t.after(async () => {
    transport.close()
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  return { transport, messages, recipients }
}

test('patched SMTP preserves frozen MIME, Unicode, attachments and private Bcc envelope', { timeout: 10000 }, async t => {
  const { transport, messages, recipients } = await fixture(t)
  const frozen = await freezeOutgoingMime({ outboxId: 'dependency-regression', date: '2026-01-01T00:00:00Z',
    runtimeConfig: { smtpFromName: 'NAV 测试', smtpFromAddress: 'sender@example.test' },
    payload: { to: ['receiver@example.test'], bcc: ['hidden@example.test'], subject: '合成邮件 regression', text: '你好\n.fixture' },
    attachments: [{ filename: 'fixture.txt', content: Buffer.from('synthetic attachment') }] })
  const result = await transport.sendMail({ raw: frozen.mime, envelope: frozen.envelope })
  assert.equal(result.accepted.length, 2)
  assert.equal(result.rejected.length, 0)
  assert.equal(recipients.length, 2)
  assert.equal(messages.length, 1)
  assert.equal(messages[0], frozen.mime.toString())
  assert.doesNotMatch(messages[0], /^bcc:|hidden@example\.test/im)
  const parsed = await simpleParser(messages[0])
  assert.equal(parsed.subject, '合成邮件 regression')
  assert.match(parsed.text, /你好\n\.fixture/)
  assert.equal(parsed.attachments[0].content.toString(), 'synthetic attachment')
  assert.equal(parsed.messageId, frozen.messageId)
})

test('patched SMTP rejection is still failed, never accepted or ambiguous', { timeout: 10000 }, async t => {
  const { transport, messages } = await fixture(t, { reject: true })
  await assert.rejects(transport.sendMail({ from: 'sender@example.test', to: 'receiver@example.test',
    subject: 'synthetic rejection', text: 'fixture', disableUrlAccess: true, disableFileAccess: true }), error => {
    assert.equal(error.responseCode, 550)
    assert.equal(classifyAuthSmtpFailure(error).state, 'failed')
    return true
  })
  assert.equal(messages.length, 0)
})

test('production transport retains implicit TLS, certificate verification and deadlines', async () => {
  const transport = await createSmtpTransport({ smtpHost: 'smtp.example.test', smtpPort: 465, smtpSecure: true,
    smtpUsername: 'sender@example.test', smtpFromAddress: 'sender@example.test', smtpPasswordFile: 'synthetic-only' },
  async () => 'synthetic-fixture-not-a-credential')
  try {
    assert.equal(transport.options.secure, true)
    assert.deepEqual(transport.options.tls, { minVersion: 'TLSv1.2', rejectUnauthorized: true })
    assert.equal(transport.options.connectionTimeout, 10000)
    assert.equal(transport.options.socketTimeout, 30000)
  } finally { transport.close() }
})
