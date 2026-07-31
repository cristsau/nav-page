import test from 'node:test'
import assert from 'node:assert/strict'
import { buildFullNoteText } from '../../app/src/modules/whisper/utils/noteCopyText.js'

test('quick copy returns the complete note metadata and body', () => {
  const text = buildFullNoteText({
    id: 'internal-id',
    numberId: 1000,
    type: 'memo',
    title: 'SUB2AI',
    content: '部署摘要\nhttps://sub.skrskr.net',
    updatedAt: '2026-03-24T09:55:38+08:00',
    dueAt: '2026-03-25T18:00:00+08:00',
    completed: false,
    tags: ['部署', 'API']
  })

  assert.match(text, /^ID: #1000/m)
  assert.match(text, /^类型: 备忘录/m)
  assert.match(text, /^标题: SUB2AI/m)
  assert.match(text, /^更新时间: /m)
  assert.match(text, /^截止时间: /m)
  assert.match(text, /^状态: 待完成/m)
  assert.match(text, /^标签: 部署, API/m)
  assert.ok(text.endsWith('部署摘要\nhttps://sub.skrskr.net'))
})

test('quick copy preserves the note body whitespace verbatim', () => {
  const body = '\n  第一行  \n第二行\n'
  const text = buildFullNoteText({
    id: 'internal-id',
    type: 'diary',
    title: '留白测试',
    content: body
  })

  assert.ok(text.endsWith(`\n\n${body}`))
})
