// Opt-in: actual operator account, synthetic credentials only, no OAuth/network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, unlinkSync, rmdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { storeFilesConnection } from './connect-files.mjs'
import { SCOPES } from './oauth.mjs'

test('actual Node -> PowerShell -> DPAPI store roundtrip and no overwrite under inherited bad module path',
  { skip: process.platform !== 'win32' || process.env.NAV_SYNTHETIC_LOCAL_STORE_TEST !== '1' }, () => {
    const id = 'NavFilesFixture' + randomUUID().replaceAll('-', '')
    const base = resolve(process.env.LOCALAPPDATA, 'DomoCodex', 'NavDropboxOAuth')
    const directory = join(base, id), file = join(directory, 'connection.dpapi')
    assert.equal(existsSync(directory), false)
    const deps = { environment: { ...process.env, PSModulePath: 'Z:\\Synthetic-Incompatible-Modules' } }
    try {
      storeFilesConnection(id, 'Check', undefined, deps)
      storeFilesConnection(id, 'Check', undefined, deps)
      storeFilesConnection(id, 'Store', {
        schema_version: 1, provider: 'dropbox', client_id: id, account_id: 'dbid:SYNTHETIC',
        refresh_token: 'SYNTHETIC_REFRESH_ONLY', scopes: SCOPES, authorized_at: '2026-09-19T00:00:00Z'
      }, deps)
      const before = readFileSync(file)
      assert.equal(before.includes(Buffer.from('SYNTHETIC_REFRESH_ONLY')), false)
      assert.throws(() => storeFilesConnection(id, 'Check', undefined, deps), /connection_already_exists_no_overwrite/)
      assert.deepEqual(readFileSync(file), before)
      // Store itself decrypts and compares the bytes before committing ciphertext.
    } finally {
      assert.match(id, /^NavFilesFixture[a-f0-9]{32}$/)
      assert.equal(resolve(directory), join(base, id))
      assert.equal(resolve(file), join(directory, 'connection.dpapi'))
      if (existsSync(directory)) {
        assert.equal(lstatSync(directory).isSymbolicLink(), false)
        if (existsSync(file)) {
          assert.equal(lstatSync(file).isSymbolicLink(), false)
          assert.equal(lstatSync(file).isFile(), true)
          unlinkSync(file)
        }
        assert.deepEqual(readdirSync(directory), [])
        rmdirSync(directory) // Exact synthetic directory only; never recursive.
      }
    }
  })
