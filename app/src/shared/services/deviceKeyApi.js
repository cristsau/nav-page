import { apiRequest } from './apiClient'

const post = (path, body) => apiRequest(`/auth/device-keys/${path}`, {
  method: 'POST', body: JSON.stringify(body), expectedUnauthorized: true
})
export const fetchDeviceKeyConfig = () => apiRequest('/auth/device-keys/config', { cache: 'no-store', expectedUnauthorized: true })
export const fetchDeviceKeys = () => apiRequest('/auth/device-keys', { cache: 'no-store' })
export const removeDeviceKey = (id, currentPassword) => post('remove', { id, currentPassword })

export async function browserSupportsDeviceKeys() {
  try {
    return Boolean(window.isSecureContext && window.PublicKeyCredential
      && await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())
  } catch { return false }
}

export async function enrollDeviceKey({ name, currentPassword }) {
  const { startRegistration } = await import('@simplewebauthn/browser')
  const { options, challengeId } = await post('register/options', { name, currentPassword })
  const response = await startRegistration({ optionsJSON: options })
  return post('register/verify', { challengeId, response })
}

export async function loginWithDeviceKey(trustDevice = false) {
  const { startAuthentication } = await import('@simplewebauthn/browser')
  const { options, challengeId } = await post('login/options', { trustDevice })
  const response = await startAuthentication({ optionsJSON: options })
  return post('login/verify', { challengeId, response })
}

export function deviceKeyMessage(error) {
  if (['NotAllowedError', 'AbortError'].includes(error?.name)) return '已取消或未完成设备验证。你仍可使用邮箱或账号密码。'
  if (error?.name === 'InvalidStateError') return '这个设备可能已保存此账号的通行密钥，请直接尝试快捷登录。'
  return ({
    DEVICE_KEY_REAUTH_REQUIRED: '当前密码验证失败，请重新输入。',
    DEVICE_KEY_LIMIT: '最多可保存 10 个通行密钥，请先移除不再使用的密钥。',
    DEVICE_KEY_RATE_LIMIT: '尝试过于频繁，请稍后再试。',
    DEVICE_KEY_UNAVAILABLE: '快捷登录暂不可用，请使用邮箱或账号密码。',
    DEVICE_KEY_ORIGIN: '请从已登记的主域名使用快捷登录。'
  })[error?.code] || '设备验证未完成，请重试或使用其他登录方式。'
}
