export const WEBAUTHN_RELYING_PARTIES = Object.freeze([
  Object.freeze({
    origin: 'https://nav.skrskr.net',
    rpId: 'nav.skrskr.net'
  }),
  Object.freeze({
    origin: 'https://nav.cristsau.cn',
    rpId: 'nav.cristsau.cn'
  })
])

export function resolveWebAuthnRelyingParty(origin) {
  const normalized = String(origin || '').trim().toLowerCase()
  return WEBAUTHN_RELYING_PARTIES.find((item) => item.origin === normalized) || null
}
