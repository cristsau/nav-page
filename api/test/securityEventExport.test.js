import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SECURITY_EVENT_EXPORT_MAX_ROWS,
  normalizeSecurityEventExportFormat,
  securityEventExportFilename,
  serializeSecurityEventExport
} from '../src/lib/securityEventExport.js'

const EVENTS = [{
  id: '42',
  eventType: 'auth.login',
  outcome: 'failure',
  actorUserId: null,
  subjectUserId: 'user-1',
  resourceType: 'user',
  resourceId: 'resource,with-comma',
  affectedCount: 1,
  clientFingerprint: '0123456789abcdef',
  userAgentFingerprint: 'fedcba9876543210',
  createdAt: '2026-08-21T01:02:03.000Z'
}]

test('security-event export formats are explicit and bounded', () => {
  assert.equal(normalizeSecurityEventExportFormat('CSV'), 'csv')
  assert.equal(normalizeSecurityEventExportFormat('json'), 'json')
  assert.equal(normalizeSecurityEventExportFormat('xml'), '')
  assert.equal(SECURITY_EVENT_EXPORT_MAX_ROWS, 10_000)
})

test('CSV export is UTF-8 friendly and escapes cells', () => {
  const result = serializeSecurityEventExport({ events: EVENTS, format: 'csv' })
  assert.equal(result.contentType, 'text/csv; charset=utf-8')
  assert.ok(result.body.startsWith('\uFEFFid,event_type,outcome'))
  assert.match(result.body, /"resource,with-comma"/)
  assert.doesNotMatch(result.body, /198\.51\.100\./)
})

test('JSON export records filters and truncation without raw network values', () => {
  const result = serializeSecurityEventExport({
    events: EVENTS,
    format: 'json',
    generatedAt: '2026-08-21T01:02:03.000Z',
    truncated: true,
    filters: { eventType: 'auth.login', outcome: 'failure' }
  })
  const payload = JSON.parse(result.body)
  assert.equal(payload.truncated, true)
  assert.deepEqual(payload.filters, { eventType: 'auth.login', outcome: 'failure' })
  assert.equal(payload.events[0].clientFingerprint, '0123456789abcdef')
})

test('download filenames are deterministic and ASCII-safe', () => {
  assert.equal(
    securityEventExportFilename('json', '2026-08-21T01:02:03.456Z'),
    'nav-security-events-20260821T010203Z.json'
  )
})
