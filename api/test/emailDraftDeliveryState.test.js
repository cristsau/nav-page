import test from 'node:test'
import assert from 'node:assert/strict'
import { mapDraftDeliveryState } from '../src/routes/email.js'

test('draft delivery state reports Sent synchronization as disabled when the worker is disabled', () => {
  assert.deepEqual(
    mapDraftDeliveryState('sent', null, { sentAppendEnabled: false }),
    { deliveryStatus: 'accepted', sentSyncStatus: 'disabled' }
  )
})

test('draft delivery state distinguishes queued, active, complete, and missing Sent jobs', () => {
  assert.deepEqual(
    mapDraftDeliveryState('pending', null, { sentAppendEnabled: true }),
    { deliveryStatus: 'queued', sentSyncStatus: 'pending' }
  )
  assert.deepEqual(
    mapDraftDeliveryState('sending', 'appending', { sentAppendEnabled: true }),
    { deliveryStatus: 'sending', sentSyncStatus: 'syncing' }
  )
  assert.deepEqual(
    mapDraftDeliveryState('sent', 'appended', { sentAppendEnabled: true }),
    { deliveryStatus: 'accepted', sentSyncStatus: 'synced' }
  )
  assert.deepEqual(
    mapDraftDeliveryState('sent', null, { sentAppendEnabled: true }),
    { deliveryStatus: 'accepted', sentSyncStatus: 'unavailable' }
  )
})

test('draft delivery state preserves ambiguous and partial SMTP outcomes for manual review', () => {
  assert.deepEqual(
    mapDraftDeliveryState('expired', 'cancelled', {
      sentAppendEnabled: true,
      deliveryErrorCode: 'AMBIGUOUS_DELIVERY_STATE'
    }),
    { deliveryStatus: 'ambiguous', sentSyncStatus: 'failed' }
  )
  assert.deepEqual(
    mapDraftDeliveryState('expired', 'pending', {
      sentAppendEnabled: true,
      deliveryErrorCode: 'PARTIAL_RECIPIENT_REJECTION'
    }),
    { deliveryStatus: 'partial', sentSyncStatus: 'pending' }
  )
})
