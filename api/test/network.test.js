import test from 'node:test'
import assert from 'node:assert/strict'
import {
  getDefaultAutoSelectFamilyAttemptTimeout,
  setDefaultAutoSelectFamilyAttemptTimeout
} from 'node:net'
import {
  configureOutboundNetwork,
  OUTBOUND_CONNECTION_ATTEMPT_TIMEOUT_MS
} from '../src/lib/network.js'

test('outbound connections tolerate slower IPv4 before trying an unavailable IPv6 route', () => {
  const previousTimeout = getDefaultAutoSelectFamilyAttemptTimeout()

  try {
    configureOutboundNetwork()
    assert.equal(
      getDefaultAutoSelectFamilyAttemptTimeout(),
      OUTBOUND_CONNECTION_ATTEMPT_TIMEOUT_MS
    )
    assert.equal(OUTBOUND_CONNECTION_ATTEMPT_TIMEOUT_MS, 1000)
  } finally {
    setDefaultAutoSelectFamilyAttemptTimeout(previousTimeout)
  }
})
