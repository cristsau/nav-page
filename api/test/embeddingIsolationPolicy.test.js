import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateApiAudit } from '../../.github/scripts/verify-api-audit-policy.mjs'
import { embeddingException } from '../scripts/embeddingIsolationContract.js'
import { identityModel, stripInstallTools } from '../scripts/verifyEmbeddingIsolation.js'

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url)))
const controls = {
  now: Date.parse(embeddingException.notBefore) + 1000,
  dockerfile: readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
  workflow: readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
}
function report() {
  return {
    auditReportVersion: 2, metadata: { vulnerabilities: { total: 3 } },
    vulnerabilities: Object.fromEntries(Object.keys(embeddingException.versions).map((name) => [name, {
      name, severity: 'moderate', nodes: [`node_modules/${name}`],
      via: name === 'adm-zip' ? [{ url: `https://github.com/advisories/${embeddingException.advisory.toLowerCase()}` }]
        : [name === 'onnxruntime-node' ? 'adm-zip' : 'onnxruntime-node']
    }]))
  }
}
test('only the exact owner-approved advisory chain passes before expiry', () => {
  const result = validateApiAudit(report(), lock, controls)
  assert.equal(result.status, 'PASS_WITH_EXPIRING_EXCEPTION')
  assert.equal(result.expiresAt, embeddingException.expiresAt)
  assert.equal(result.affectedPackageEntries, 3)
  assert.ok(Date.parse(embeddingException.expiresAt) - Date.parse(embeddingException.notBefore) <= 7 * 86400000)
})
for (const [label, now] of [
  ['before authorization', Date.parse(embeddingException.notBefore) - 1],
  ['at expiry', Date.parse(embeddingException.expiresAt)],
  ['after expiry', Date.parse(embeddingException.expiresAt) + 1],
  ['invalid time', NaN]
]) test(`temporary exception rejects ${label}`, () => {
  assert.throws(() => validateApiAudit(report(), lock, { ...controls, now }), /authorized window/)
})
test('a truly clean audit needs no exception, even after expiry', () => {
  assert.deepEqual(validateApiAudit({ auditReportVersion: 2, metadata: { vulnerabilities: { total: 0 } }, vulnerabilities: {} }, lock,
    { ...controls, now: Date.parse(embeddingException.expiresAt) }), { status: 'PASS', exception: false })
})
for (const [label, mutate] of [
  ['new advisory', (r) => { r.vulnerabilities['adm-zip'].via.push({ url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' }) }],
  ['old blanket exception', (r) => { r.vulnerabilities['adm-zip'].via = [{ url: 'https://github.com/advisories/GHSA-f88m-g3jw-g9cj' }] }],
  ['severity escalation', (r) => { r.vulnerabilities['adm-zip'].severity = 'high' }],
  ['nested vulnerable copy', (r) => { r.vulnerabilities['adm-zip'].nodes.push('node_modules/other/node_modules/adm-zip') }],
  ['unresolved cause', (r) => { r.vulnerabilities['adm-zip'].via = ['missing-package'] }],
  ['cycle', (r) => { r.vulnerabilities['adm-zip'].via = ['onnxruntime-node'] }],
  ['unknown package', (r) => { r.vulnerabilities.other = { name: 'other' }; r.metadata.vulnerabilities.total++ }],
  ['report transport error', (r) => { r.error = { code: 'EAI_AGAIN' } }],
  ['missing metadata', (r) => { delete r.metadata }],
  ['false clean report', (r) => { r.vulnerabilities = {} }]
]) test(`audit remains fail-closed for ${label}`, () => {
  const changed = report(); mutate(changed)
  assert.throws(() => validateApiAudit(changed, lock, controls))
})
test('package version drift is rejected', () => {
  const changed = structuredClone(lock)
  changed.packages['node_modules/adm-zip'].version = '0.6.1'
  assert.throws(() => validateApiAudit(report(), changed, controls), /lock drift/)
})
for (const [label, field, guard] of [
  ['GPU skip', 'dockerfile', 'RUN ONNXRUNTIME_NODE_INSTALL=skip npm ci --omit=dev'],
  ['installer removal', 'dockerfile', '--strip-install-tools'],
  ['runner protection', 'workflow', 'ONNXRUNTIME_NODE_INSTALL: skip'],
  ['offline runtime test', 'workflow', '--network none --read-only --tmpfs /tmp']
]) test(`exception rejects missing ${label} control`, () => {
  assert.throws(() => validateApiAudit(report(), lock, { ...controls, [field]: controls[field].replace(guard, 'REMOVED') }))
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
