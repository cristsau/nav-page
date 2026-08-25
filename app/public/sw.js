const CACHE_VERSION = 'domonav-shell-v4'
const OFFLINE_SYNC_DB = 'NavPageOfflineSyncDB'
const OFFLINE_SYNC_STORE = 'mutations'
const OFFLINE_SYNC_TAG = 'domo-nav-offline-sync'
const SHELL_ASSETS = [
  '/',
  '/offline.html',
  '/manifest.webmanifest',
  '/domo-logo.png',
  '/icons/pwa-192-v1.png',
  '/icons/pwa-512-v1.png',
  '/icons/apple-touch-icon-180-v1.png'
]

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_VERSION)
  // A slow or temporarily unavailable chunk must not prevent the Service
  // Worker from becoming active on iOS. Cache only the small stable shell here;
  // hashed Vite assets are cached on first successful fetch below.
  await Promise.allSettled(SHELL_ASSETS.map(async (asset) => {
    const response = await fetch(asset, { cache: 'no-store' })
    if (response.ok) await cache.put(asset, response)
  }))
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheApplicationShell())
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

function openOfflineSyncDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(OFFLINE_SYNC_DB)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

async function readPendingOfflineMutations(database, userId) {
  if (!database.objectStoreNames.contains(OFFLINE_SYNC_STORE)) return []
  const transaction = database.transaction(OFFLINE_SYNC_STORE, 'readonly')
  const records = await idbRequest(transaction.objectStore(OFFLINE_SYNC_STORE).getAll())
  return records
    .filter((record) => record.userId === userId && ['pending', 'retry'].includes(record.state))
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .slice(0, 100)
}

async function applyOfflineMutationResults(database, results) {
  if (!results.length) return
  const transaction = database.transaction(OFFLINE_SYNC_STORE, 'readwrite')
  const store = transaction.objectStore(OFFLINE_SYNC_STORE)
  for (const result of results) {
    if (result.status >= 200 && result.status < 300) {
      store.delete(result.operationId)
      continue
    }
    const existing = await idbRequest(store.get(result.operationId))
    if (!existing) continue
    store.put({
      ...existing,
      state: result.status === 409 ? 'conflict' : 'failed',
      error: String(result.error || '后台同步失败').slice(0, 500),
      serverPayload: result,
      updatedAt: new Date().toISOString()
    })
  }
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

async function flushOfflineMutationsInWorker() {
  const sessionResponse = await fetch('/api/auth/session', {
    credentials: 'include',
    headers: { Accept: 'application/json' }
  })
  if (!sessionResponse.ok) return
  const session = await sessionResponse.json()
  const userId = String(session.user?.id || '')
  if (!userId) return
  const database = await openOfflineSyncDb()
  try {
    const records = await readPendingOfflineMutations(database, userId)
    if (!records.length) return
    const response = await fetch('/api/collaboration/sync/mutations', {
      method: 'POST',
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        mutations: records.map(({ operationId, kind, payload }) => ({ operationId, kind, payload }))
      })
    })
    if (!response.ok) throw new Error(`Offline sync failed: ${response.status}`)
    const payload = await response.json()
    await applyOfflineMutationResults(database, payload.results || [])
  } finally {
    database.close()
  }
}

self.addEventListener('sync', (event) => {
  if (event.tag === OFFLINE_SYNC_TAG) {
    event.waitUntil(flushOfflineMutationsInWorker())
  }
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
      (async () => {
        try {
          const response = await fetch(request)
          if (response.ok) {
            const copy = response.clone()
            void caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy))
          }
          return response
        } catch {
          return (
            (await caches.match(request))
            || (await caches.match('/'))
            || (await caches.match('/offline.html'))
            || Response.error()
          )
        }
      })()
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
