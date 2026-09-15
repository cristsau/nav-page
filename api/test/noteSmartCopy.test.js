import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCopyableContent } from '../../app/src/shared/utils/copyableText.js'
const tokens = (text) => parseCopyableContent(text).flatMap((line) => line.segments.filter((item) => item.type === 'copy'))

test('address fields copy the entire value, not just street or postal numbers', () => {
  for (const [label, value] of [['街道', '123 Example Street'], ['城市', 'Example City'], ['邮编', '12345-6789'], ['Address', '100 Example Road, Test City']]) {
    const found = tokens(`${label}: ${value}`)
    assert.equal(found.length, 1)
    assert.equal(found[0].kind, 'postal-address')
    assert.equal(found[0].value, value)
  }
})
test('an explicitly headed multi-line address has one full address target', () => {
  const source = '完整地址（英文）：\n123 Example Street\nExample City, CA 12345\nUnited States\n\n地址信息：\n城市：Example City'
  const lines = parseCopyableContent(source)
  assert.deepEqual(lines[0].blockCopyTarget, { label: '完整地址', value: '123 Example Street\nExample City, CA 12345\nUnited States' })
  assert.equal(lines[5].blockCopyTarget, undefined)
  assert.equal(lines.map((line) => line.segments.map((item) => item.value).join('')).join('\n'), source)
  assert.equal(parseCopyableContent('工作记录：\nfirst\nsecond')[0].blockCopyTarget, undefined)
})
test('conservative standalone street shapes copy as an address, prose does not', () => {
  for (const value of ['123 Example Street', '456 Sample Rd, Example City', '示例市测试区示例路123号']) {
    assert.deepEqual(tokens(value).map((item) => [item.kind, item.value]), [['postal-address', value]])
  }
  assert.equal(tokens('123 tasks are complete').some((item) => item.kind === 'postal-address'), false)
})
test('card recognition uses checksum and keeps original display while copying digits', () => {
  for (const input of ['4111111111111111', '4111 1111 1111 1111', '4111-1111-1111-1111', '3782 822463 10005']) {
    const [card] = tokens(`银行卡：${input}`)
    assert.equal(card.kind, 'bank-card')
    assert.equal(card.value, input)
    assert.equal(card.copyValue, input.replace(/[ -]/g, ''))
  }
  for (const input of ['4111111111111112', '0000000000000000', '4111 **** **** 1111', '订单号：4111111111111111', '10 11 12 13 14 15 16 17']) {
    assert.equal(tokens(input).some((item) => item.kind === 'bank-card'), false)
  }
})
test('IPv4 and IPv6 remain whole tokens including valid ports', () => {
  for (const input of ['192.0.2.1', '192.0.2.1:8443', '2001:db8::1', '::1', '[2001:db8::1]:8443', '::ffff:192.0.2.1']) {
    assert.deepEqual(tokens(`IP：${input}`).filter((item) => item.kind === 'address').map((item) => item.value), [input])
  }
  assert.deepEqual(parseCopyableContent('2001:db8::1')[0].copyTarget, { label: '整行', value: '2001:db8::1' })
  for (const input of ['999.1.1.1', '192.0.2.1:99999', '[2001:db8::1]:99999', '2001:db8:::1', '12:30:45']) {
    assert.equal(tokens(input).some((item) => item.kind === 'address'), false, input)
  }
})
test('unknown fields have a verbatim field/line fallback and HTML stays plain text', () => {
  const source = '任意字段：ABCD *** 1234\n<script>alert("test")</script>\nhttps://example.com/a?ip=192.0.2.1'
  const lines = parseCopyableContent(source)
  assert.equal(lines[0].copyTarget.value, 'ABCD *** 1234')
  assert.equal(lines[1].copyTarget.value, '<script>alert("test")</script>')
  assert.equal(lines.map((line) => line.segments.map((item) => item.value).join('')).join('\n'), source)
  assert.equal(lines[2].segments.length, 1)
})
