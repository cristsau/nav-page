import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateApiAudit } from '../../.github/scripts/verify-api-audit-policy.mjs'
import { embeddingRuntime } from '../scripts/embeddingIsolationContract.js'
import { identityModel, stripInstallTools, verifyPinnedEmbeddingLock } from '../scripts/verifyEmbeddingIsolation.js'

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)))
const controls = {
  dockerfile: readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
  workflow: readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
}
const cleanReport = () => ({ auditReportVersion: 2, metadata: { vulnerabilities: { total: 0 } }, vulnerabilities: {} })
test('clean audit passes without a time-limited exception', () => {
  for (const now of [0, Date.parse('2026-09-17T02:45:00Z'), Date.parse('2027-01-01T00:00:00Z')]) {
    assert.deepEqual(validateApiAudit(cleanReport(), lock, { ...controls, now }), { status: 'PASS', exception: false })
  }
  assert.equal(embeddingRuntime.versions['adm-zip'], '0.6.1')
  assert.equal(Object.hasOwn(embeddingRuntime, 'expiresAt'), false)
})
for (const advisory of ['GHSA-vwc7-r8mq-g2x9', 'GHSA-f88m-g3jw-g9cj', 'GHSA-xxxx-yyyy-zzzz']) {
  test('no exception remains for ' + advisory, () => {
    const report = cleanReport()
    report.metadata.vulnerabilities.total = 1
    report.vulnerabilities['adm-zip'] = { name: 'adm-zip', severity: 'moderate', nodes: ['node_modules/adm-zip'], via: [{url: 'https://github.com/advisories/' + advisory}] }
    assert.throws(() => validateApiAudit(report, lock, { ...controls, now: Date.parse('2026-09-10T03:00:00Z') }), /exceptions are retired/)
  })
}
for (const [label, mutate] of [
  ['transport error', r => { r.error = { code: 'EAI_AGAIN' } }],
  ['missing metadata', r => { delete r.metadata }],
  ['false clean report', r => { r.metadata.vulnerabilities.total = 1 }],
  ['unsupported report', r => { r.auditReportVersion = 1 }],
  ['missing entries', r => { delete r.vulnerabilities }]
]) test('audit rejects ' + label, () => {
  const report = cleanReport(); mutate(report)
  assert.throws(() => validateApiAudit(report, lock, controls))
})
for (const version of ['0.6.0', '0.6.2']) test('runtime and clean audit reject lock drift to ' + version, () => {
  const changed = structuredClone(lock)
  changed.packages['node_modules/adm-zip'].version = version
  assert.throws(() => verifyPinnedEmbeddingLock(changed), /lock drift/)
  assert.throws(() => validateApiAudit(cleanReport(), changed, controls), /lock drift/)
})
for (const [label, field, guard] of [
  ['GPU skip', 'dockerfile', 'RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev'],
  ['installer removal', 'dockerfile', '--strip-install-tools'],
  ['runner protection', 'workflow', 'ONNXRUNTIME_NODE_INSTALL: skip'],
  ['offline runtime test', 'workflow', '--network none --read-only --tmpfs /tmp']
]) test('clean audit still requires ' + label, () => {
  assert.throws(() => validateApiAudit(cleanReport(), lock, { ...controls, [field]: controls[field].replace(guard, 'REMOVED') }))
})
test('destructive stripping mode refuses the ordinary test checkout', () => {
  assert.throws(() => stripInstallTools())
})
test('bundled ONNX CPU executes the network-free Identity fixture', async () => {
  const ort = await import('onnxruntime-node')
  const session = await ort.InferenceSession.create(identityModel(), { executionProviders: ['cpu'] })
  try {
    const result = await session.run({ x: new ort.Tensor('float32', Float32Array.from([1, 2, 3]), [3]) })
    assert.deepEqual(Array.from(result.y.data), [1, 2, 3])
  } finally { await session.release() }
})
