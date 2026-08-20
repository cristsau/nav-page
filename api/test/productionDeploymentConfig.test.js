import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function readSource(relativeUrl) {
  return (await readFile(new URL(relativeUrl, import.meta.url), 'utf8'))
    .replace(/\r\n?/g, '\n')
}

function envValue(source, name) {
  return source.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]?.trim() || ''
}

test('OVH nginx gives only Vite assets immutable caching', async () => {
  const nginx = await readSource('../../ovh/nginx.conf')
  const assets = nginx.slice(
    nginx.indexOf('location ^~ /assets/'),
    nginx.indexOf('location = /manifest.webmanifest')
  )
  const manifest = nginx.slice(
    nginx.indexOf('location = /manifest.webmanifest'),
    nginx.indexOf('location = /service-worker.js')
  )
  const api = nginx.slice(
    nginx.indexOf('location ^~ /api/'),
    nginx.indexOf('location ^~ /share/')
  )

  assert.match(assets, /try_files \$uri =404;/)
  assert.match(assets, /public, max-age=31536000, immutable/)
  assert.doesNotMatch(manifest, /immutable/)
  assert.match(manifest, /no-cache, must-revalidate/)
  assert.match(nginx, /location = \/index\.html \{[\s\S]*no-cache, must-revalidate/)
  assert.match(api, /proxy_no_cache 1;/)
  assert.match(api, /proxy_cache_bypass 1;/)
  assert.match(api, /private, no-store/)
})

test('OVH nginx remains compatible with the production conf.d mount', async () => {
  const nginx = await readSource('../../ovh/nginx.conf')
  const api = nginx.slice(
    nginx.indexOf('location ^~ /api/'),
    nginx.indexOf('location ^~ /share/')
  )
  const share = nginx.slice(
    nginx.indexOf('location ^~ /share/'),
    nginx.indexOf('location ^~ /assets/')
  )

  assert.doesNotMatch(nginx, /^\s*(?:user|worker_processes|events\s*\{|http\s*\{)/m)
  assert.match(nginx, /map \$http_x_forwarded_for \$nav_forwarded_for/)
  assert.match(nginx, /server\s*\{/)
  assert.match(nginx, /root \/usr\/share\/nginx\/html;/)
  assert.match(nginx, /client_max_body_size 12m;/)
  assert.match(nginx, /location = \/healthz \{[\s\S]*default_type text\/plain;/)
  assert.match(nginx, /add_header X-Content-Type-Options "nosniff" always;/)
  assert.match(nginx, /add_header Referrer-Policy "strict-origin-when-cross-origin" always;/)
  assert.match(api, /proxy_read_timeout 300s;/)
  assert.match(api, /proxy_send_timeout 300s;/)
  assert.match(share, /proxy_read_timeout 60s;/)
  assert.match(share, /proxy_send_timeout 60s;/)
  assert.match(share, /proxy_hide_header Referrer-Policy;/)
  assert.match(share, /add_header Referrer-Policy "no-referrer" always;/)
})

test('nav-web preserves the NPM XFF chain without appending its Docker address', async () => {
  const [nginx, deployment, app] = await Promise.all([
    readSource('../../ovh/nginx.conf'),
    readSource('../../DEPLOYMENT.md'),
    readSource('../src/app.js')
  ])

  assert.match(nginx, /map \$http_x_forwarded_for \$nav_forwarded_for/)
  assert.match(nginx, /"" \$remote_addr;/)
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$nav_forwarded_for;/)
  assert.match(nginx, /proxy_set_header X-Real-IP \$nav_real_ip;/)
  assert.match(nginx, /proxy_set_header X-Forwarded-Proto \$nav_forwarded_proto;/)
  assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for/)
  assert.match(app, /trustProxy: \(address\) => isTrustedProxyAddress\(address\)/)
  assert.doesNotMatch(app, /trustProxy:\s*true/)
  assert.match(deployment, /v\.ps-JP[\s\S]*精确加入/)
  assert.match(deployment, /禁止配置[\s\S]*trustProxy: true/)
})

test('canonical share origin is equal across browser and API configuration', async () => {
  const [appEnv, apiEnv, manager, route] = await Promise.all([
    readSource('../../app/.env.production'),
    readSource('../.env.example'),
    readSource('../../app/src/modules/whisper/components/ShareManager.vue'),
    readSource('../src/routes/publicSharePage.js')
  ])
  const browserOrigin = envValue(appEnv, 'VITE_PUBLIC_APP_ORIGIN')
  const serverOrigin = envValue(apiEnv, 'NAV_PUBLIC_APP_ORIGIN')

  assert.equal(browserOrigin, 'https://nav.skrskr.net')
  assert.equal(serverOrigin, browserOrigin)
  assert.match(manager, /buildPublicShareUrl/)
  assert.doesNotMatch(manager, /window\.location\.origin/)
  assert.match(route, /appOrigin: config\.publicAppOrigin/)
})

test('backend compose mounts the image-library token as a read-only secret', async () => {
  const [compose, envExample] = await Promise.all([
    readSource('../../docker-compose.backend.yml'),
    readSource('../.env.example')
  ])

  assert.match(
    compose,
    /\$\{NAV_SECRETS_DIR:\?set NAV_SECRETS_DIR to the release-local secrets directory\}\/imgbed-library-token:\/run\/secrets\/nav\/imgbed-library-token:ro/
  )
  assert.match(
    compose,
    /\$\{NAV_SECRETS_DIR:\?set NAV_SECRETS_DIR to the release-local secrets directory\}\/cliproxy-api-key:\/run\/secrets\/nav\/cli-proxy-api-key:ro/
  )
  assert.doesNotMatch(compose, /\/opt\/nav\/secrets\//)
  assert.equal(
    envValue(envExample, 'NAV_IMGBED_LIBRARY_TOKEN_FILE'),
    '/run/secrets/nav/imgbed-library-token'
  )
  assert.doesNotMatch(compose, /NAV_IMGBED_(?:UPLOAD|LIBRARY)_TOKEN\s*:/)
})
