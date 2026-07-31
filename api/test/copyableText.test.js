import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCopyableContent } from '../../app/src/shared/utils/copyableText.js'

function copySegments(lines) {
  return lines.flatMap((line) => line.segments.filter((segment) => segment.type === 'copy'))
}

test('copyable note content identifies URLs, IDs, addresses, dates and numbers', () => {
  const content = [
    '- 安装时间：2026-03-24',
    '- 服务名称：sub2api',
    '- 访问地址：https://sub.skrskr.net/health',
    '- 本机监听：127.0.0.1:18080',
    '- 身份证ID：11010519491231002X',
    '- 设备ID：550e8400-e29b-41d4-a716-446655440000',
    '- 当前状态：返回 200',
    'sub2api-postgres'
  ].join('\n')
  const lines = parseCopyableContent(content)
  const segments = copySegments(lines)
  const values = segments.map((segment) => segment.value)

  assert.ok(values.includes('2026-03-24'))
  assert.ok(values.includes('https://sub.skrskr.net/health'))
  assert.ok(values.includes('127.0.0.1:18080'))
  assert.ok(values.includes('11010519491231002X'))
  assert.ok(values.includes('550e8400-e29b-41d4-a716-446655440000'))
  assert.ok(values.includes('200'))
  assert.deepEqual(lines[1].copyTarget, {
    label: '服务名称',
    value: 'sub2api'
  })
  assert.deepEqual(lines[7].copyTarget, {
    label: '整行',
    value: 'sub2api-postgres'
  })
})

test('copyable parsing preserves every original character as text segments', () => {
  const content = '<script>alert(1)</script>\n网址：https://example.com/a?x=1\n空白  123'
  const lines = parseCopyableContent(content)
  const reconstructed = lines
    .map((line) => line.segments.map((segment) => segment.value).join(''))
    .join('\n')

  assert.equal(reconstructed, content)
  assert.equal(lines[0].segments[0].type, 'text')
})

test('a URL is one copy target instead of separate numeric fragments', () => {
  const [line] = parseCopyableContent('https://127.0.0.1:18080/health?code=200')
  const segments = line.segments.filter((segment) => segment.type === 'copy')

  assert.deepEqual(segments.map(({ kind, value }) => ({ kind, value })), [
    {
      kind: 'url',
      value: 'https://127.0.0.1:18080/health?code=200'
    }
  ])
})

test('structured names and equals fields are directly copyable', () => {
  const lines = parseCopyableContent([
    '服务名称：sub2api',
    '联系人=张三',
    '部署方式: Docker Compose',
    '项目名称：Project 2026'
  ].join('\n'))
  const segments = copySegments(lines)

  assert.deepEqual(
    segments.map(({ kind, value }) => ({ kind, value })),
    [
      { kind: 'name', value: 'sub2api' },
      { kind: 'name', value: '张三' },
      { kind: 'name', value: 'Docker Compose' },
      { kind: 'name', value: 'Project 2026' }
    ]
  )
  assert.deepEqual(lines[1].copyTarget, {
    label: '联系人',
    value: '张三'
  })
})

test('resident IDs require a valid birth date and checksum before identity labeling', () => {
  const segments = copySegments(parseCopyableContent([
    '身份证ID：11010519491231002X',
    '身份证ID：11010519490231002X',
    '身份证ID：110105194912310021',
    '身份证ID：000000194912310000',
    '身份证ID：110105209912310029',
    '身份证ID：110105194912310003'
  ].join('\n')))
  const identityValues = segments
    .filter((segment) => segment.kind === 'identity')
    .map((segment) => segment.value)

  assert.deepEqual(identityValues, ['11010519491231002X'])
})

test('copy token and analysis limits preserve all source text', () => {
  const content = `${Array.from({ length: 510 }, (_, index) => String(index + 10)).join(' ')}\n${'a'.repeat(50_100)}`
  const lines = parseCopyableContent(content)
  const reconstructed = lines
    .map((line) => line.segments.map((segment) => segment.value).join(''))
    .join('\n')

  assert.equal(copySegments(lines).length, 500)
  assert.equal(reconstructed, content)
})

test('analysis cutoff never exposes a silently truncated copy target', () => {
  const value = 'a'.repeat(60_000)
  const [line] = parseCopyableContent(`名称：${value}`)
  const copyValues = line.segments
    .filter((segment) => segment.type === 'copy')
    .map((segment) => segment.value)

  assert.equal(copyValues.includes(value.slice(0, 49_997)), false)
  assert.deepEqual(line.copyTarget, {
    label: '名称',
    value
  })
})

test('email, balanced URL punctuation and labeled IDs are not misclassified', () => {
  const lines = parseCopyableContent([
    '邮箱：user@example.com',
    '资料：https://en.wikipedia.org/wiki/Foo_(bar)',
    '网址：https://example.com：',
    'identity123',
    'idempotent',
    'ID: ABC-123'
  ].join('\n'))
  const segments = copySegments(lines)

  assert.ok(segments.some((segment) => segment.kind === 'email' && segment.value === 'user@example.com'))
  assert.ok(segments.some((segment) => segment.kind === 'url' && segment.value === 'https://en.wikipedia.org/wiki/Foo_(bar)'))
  assert.ok(segments.some((segment) => segment.kind === 'url' && segment.value === 'https://example.com'))
  assert.equal(segments.some((segment) => segment.value === 'entity123'), false)
  assert.equal(segments.some((segment) => segment.value === 'empotent'), false)
  assert.ok(segments.some((segment) => segment.kind === 'id' && segment.value === 'ABC-123'))
})

test('invalid date and time shapes fall back to ordinary numeric copying', () => {
  const segments = copySegments(parseCopyableContent('日期：2026-02-30，时间：99:99'))

  assert.equal(segments.some((segment) => segment.kind === 'date'), false)
  assert.ok(segments.some((segment) => segment.kind === 'number'))
})
