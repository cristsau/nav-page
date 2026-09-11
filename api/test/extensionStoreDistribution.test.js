import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

const storeUrl = 'https://microsoftedge.microsoft.com/addons/detail/celcpcibfppoeodciojlbgmbkkaaoaep'
const readSource = (path) => fs.readFile(new URL(`../../${path}`, import.meta.url), 'utf8')

test('browser settings link directly to the published Edge listing with safe new-tab behavior', async () => {
  const source = await readSource('app/src/modules/settings/components/BrowserIntegrationSettings.vue')
  assert.ok(source.includes(`const extensionStoreUrl = '${storeUrl}'`))
  assert.match(source, /<a\s+class="btn btn--primary extension-store-link"\s+:href="extensionStoreUrl"\s+target="_blank"\s+rel="noopener noreferrer"\s*>前往微软商店安装<\/a>/)
  assert.match(source, /\.extension-store-link:focus-visible\s*\{/)
  assert.doesNotMatch(source, /extensionDownloadUrl|extensionGuideUrl|\/downloads\/nav-extension|>下载扩展包<|>查看安装说明<|加载已解压的扩展程序/)
  assert.match(source, /请使用 Edge 安装/)
  assert.match(source, /先停用旧版/)
})

for (const location of ['= /downloads/nav-extension.zip', '= /downloads/nav-extension', '^~ /downloads/nav-extension/']) {
  test(`production retires ${location} using a fixed uncacheable store redirect`, async () => {
    const config = await readSource('ovh/nginx.conf')
    const start = config.indexOf(`location ${location} {`)
    assert.notEqual(start, -1, `Missing retired download location: ${location}`)
    const end = config.indexOf('}', start)
    assert.notEqual(end, -1)
    const block = config.slice(start, end + 1)
    assert.ok(block.includes(`return 302 ${storeUrl};`))
    assert.match(block, /add_header Cache-Control "no-store" always;/)
    assert.match(block, /add_header Referrer-Policy "no-referrer" always;/)
    assert.match(block, /add_header X-Content-Type-Options "nosniff" always;/)
    assert.doesNotMatch(block, /try_files|proxy_pass|\$arg|\$request_uri|\$uri/)
  })
}
