import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { verifyPinnedEmbeddingLock } from '../../api/scripts/verifyEmbeddingIsolation.js'

export function validateApiAudit(report, lock, { dockerfile, workflow } = {}) {
  assert.equal(report?.auditReportVersion, 2, 'Missing/unsupported npm audit report')
  assert.ok(!report.error && report.vulnerabilities && report.metadata?.vulnerabilities, 'Incomplete/error audit report')
  const entries = Object.entries(report.vulnerabilities)
  assert.equal(report.metadata.vulnerabilities.total, entries.length, 'Inconsistent audit totals')
  // The patched release retires the September 10 exception, without extending it.
  assert.equal(entries.length, 0, 'API audit contains vulnerabilities; exceptions are retired')
  verifyPinnedEmbeddingLock(lock)
  // Static guards complement, never replace, the real Linux image verification.
  assert.ok(dockerfile?.includes('RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev'), 'GPU install skip guard missing')
  assert.ok(dockerfile?.includes('ONNXRUNTIME_NODE_INSTALL=skip NAV_BUILD_ISOLATION=1 node scripts/verifyEmbeddingIsolation.js --strip-install-tools'), 'Same-layer removal/verification missing')
  assert.ok(workflow?.includes('ONNXRUNTIME_NODE_INSTALL: skip'), 'Runner install isolation missing')
  assert.ok(workflow?.includes('docker run --rm --network none --read-only --tmpfs /tmp\n          nav-api:ci node scripts/verifyEmbeddingIsolation.js'), 'Offline Linux isolation gate missing')
  return { status: 'PASS', exception: false }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const audit = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'npm',
      process.platform === 'win32'
        ? ['/d', '/s', '/c', 'npm audit --prefix api --json --audit-level=moderate']
        : ['audit', '--prefix', 'api', '--json', '--audit-level=moderate'],
      { encoding: 'utf8', timeout: 120000 })
    assert.ok(!audit.error && [0, 1].includes(audit.status) && audit.stdout, 'npm audit failed to produce a valid result')
    const report = JSON.parse(audit.stdout)
    const lock = JSON.parse(readFileSync(new URL('../../api/package-lock.json', import.meta.url)))
    const dockerfile = readFileSync(new URL('../../api/Dockerfile', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    console.log(JSON.stringify(validateApiAudit(report, lock, { dockerfile, workflow })))
  } catch (error) {
    console.error(`API audit rejected: ${error.message}`)
    process.exitCode = 1
  }
}
