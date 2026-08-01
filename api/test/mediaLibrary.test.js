import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../src/config.js'
import { listImgBedUserImages } from '../src/lib/imgBedLibraryClient.js'
import {
  assertMediaBelongsToUser,
  attemptMediaAssetDeletion,
  createMediaUserPrefix,
  mediaUrlFromUpstreamId,
  upstreamIdFromMediaUrl
} from '../src/lib/mediaAssets.js'

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ASSET_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function makeAsset(userId = USER_ID, state = 'delete_pending') {
  const upstreamId = `${createMediaUserPrefix(userId)}2026-08/example.webp`
  return {
    id: ASSET_ID,
    user_id: userId,
    upstream_id: upstreamId,
    url: mediaUrlFromUpstreamId(upstreamId, 'https://pic.skrskr.net'),
    name: 'example.webp',
    mime: 'image/webp',
    size: 2048,
    source: 'note',
    retention: 'auto',
    state,
    delete_attempts: 0,
    last_delete_error: '',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z'
  }
}

function createDeletionClient({
  asset = makeAsset(),
  referenceCount = 0
} = {}) {
  let current = asset ? { ...asset } : null
  const queries = []
  return {
    queries,
    get asset() {
      return current
    },
    async query(sql, params) {
      queries.push({ sql, params })
      if (/SELECT \*\s+FROM media_assets/.test(sql)) {
        return { rows: current ? [{ ...current }] : [] }
      }
      if (/SELECT COUNT\(\*\)::integer AS count/.test(sql)) {
        return { rows: [{ count: referenceCount }] }
      }
      if (/SET state = 'active'/.test(sql)) {
        current = { ...current, state: 'active', last_delete_error: '' }
        return { rows: [] }
      }
      if (/SET state = 'delete_pending'/.test(sql)) {
        current = {
          ...current,
          state: 'delete_pending',
          delete_attempts: current.delete_attempts + 1
        }
        return { rows: [] }
      }
      if (/SET state = 'deleted'/.test(sql)) {
        current = { ...current, state: 'deleted', last_delete_error: '' }
        return { rows: [{ ...current }] }
      }
      if (/SET state = 'delete_failed'/.test(sql)) {
        current = { ...current, state: 'delete_failed', last_delete_error: params[1] }
        return { rows: [{ ...current }] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    }
  }
}

function transactionWith(client) {
  return async (callback) => callback(client)
}

test('media paths are deterministically scoped to one user partition', () => {
  const prefix = createMediaUserPrefix(USER_ID)
  const upstreamId = `${prefix}2026-08/example.webp`
  const url = mediaUrlFromUpstreamId(upstreamId, 'https://pic.skrskr.net')

  assert.equal(upstreamIdFromMediaUrl(url, 'https://pic.skrskr.net'), upstreamId)
  assert.equal(assertMediaBelongsToUser(USER_ID, { upstreamId }), upstreamId)
  assert.throws(
    () => assertMediaBelongsToUser(OTHER_USER_ID, { upstreamId }),
    (error) => error.statusCode === 404 && error.code === 'media_not_found'
  )
})

test('cross-user deletion returns 404 before any upstream request', async () => {
  const client = createDeletionClient({ asset: null })
  let upstreamCalls = 0

  await assert.rejects(
    attemptMediaAssetDeletion(
      OTHER_USER_ID,
      ASSET_ID,
      async () => { upstreamCalls += 1 },
      transactionWith(client)
    ),
    (error) => error.statusCode === 404
  )
  assert.equal(upstreamCalls, 0)
})

test('referenced media cannot be physically deleted', async () => {
  const client = createDeletionClient({ referenceCount: 2 })
  let upstreamCalls = 0
  const outcome = await attemptMediaAssetDeletion(
    USER_ID,
    ASSET_ID,
    async () => { upstreamCalls += 1 },
    transactionWith(client)
  )

  assert.equal(outcome.state, 'referenced')
  assert.equal(outcome.referenceCount, 2)
  assert.equal(client.asset.state, 'active')
  assert.equal(upstreamCalls, 0)
})

test('failed physical deletion is visible and a later explicit retry succeeds', async () => {
  const client = createDeletionClient()
  const failed = await attemptMediaAssetDeletion(
    USER_ID,
    ASSET_ID,
    async () => {
      const error = new Error('sensitive upstream detail must not be stored')
      error.code = 'library_http_503'
      throw error
    },
    transactionWith(client)
  )

  assert.equal(failed.state, 'delete_failed')
  assert.equal(client.asset.state, 'delete_failed')
  assert.equal(client.asset.last_delete_error, 'library_http_503')
  assert.doesNotMatch(client.asset.last_delete_error, /sensitive/i)

  const retried = await attemptMediaAssetDeletion(
    USER_ID,
    ASSET_ID,
    async () => {},
    transactionWith(client)
  )
  assert.equal(retried.state, 'deleted')
  assert.equal(client.asset.state, 'deleted')
  assert.equal(client.asset.delete_attempts, 2)
})

test('serialized concurrent deletes make only one upstream deletion request', async () => {
  const client = createDeletionClient()
  let tail = Promise.resolve()
  const serializedTransaction = async (callback) => {
    const previous = tail
    let release
    tail = new Promise((resolve) => { release = resolve })
    await previous
    try {
      return await callback(client)
    } finally {
      release()
    }
  }
  let upstreamCalls = 0
  const deleteUpstream = async () => {
    upstreamCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  const [first, second] = await Promise.all([
    attemptMediaAssetDeletion(USER_ID, ASSET_ID, deleteUpstream, serializedTransaction),
    attemptMediaAssetDeletion(USER_ID, ASSET_ID, deleteUpstream, serializedTransaction)
  ])

  assert.equal(first.state, 'deleted')
  assert.equal(second.state, 'deleted')
  assert.equal(upstreamCalls, 1)
})

test('automatic cleanup rechecks retention and pending state under the deletion lock', async () => {
  const client = createDeletionClient({
    asset: {
      ...makeAsset(USER_ID, 'orphan'),
      retention: 'keep'
    }
  })
  let upstreamCalls = 0
  const outcome = await attemptMediaAssetDeletion(
    USER_ID,
    ASSET_ID,
    async () => { upstreamCalls += 1 },
    transactionWith(client),
    { requireAuto: true, requirePending: true }
  )

  assert.equal(outcome.state, 'not_pending')
  assert.equal(upstreamCalls, 0)
  assert.equal(client.asset.state, 'orphan')
})

test('media migration, route contract, note lifecycle and secret-file boundary are present', async () => {
  const [migration, route, notes, noteImages, config, client] = await Promise.all([
    fs.readFile(new URL('../src/db/migrations/014_media_library.sql', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/routes/media.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/routes/notes.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/routes/noteImages.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/config.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../src/lib/imgBedLibraryClient.js', import.meta.url), 'utf8')
  ])

  assert.match(migration, /CREATE TABLE IF NOT EXISTS media_assets/)
  assert.match(migration, /upstream_id TEXT NOT NULL UNIQUE/)
  assert.match(migration, /url TEXT NOT NULL UNIQUE/)
  assert.match(migration, /missing_observations INTEGER NOT NULL DEFAULT 0/)
  assert.match(migration, /'delete_pending'[\s\S]*'delete_failed'[\s\S]*'missing'[\s\S]*'deleted'/)
  assert.match(route, /fastify\.get\('\/media\/images'/)
  assert.match(route, /fastify\.patch\('\/media\/images\/:assetId\/retention'/)
  assert.match(route, /fastify\.delete\('\/media\/images\/:assetId'/)
  assert.match(route, /fastify\.post\('\/media\/images\/:assetId\/retry-delete'/)
  assert.match(notes, /syncNoteMediaReferences/)
  assert.match(notes, /cleanupMediaAfterNoteMutation/)
  assert.match(noteImages, /registerMediaAsset/)
  assert.match(config, /NAV_IMGBED_LIBRARY_TOKEN_FILE/)
  assert.match(client, /readOwnerOnlySecretFile/)
  assert.match(client, /readSecretImpl\(tokenFile\)/)
  assert.doesNotMatch(route, /NAV_IMGBED_LIBRARY_TOKEN/)
  assert.match(route, /missing_observations \+ 1 >= 2/)
  assert.match(route, /!upstreamResult\.complete/)
  assert.match(route, /requireAuto: true, requirePending: true/)
  assert.match(route, /upstreamResult\.complete/)
  assert.match(notes, /syncNoteMediaReferences/)
  assert.match(route, /WHEN state IN \('delete_pending', 'delete_failed'\) THEN state/)
})

test('a capped image-bed listing is explicitly incomplete and cannot drive missing detection', async () => {
  const previousBaseUrl = config.imgBedBaseUrl
  const previousTokenFile = config.imgBedLibraryTokenFile
  config.imgBedBaseUrl = 'https://pic.example.test'
  config.imgBedLibraryTokenFile = path.resolve('test-secrets/imgbed-library-token')
  let calls = 0
  try {
    const result = await listImgBedUserImages(USER_ID, {
      readSecretImpl: async () => 'test-token',
      fetchImpl: async (input) => {
        calls += 1
        const url = new URL(input)
        const start = Number(url.searchParams.get('start') || 0)
        const count = Number(url.searchParams.get('count') || 100)
        const files = Array.from({ length: Math.min(count, 5101 - start) }, (_, offset) => ({
          name: `${createMediaUserPrefix(USER_ID)}2026-08/image-${start + offset}.webp`,
          metadata: {
            contentType: 'image/webp',
            size: 1024,
            uploadedAt: '2026-08-01T00:00:00.000Z'
          }
        }))
        return new Response(JSON.stringify({ files, totalCount: 5101 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
    })
    assert.equal(result.files.length, 5000)
    assert.equal(result.complete, false)
    assert.equal(calls, 50)
  } finally {
    config.imgBedBaseUrl = previousBaseUrl
    config.imgBedLibraryTokenFile = previousTokenFile
  }
})
