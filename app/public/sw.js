const CACHE_VERSION = 'domonav-shell-v2'
const SHELL_ASSETS = [
  '/offline.html',
  '/manifest.webmanifest',
  '/domo-logo.png',
  '/icons/pwa-192-v1.png',
  '/icons/pwa-512-v1.png',
  '/icons/apple-touch-icon-180-v1.png'
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_ASSETS)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data?.json?.() || {}
  } catch {
    payload = { body: event.data?.text?.() || '' }
  }
  const title = String(payload.title || 'DOMO NAV').slice(0, 120)
  const options = {
    body: String(payload.body || '你有一条新的到期提醒').slice(0, 240),
    icon: '/icons/pwa-192-v1.png',
    badge: '/icons/pwa-192-v1.png',
    tag: String(payload.tag || 'domo-nav-reminder').slice(0, 128),
    renotify: false,
    timestamp: Number(payload.timestamp) || Date.now(),
    data: {
      url: String(payload.url || '/whisper?reminders=1')
    }
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const requestedUrl = new URL(
    event.notification.data?.url || '/whisper?reminders=1',
    self.location.origin
  )
  const targetUrl = requestedUrl.origin === self.location.origin
    ? requestedUrl.href
    : new URL('/whisper?reminders=1', self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(async (clients) => {
        const current = clients.find((client) => new URL(client.url).origin === self.location.origin)
        if (!current) return self.clients.openWindow(targetUrl)
        if ('navigate' in current) await current.navigate(targetUrl)
        return current.focus()
      })
  )
})

function isPrivateRequest(url) {
  return (
    url.pathname.startsWith('/api/')
    || url.pathname.startsWith('/share/')
    || url.pathname.startsWith('/quick-add')
  )
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || isPrivateRequest(url)) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => (
        (await caches.match('/offline.html')) || Response.error()
      ))
    )
    return
  }

  if (/^\/assets\/[^/]+\.[a-z0-9]+$/i.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy))
        }
        return response
      }))
    )
    return
  }

  if (SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request)))
  }
})
