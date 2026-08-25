import assert from 'node:assert/strict'
import test from 'node:test'
import {
  imapTestDisabledReason,
  smtpTestDisabledReason
} from '../../app/src/shared/services/mailIntegrationState.js'

test('SMTP test readiness identifies the exact missing prerequisite', () => {
  const ready = {
    writable: true,
    busyAction: '',
    host: 'mail.example.com',
    username: 'mail@example.com',
    fromAddress: 'mail@example.com',
    passwordConfigured: true,
    hasUnsavedChanges: false
  }

  assert.equal(smtpTestDisabledReason(ready), '')
  assert.match(smtpTestDisabledReason({ ...ready, passwordConfigured: false }), /密码/)
  assert.match(smtpTestDisabledReason({ ...ready, hasUnsavedChanges: true }), /未保存/)
})

test('IMAP test readiness requires a visible saved NAV owner', () => {
  const ready = {
    writable: true,
    busyAction: '',
    ownerUsername: 'cristsau',
    host: 'mail.example.com',
    username: 'mail@example.com',
    passwordConfigured: true,
    hasUnsavedChanges: false
  }

  assert.equal(imapTestDisabledReason(ready), '')
  assert.match(imapTestDisabledReason({ ...ready, ownerUsername: '' }), /归属 NAV 用户名/)
  assert.match(imapTestDisabledReason({ ...ready, hasUnsavedChanges: true }), /未保存/)
})
