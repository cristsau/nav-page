import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'

export const OUTBOUND_CONNECTION_ATTEMPT_TIMEOUT_MS = 1000

export function configureOutboundNetwork() {
  setDefaultAutoSelectFamilyAttemptTimeout(OUTBOUND_CONNECTION_ATTEMPT_TIMEOUT_MS)
}
