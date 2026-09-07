import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

function sourceFile(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
}

test('router uses the shared in-memory auth initializer instead of fetching every route', async () => {
  const [router, authApi] = await Promise.all([
    sourceFile('app/src/router/index.js'),
    sourceFile('app/src/shared/services/authApi.js')
  ])

  assert.match(router, /const \{ initAuth \} = useAuth\(\)/)
  assert.match(router, /const currentUser = await initAuth\(\)/)
  assert.doesNotMatch(router, /fetchBackendSession/)
  assert.match(authApi, /fetchBackendSession[\s\S]*cache: 'no-store'/)
})

test('route progress is delayed and always completed by router outcomes', async () => {
  const [router, progress] = await Promise.all([
    sourceFile('app/src/router/index.js'),
    sourceFile('app/src/shared/services/routeProgress.js')
  ])

  assert.match(progress, /ROUTE_PROGRESS_DELAY_MS = 100/)
  assert.match(router, /router\.beforeEach[\s\S]*startRouteProgress\(\)/)
  assert.match(router, /router\.afterEach[\s\S]*updateDocumentMetadata[\s\S]*finishRouteProgress\(\)/)
  assert.match(router, /router\.onError[\s\S]*finishRouteProgress\(\)/)
})

test('session lifecycle revalidates on visibility and a bounded visible-page timer', async () => {
  const auth = await sourceFile('app/src/shared/composables/useAuth.js')

  assert.match(auth, /createSessionCoordinator/)
  assert.match(auth, /document\.visibilityState === 'visible'/)
  assert.match(auth, /revalidateSessionInBackground/)
  assert.match(auth, /window\.setInterval\([\s\S]*DEFAULT_SESSION_REVALIDATE_INTERVAL_MS/)
  assert.match(auth, /window\.clearInterval\(authRevalidateTimer\)/)
  assert.match(auth, /stopAuthSessionLifecycle/)
  assert.match(auth, /BroadcastChannel/)
  assert.match(auth, /AUTH_SYNC_STORAGE_KEY/)
  assert.match(auth, /type: 'session-invalidated'/)
  assert.doesNotMatch(auth, /localStorage\?\.setItem\([^\n]+currentUser|sessionToken|sessionCookie/i)
})

test('cross-tab session invalidation does not redirect a public share reader', async () => {
  const auth = await sourceFile('app/src/shared/composables/useAuth.js')

  assert.match(auth, /window\.location\.pathname\.startsWith\('\/share\/'\)/)
  assert.ok(
    auth.indexOf("window.location.pathname.startsWith('/share/')")
      < auth.indexOf('window.location.assign(`/auth?')
  )
})

test('startup skeleton stays visible until initial routing is ready', async () => {
  const [html, main] = await Promise.all([
    sourceFile('app/index.html'),
    sourceFile('app/src/main.js')
  ])
  const readyIndex = main.indexOf('await router.isReady()')
  const skeletonIndex = main.indexOf("document.querySelector('[data-startup-skeleton]')")
  const mountIndex = main.indexOf("app.mount('#app')")

  assert.match(html, /data-startup-skeleton/)
  assert.match(html, /prefers-reduced-motion: reduce/)
  assert.ok(readyIndex >= 0)
  assert.ok(skeletonIndex > readyIndex)
  assert.ok(mountIndex > skeletonIndex)
  assert.match(main, /appRoot\?\.removeAttribute\('aria-busy'\)/)
  assert.match(main, /root\.removeAttribute\('aria-busy'\)/)
  assert.match(main, /renderStartupError[\s\S]*stopAuthSessionLifecycle\(\)/)
})
