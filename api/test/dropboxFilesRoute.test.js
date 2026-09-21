import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import routes from '../src/routes/dropboxFiles.js'
import { DropboxFilesError, UPLOAD_LIMIT } from '../src/lib/dropboxFiles.js'
import { LARGE_UPLOAD_LIMIT, CHUNK_LIMIT, dropboxContentHash } from '../src/lib/dropboxFileUploads.js'

const owner = '00000000-0000-4000-8000-000000000001'
const headers = { 'x-test-role': 'admin', 'x-test-owner': owner }
async function harness({ connection = { ownerUserId: owner }, service = {}, load } = {}) {
  const app = Fastify({ logger: false }), calls = []
  app.decorate('requireAdmin', async (request, reply) => {
    const role = request.headers['x-test-role']
    if (role !== 'admin') { reply.code(role ? 403 : 401); throw Error('Denied') }
    request.currentUser = { id: request.headers['x-test-owner'], role }
  })
  app.register(routes, { prefix: '/api', loadConnection: load || (() => connection), createService: () => ({
    list: async input => { calls.push(input); return { entries: [], cursor: 'SENSITIVE_PROVIDER_CURSOR', hasMore: true } },
    ...service
  }) })
  await app.ready()
  return { app, calls, request: (path, body, options = {}) => app.inject({ url: '/api/dropbox-files/' + path, method: body === undefined ? 'GET' : 'POST', headers, payload: body, ...options }) }
}
test('all file routes require admin and exact bound owner, before any provider access', async () => {
  let loads = 0
  const { app, request } = await harness({ load: () => { loads++; return { ownerUserId: owner } } })
  try {
    const paths = ['status', 'list', 'folder', 'history', 'history/copy', 'move', 'copy', 'delete/preview', 'delete', 'text/read', 'text/save', 'upload', 'content/id%3Atest', 'content/id%3Atest?rev=abcdef123', 'upload/start', 'upload/status', 'upload/chunk', 'upload/finish', 'upload/cancel', 'upload/list', 'upload/reattach', 'deleted/list', 'deleted/history', 'deleted/copy', 'deleted/content/test']
    for (const path of paths) {
      const body = path === 'status' || path.startsWith('content/') || path.startsWith('deleted/content/') ? undefined : {}
      for (const [h, expected] of [[{}, 401], [{ 'x-test-role': 'user' }, 403], [{ ...headers, 'x-test-owner': 'different' }, 403]]) {
        const r = await request(path, body, { headers: h }); assert.equal(r.statusCode, expected, path)
        assert.match(r.headers['cache-control'], /no-store/)
      }
    }
    assert.equal(loads, paths.length)
  } finally { await app.close() }
})
test('status contains capabilities only; missing connection is not reported connected', async () => {
  for (const connection of [null, { ownerUserId: owner, refreshToken: 'DO_NOT_EXPOSE', accountEmail: 'DO_NOT_EXPOSE' }]) {
    const { app, request } = await harness({ connection })
    try {
      const r = await request('status'); assert.equal(r.statusCode, connection ? 200 : 503)
      assert.equal(r.body.includes('DO_NOT_EXPOSE'), false)
      if (connection) assert.equal(r.json().uploadLimit, LARGE_UPLOAD_LIMIT)
    } finally { await app.close() }
  }
})
test('pagination exposes opaque cursor bound to path/query and invalidated on connection change', async () => {
  let connection = { ownerUserId: owner }
  const { app, request, calls } = await harness({ load: () => connection })
  try {
    const r = await request('list', { path: '/Notes', query: 'readme' })
    assert.equal(r.statusCode, 200); const cursor = r.json().cursor
    assert.match(cursor, /^[a-f0-9]{48}$/); assert.ok(!r.body.includes('SENSITIVE_PROVIDER_CURSOR'))
    assert.equal((await request('list', { path: '/Notes', query: 'readme', cursor })).statusCode, 200)
    assert.equal(calls.at(-1).cursor, 'SENSITIVE_PROVIDER_CURSOR')
    assert.equal((await request('list', { path: '/Different', query: 'readme', cursor })).statusCode, 409)
    assert.equal((await request('list', { path: '/Notes', query: 'other', cursor })).statusCode, 409)
    connection = { ...connection, revision: 2 }
    assert.equal((await request('list', { path: '/Notes', query: 'readme', cursor })).statusCode, 409)
  } finally { await app.close() }
})
test('provider failures and file contents are not reflected; conflict stays 409', async () => {
  for (const [error, status] of [[new Error('SECRET_IN_PROVIDER_ERROR'), 502], [new DropboxFilesError('FILE_CHANGED', 409), 409]]) {
    const { app, request } = await harness({ service: { save: async () => { throw error } } })
    try {
      const r = await request('text/save', { content: 'SECRET_TEXT' }); assert.equal(r.statusCode, status)
      assert.ok(!r.body.includes('SECRET'))
    } finally { await app.close() }
  }
})
test('uploads require binary content and reject excessive bytes before service invocation', async () => {
  let uploads = 0
  const { app, request } = await harness({ service: { upload: async (path, bytes) => { uploads++; assert.equal(path, '/中文.txt'); assert.ok(Buffer.isBuffer(bytes)); return {} } } })
  try {
    assert.equal((await request('upload', {})).statusCode, 400)
    const h = { ...headers, 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent('/中文.txt') }
    assert.equal((await request('upload', Buffer.from('hello'), { headers: h })).statusCode, 200)
    assert.equal((await request('upload', Buffer.alloc(UPLOAD_LIMIT + 1), { headers: h })).statusCode, 413)
    assert.equal(uploads, 1)
  } finally { await app.close() }
})
test('content streams ranges without public links and forces active formats to download', async () => {
  for (const [kind, name, type] of [['video', 'film.mp4', 'video/mp4'], ['file', 'unsafe.html', 'application/octet-stream']]) {
    const { app, request } = await harness({ service: {
      get: async () => ({ id: 'id:test', name, kind, type: 'file', downloadable: true }),
      client: { download: async (_m, options) => { assert.equal(options.range, 'bytes=0-2'); return new Response('abc', { status: 206, headers: { 'content-range': 'bytes 0-2/5', 'content-length': '3' } }) } }
    } })
    try {
      const r = await request('content/id%3Atest?inline=1', undefined, { headers: { ...headers, range: 'bytes=0-2' } })
      assert.equal(r.statusCode, 206); assert.equal(r.body, 'abc'); assert.equal(r.headers['content-type'], type)
      assert.match(r.headers['content-disposition'], kind === 'file' ? /^attachment;/ : /^inline;/)
      assert.equal(r.headers['content-range'], 'bytes 0-2/5'); assert.equal(r.headers['x-content-type-options'], 'nosniff'); assert.match(r.headers['content-security-policy'], /sandbox/)
    } finally { await app.close() }
  }
})
test('parallel request limit is reserved after asynchronous config loading', async () => {
  let resolve, entered = 0
  const wait = new Promise(r => { resolve = r })
  const { app, request } = await harness({ load: async () => { await Promise.resolve(); return { ownerUserId: owner } }, service: { list: async () => { entered++; await wait; return { entries: [], cursor: null, hasMore: false } } } })
  try {
    const requests = Array.from({ length: 8 }, () => request('list', {}).then(r => r.statusCode))
    await new Promise(r => setTimeout(r, 30)); assert.equal(entered, 4); resolve()
    const statuses = await Promise.all(requests)
    assert.equal(statuses.filter(s => s === 200).length, 4); assert.equal(statuses.filter(s => s === 429).length, 4)
    assert.equal((await request('status')).statusCode, 200)
  } finally { resolve(); await app.close() }
})
test('two concurrent media streams maximum including pending metadata lookup', async () => {
  let release, entered = 0
  const wait = new Promise(r => { release = r })
  const { app, request } = await harness({ service: { get: async () => { entered++; await wait; throw new DropboxFilesError('FILE_UNAVAILABLE', 415) } } })
  try {
    const requests = Array.from({ length: 3 }, () => request('content/id%3Atest').then(r => r.statusCode))
    await new Promise(r => setTimeout(r, 30)); assert.equal(entered, 2); release()
    assert.deepEqual((await Promise.all(requests)).sort(), [415, 415, 429])
    assert.equal((await request('content/id%3Atest')).statusCode, 415)
  } finally { release(); await app.close() }
})
test('large request buffers are limited before parsing and slots released after completion', async () => {
  let release, entered = 0
  const wait = new Promise(r => { release = r })
  const { app, request } = await harness({ service: { save: async () => { entered++; await wait; return {} } } })
  try {
    const pending = Array.from({ length: 3 }, () => request('text/save', { content: 'synthetic' }).then(r => r.statusCode))
    await new Promise(r => setTimeout(r, 30)); assert.equal(entered, 2); release()
    assert.deepEqual((await Promise.all(pending)).sort(), [200, 200, 429])
    assert.equal((await request('text/save', { content: 'synthetic' })).statusCode, 200)
  } finally { release(); await app.close() }
})
test('chunk route is bounded, returns only opaque handles and invalidates sessions on credential rotation', async () => {
  let connection = { ownerUserId: owner }, appended = 0, lastData
  const { app, request } = await harness({ load: () => connection, service: {
    protection: async () => ['/Backup'],
    client: {
      getMetadataIfExists: async () => null,
      uploadSession: async (op, arg, data) => {
        if (op === 'start') return { session_id: 'PRIVATE_SESSION' }
        if (op === 'append_v2') { appended++; lastData = data; return null }
        return { id: 'id:new', name: 'small.txt', path_display: '/small.txt', rev: 'abcdef123', size: 5, server_modified: '2026-09-19T00:00:00Z', content_hash: dropboxContentHash(lastData) }
      }
    }
  } })
  try {
    const start = await request('upload/start', { path: '/small.txt', size: 5 })
    assert.equal(start.statusCode, 200); assert.ok(!start.body.includes('PRIVATE_SESSION'))
    const uploadId = start.json().uploadId, binary = { ...headers, 'content-type': 'application/octet-stream', 'x-upload-id': uploadId, 'x-upload-offset': '0' }
    assert.equal((await request('upload/chunk', Buffer.alloc(CHUNK_LIMIT + 1), { headers: binary })).statusCode, 413); assert.equal(appended, 0)
    assert.equal((await request('upload/chunk', Buffer.from('hello'), { headers: binary })).statusCode, 200)
    const done = await request('upload/finish', { uploadId }); assert.equal(done.json().state, 'complete'); assert.equal(appended, 1)
    assert.equal((await request('upload/status', { uploadId }, { headers: { ...headers, 'x-test-owner': 'different' } })).statusCode, 403)
    connection = { ...connection, revision: 2 }
    assert.equal((await request('upload/status', { uploadId })).json().code, 'UPLOAD_EXPIRED')
  } finally { await app.close() }
})
test('simple delete forwards a preview token rather than requiring filename entry', async () => {
  const { app, request } = await harness({ service: {
    prepareDelete: async id => ({ token: 'OPAQUE_PREVIEW', item: { id }, descendants: 2 }),
    deleteConfirmed: async (id, token) => { assert.equal(id, 'id:folder'); assert.equal(token, 'OPAQUE_PREVIEW'); return { deleted: true } },
    remove: async () => { throw Error('Legacy delete should not run') }
  } })
  try {
    const preview = await request('delete/preview', { id: 'id:folder' }); assert.equal(preview.statusCode, 200)
    assert.equal((await request('delete', { id: 'id:folder', token: preview.json().token })).json().deleted, true)
  } finally { await app.close() }
})

function deletedService() {
  const state = { id: 'id:gone', protected: false, downloads: 0, calls: [] }
  return { state, service: {
    protection: async () => state.protected ? ['/gone.txt'] : ['/Backup'],
    client: {
      async rpc(route, arg) {
        state.calls.push({ route, arg })
        if (route === 'files/list_folder' || route === 'files/list_folder/continue') return { entries: [{ '.tag': 'deleted', path_display: '/gone.txt', name: 'gone.txt' }], has_more: true, cursor: 'PRIVATE_DELETED_CURSOR' }
        if (route === 'files/get_metadata') return { '.tag': 'deleted', path_display: arg.path, name: arg.path.split('/').pop() }
        if (route === 'files/list_revisions') return { is_deleted: true, entries: [{ id: state.id, name: 'gone.txt', path_display: '/gone.txt', size: 5, rev: 'abcdef123', server_modified: '2026-09-19T00:00:00Z' }] }
        throw Error('Unexpected provider operation')
      },
      async download(item, options) {
        state.downloads++; assert.equal(item.id, state.id); assert.equal(item.rev, 'abcdef123'); assert.equal(options.range, 'bytes=0-2')
        return new Response('abc', { status: 206, headers: { 'content-length': '3', 'content-range': 'bytes 0-2/5' } })
      }
    }
  } }
}

test('deleted cursors are opaque and isolated by purpose, directory and connection', async () => {
  let connection = { ownerUserId: owner }
  const { service, state } = deletedService(), { app, request } = await harness({ service, load: () => connection })
  try {
    const first = await request('deleted/list', { path: '' }); assert.equal(first.statusCode, 200)
    const cursor = first.json().cursor; assert.match(cursor, /^[a-f0-9]{48}$/); assert.ok(!first.body.includes('PRIVATE_DELETED_CURSOR'))
    assert.equal((await request('deleted/list', { path: '', cursor })).statusCode, 200)
    assert.deepEqual(state.calls.at(-1), { route: 'files/list_folder/continue', arg: { cursor: 'PRIVATE_DELETED_CURSOR' } })
    assert.equal((await request('deleted/list', { path: '/Other', cursor })).statusCode, 409)
    assert.equal((await request('list', { path: '', cursor })).statusCode, 409)
    const list = await request('list', { path: '' })
    assert.equal((await request('deleted/list', { path: '', cursor: list.json().cursor })).statusCode, 409)
    assert.equal((await request('deleted/content/' + cursor)).statusCode, 409)
    connection = { ...connection, revision: 2 }
    assert.equal((await request('deleted/list', { path: '', cursor })).statusCode, 409)
    assert.equal(state.downloads, 0)
  } finally { await app.close() }
})

test('deleted download tokens require same owner, lineage, protection and connection and remain attachment-only', async () => {
  let connection = { ownerUserId: owner }
  const { service, state } = deletedService(), { app, request } = await harness({ service, load: () => connection })
  try {
    const history = await request('deleted/history', { path: '/gone.txt' }); assert.equal(history.statusCode, 200)
    const token = history.json().entries[0].downloadToken; assert.match(token, /^[a-f0-9]{48}$/)
    const path = 'deleted/content/' + token + '?inline=1'
    assert.equal((await request(path, undefined, { headers: { ...headers, 'x-test-owner': 'other' } })).statusCode, 403)
    const download = await request(path, undefined, { headers: { ...headers, range: 'bytes=0-2' } })
    assert.equal(download.statusCode, 206); assert.equal(download.body, 'abc'); assert.equal(state.downloads, 1)
    assert.match(download.headers['cache-control'], /private, no-store/); assert.match(download.headers['content-disposition'], /^attachment;/)
    assert.equal(download.headers['content-type'], 'application/octet-stream'); assert.equal(download.headers['x-content-type-options'], 'nosniff')
    assert.match(download.headers['content-security-policy'], /sandbox/)
    assert.equal((await request('deleted/list', { cursor: token })).statusCode, 409)
    state.id = 'id:replacement'
    assert.equal((await request(path)).json().code, 'DELETED_FILE_CHANGED')
    state.id = 'id:gone'; state.protected = true
    assert.equal((await request(path)).json().code, 'BACKUP_PROTECTED')
    state.protected = false; connection = { ...connection, revision: 2 }
    assert.equal((await request(path)).json().code, 'CURSOR_EXPIRED'); assert.equal(state.downloads, 1)
  } finally { await app.close() }
})

test('refresh upload route binds full identity and clears handles on credential rotation', async () => {
  let connection = { ownerUserId: owner }
  const { app, request } = await harness({ load: () => connection, service: {
    protection: async () => ['/Backup'], client: { getMetadataIfExists: async () => null, uploadSession: async () => ({ session_id: 'PRIVATE_PROVIDER_SESSION' }) }
  } })
  try {
    const contentHash = dropboxContentHash(Buffer.from('hello'))
    assert.equal((await request('upload/start', { path: '/small.txt', size: 5, contentHash: 'bad' })).statusCode, 400)
    const start = await request('upload/start', { path: '/small.txt', size: 5, contentHash }); assert.equal(start.statusCode, 200)
    const uploadId = start.json().uploadId, list = await request('upload/list', {})
    assert.equal(list.json().entries.length, 1); assert.equal(list.json().entries[0].contentHash, contentHash); assert.ok(!list.body.includes('PRIVATE_PROVIDER_SESSION'))
    assert.equal((await request('upload/reattach', { uploadId, size: 5, contentHash: '0'.repeat(64) })).json().code, 'UPLOAD_FILE_MISMATCH')
    assert.equal((await request('upload/reattach', { uploadId, size: 5, contentHash })).json().offset, 0)
    connection = { ...connection, revision: 2 }
    assert.equal((await request('upload/list', {})).json().entries.length, 0)
    assert.equal((await request('upload/reattach', { uploadId, size: 5, contentHash })).json().code, 'UPLOAD_EXPIRED')
  } finally { await app.close() }
})
