export function applicationServerKey(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = `${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)))
}

export function webPushPermissionBlockReason(permission) {
  return permission === 'denied' ? '通知权限未获允许' : ''
}

export function startWebPushSubscription(registration, publicKey) {
  if (!registration?.active || !registration?.pushManager) {
    const error = new Error('Service Worker 尚未就绪')
    error.webPushStage = 'service-worker'
    throw error
  }
  return registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(publicKey)
  })
}
