import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function source(relativeUrl) {
  return (await readFile(new URL(relativeUrl, import.meta.url), 'utf8'))
    .replace(/\r\n?/g, '\n')
}

test('PostgreSQL uses a required external bind mount instead of a release-scoped named volume', async () => {
  const compose = await source('../../docker-compose.backend.yml')
  const postgres = compose.slice(
    compose.indexOf('  nav-postgres:'),
    compose.indexOf('\n  nav-api:')
  )

  assert.match(postgres, /type: bind/)
  assert.match(
    postgres,
    /source: "\$\{NAV_POSTGRES_DATA_DIR:\?set NAV_POSTGRES_DATA_DIR to an absolute persistent directory outside the release tree\}"/
  )
  assert.match(postgres, /target: \/var\/lib\/postgresql\/data/)
  assert.match(postgres, /create_host_path: false/)
  assert.doesNotMatch(compose, /nav-postgres-data:/)
})

test('supported deployment refuses a relative, release-local, or mismatched live PostgreSQL source', async () => {
  const deploy = await source('../../scripts/deploy-backend.sh')

  assert.match(deploy, /NAV_POSTGRES_DATA_DIR:-\/var\/lib\/domo-nav\/postgres/)
  assert.match(deploy, /NAV_POSTGRES_DATA_DIR must be a bounded absolute path/)
  assert.match(deploy, /\/opt\/nav-stack\/releases/)
  assert.match(deploy, /docker inspect --format[^\n]+Destination "\/var\/lib\/postgresql\/data"/)
  assert.match(deploy, /migrate or restore it to/)
  assert.match(deploy, /export NAV_POSTGRES_DATA_DIR=/)
  assert.match(deploy, /docker compose[^\n]+config --quiet/)
})

test('disaster restore passes and validates the same external PostgreSQL directory', async () => {
  const [restore, example] = await Promise.all([
    source('../../scripts/nav-disaster-restore.sh'),
    source('../../scripts/nav-backup.env.example')
  ])

  assert.match(example, /^NAV_POSTGRES_DATA_DIR=\/var\/lib\/domo-nav\/postgres$/m)
  assert.match(restore, /NAV_POSTGRES_DATA_DIR must remain outside the release tree/)
  assert.match(restore, /existing \$NAV_DB_CONTAINER uses a different PostgreSQL data directory/)
  assert.match(restore, /NAV_POSTGRES_DATA_DIR="\$NAV_POSTGRES_DATA_DIR"[\s\S]{0,100}docker compose/)
})
