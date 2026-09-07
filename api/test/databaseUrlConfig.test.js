import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolveDatabaseUrl } from '../src/config.js'

test('production database configuration fails closed without DATABASE_URL', () => {
  assert.throws(
    () => resolveDatabaseUrl('', 'production'),
    (error) => error?.code === 'DATABASE_URL_REQUIRED'
  )
  assert.equal(
    resolveDatabaseUrl('postgres://nav:example@db:5432/nav', 'production'),
    'postgres://nav:example@db:5432/nav'
  )
})

test('development fallback does not embed a shared password', () => {
  assert.equal(resolveDatabaseUrl('', 'development'), 'postgres://nav@127.0.0.1:5432/nav')
})

test('production compose requires an injected PostgreSQL password', async () => {
  const [compose, envExample] = await Promise.all([
    readFile(new URL('../../docker-compose.backend.yml', import.meta.url), 'utf8'),
    readFile(new URL('../.env.example', import.meta.url), 'utf8')
  ])
  assert.match(compose, /NAV_POSTGRES_PASSWORD:\?set NAV_POSTGRES_PASSWORD to a unique secret/)
  assert.doesNotMatch(compose, /POSTGRES_PASSWORD:\s*nav_password/)
  assert.doesNotMatch(envExample, /postgres:\/\/nav:nav_password/)
})
