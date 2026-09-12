import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

export function createVersionPlugin({ command, now = new Date(), nonce = randomUUID() } = {}) {
  const release = JSON.parse(readFileSync(new URL('../release-notes.json', import.meta.url), 'utf8'))
  const metadata = {
    schemaVersion: 1,
    version: release.version,
    buildId: command === 'build' ? `${now.toISOString().replace(/\D/g, '')}-${nonce.slice(0, 8)}` : 'development',
    builtAt: now.toISOString(),
    notes: release.notes
  }
  return {
    name: 'nav-public-build-version',
    config: () => ({ define: { __NAV_BUILD_INFO__: JSON.stringify(metadata) } }),
    generateBundle() {
      // Public release metadata only: never serialize process.env or user data.
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify(metadata) })
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify(metadata))
      })
    }
  }
}
