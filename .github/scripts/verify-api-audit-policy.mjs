import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const allowedAdvisories = new Set([
  'GHSA-F88M-G3JW-G9CJ',
  'GHSA-XCPC-8H2W-3J85'
])

const allowedPackages = new Map([
  ['@huggingface/transformers', '4.2.0'],
  ['onnxruntime-node', '1.24.3'],
  ['sharp', '0.34.5'],
  ['adm-zip', '0.5.18']
])

const audit = spawnSync(
  process.platform === 'win32' ? 'cmd.exe' : 'npm',
  process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm audit --prefix api --json --audit-level=moderate']
    : ['audit', '--prefix', 'api', '--json', '--audit-level=moderate'],
  { encoding: 'utf8' }
)

if (!audit.stdout) {
  process.stderr.write(audit.error?.message || audit.stderr || 'npm audit did not return JSON\n')
  process.exit(1)
}

let report
try {
  report = JSON.parse(audit.stdout)
} catch (error) {
  process.stderr.write(`Unable to parse npm audit output: ${error.message}\n`)
  process.exit(1)
}

const vulnerabilities = report.vulnerabilities || {}
const lock = JSON.parse(readFileSync(new URL('../../api/package-lock.json', import.meta.url)))

function collectAdvisories(name, seen = new Set()) {
  if (seen.has(name)) return new Set()
  seen.add(name)
  const vulnerability = vulnerabilities[name]
  if (!vulnerability) return null

  const result = new Set()
  for (const cause of vulnerability.via || []) {
    if (typeof cause === 'string') {
      const nested = collectAdvisories(cause, seen)
      if (!nested) return null
      for (const advisory of nested) result.add(advisory)
      continue
    }
    const match = String(cause.url || '').match(/(GHSA-[a-z0-9-]+)$/i)
    if (!match) return null
    result.add(match[1].toUpperCase())
  }
  return result
}

const rejected = []
for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  const advisories = collectAdvisories(name)
  const expectedVersion = allowedPackages.get(name)
  const installedVersion = lock.packages?.[`node_modules/${name}`]?.version
  const permitted = Boolean(
    expectedVersion
    && installedVersion === expectedVersion
    && advisories
    && advisories.size > 0
    && [...advisories].every((id) => allowedAdvisories.has(id))
  )

  if (!permitted) {
    rejected.push({
      name,
      severity: vulnerability.severity,
      installedVersion,
      advisories: advisories ? [...advisories] : ['unresolved']
    })
  }
}

if (rejected.length > 0) {
  process.stderr.write(`Unapproved API dependency vulnerabilities:\n${JSON.stringify(rejected, null, 2)}\n`)
  process.exit(1)
}

if (Object.keys(vulnerabilities).length > 0) {
  process.stdout.write(
    'API audit passed with a narrow temporary exception for two no-fix advisories ' +
    'inside the pinned, local-only embedding runtime. Any package, version, or advisory drift fails CI.\n'
  )
} else {
  process.stdout.write('API audit passed with no vulnerabilities.\n')
}
