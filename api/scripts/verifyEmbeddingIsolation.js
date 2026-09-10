import assert from 'node:assert/strict'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { embeddingException } from './embeddingIsolationContract.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(new URL('../package.json', import.meta.url))
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
export function verifyPinnedEmbeddingLock(lock) {
  for (const [name, version] of Object.entries(embeddingException.versions)) {
    assert.equal(lock.packages?.[`node_modules/${name}`]?.version, version, `Embedding lock drift: ${name}`)
  }
}
export function stripInstallTools() {
  // Destructive mode is confined to this Linux image build, never the checkout.
  assert.equal(process.platform, 'linux')
  assert.equal(root, '/app')
  assert.equal(process.cwd(), '/app')
  assert.equal(process.env.NAV_BUILD_ISOLATION, '1')
  assert.equal(process.env.ONNXRUNTIME_NODE_INSTALL, 'skip')
  assert.equal(realpathSync('/app/node_modules'), '/app/node_modules')
  verifyPinnedEmbeddingLock(readJson(join(root, 'package-lock.json')))
  for (const [name, version] of Object.entries(embeddingException.versions)) {
    assert.equal(readJson(join(root, 'node_modules', name, 'package.json')).version, version, `Installed version drift: ${name}`)
  }
  const targets = ['/app/node_modules/adm-zip', '/app/node_modules/onnxruntime-node/script']
  for (const target of targets) {
    assert.ok(lstatSync(target).isDirectory() && !lstatSync(target).isSymbolicLink())
    assert.equal(realpathSync(target), target)
  }
  for (const target of targets) rmSync(target, { recursive: true, force: false })
}

// Deterministic ONNX Identity graph (IR8/opset13), no downloaded model.
export function identityModel() {
  const field = (number, bytes) => [number * 8 + 2, bytes.length, ...bytes]
  const text = (number, value) => field(number, [...Buffer.from(value)])
  const valueInfo = (name) => [...text(1, name), ...field(2, field(1, [8, 1, ...field(2, field(1, [8, 3]))]))]
  const graph = [
    ...field(1, [...text(1, 'x'), ...text(2, 'y'), ...text(4, 'Identity')]),
    ...text(2, 'nav-isolation'), ...field(11, valueInfo('x')), ...field(12, valueInfo('y'))
  ]
  return Uint8Array.from([8, 8, ...field(7, graph), ...field(8, [16, 13])])
}
export async function verifyEmbeddingIsolation() {
  verifyPinnedEmbeddingLock(readJson(join(root, 'package-lock.json')))
  assert.equal(existsSync(join(root, 'node_modules/adm-zip')), false, 'Vulnerable ZIP code remains')
  assert.equal(existsSync(join(root, 'node_modules/onnxruntime-node/script')), false, 'Installer remains')
  for (const from of [root, join(root, 'node_modules/onnxruntime-node')]) {
    assert.throws(() => require.resolve('adm-zip', { paths: [from] }), { code: 'MODULE_NOT_FOUND' })
  }
  for (const entry of readdirSync(join(root, 'node_modules/onnxruntime-node/bin'), { recursive: true })) {
    assert.doesNotMatch(String(entry), /providers_(?:cuda|tensorrt)/i, 'Unexpected downloaded GPU provider')
  }
  await import('@huggingface/transformers')
  const ort = await import('onnxruntime-node')
  const session = await ort.InferenceSession.create(identityModel(), { executionProviders: ['cpu'] })
  try {
    const result = await session.run({ x: new ort.Tensor('float32', Float32Array.from([1, 2, 3]), [3]) })
    assert.deepEqual(Array.from(result.y.data), [1, 2, 3])
  } finally { await session.release() }
  return { isolation: embeddingException.isolation, zipCodePresent: false, installerPresent: false, gpuDownloadsPresent: false, transformersImport: true, nativeCpuInference: true }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.includes('--strip-install-tools')) stripInstallTools()
  console.log(JSON.stringify(await verifyEmbeddingIsolation()))
}
