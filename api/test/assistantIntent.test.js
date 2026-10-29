import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSISTANT_INTENT_TYPES,
  buildAssistantClockContext,
  classifyAssistantIntent,
  isMonitorChangeRequest,
  resolveMonitorTrafficClarification,
  normalizeAssistantTimeZone,
  shouldSearchAssistantReminders
} from '../src/lib/assistantIntent.js'

const FIXED_NOW = new Date('2026-08-26T01:02:03.000Z')

test('only a direct quota unit clarification resumes the same monitor preview', () => {
  const request='当前服务器：Ali-HK（ID 4）。帮我设置成每月200g上限，上行，下行取最大值'
  const history=[{role:'user',content:request},{role:'assistant',content:'请确认 200 GB 还是 200 GiB？'}]
  for(const reply of ['GB','200 GiB','按 200 GB','当前服务器：Ali-HK（ID 4）。200 GB']) {
    const resolved=resolveMonitorTrafficClarification(reply,history)
    assert.match(resolved,/用户补充确认单位/)
    assert.equal(classifyAssistantIntent(resolved).action,true)
  }
  for(const reply of ['不要修改，用 GB 只是举例','算了','确认','我附图了','200 Mbps','当前服务器：Other（ID 5）。200 GB']) {
    assert.equal(resolveMonitorTrafficClarification(reply,history),'',reply)
  }
  assert.equal(resolveMonitorTrafficClarification('GB',[]),'')
  assert.equal(resolveMonitorTrafficClarification('GB',[...history,{role:'user',content:'你好'},{role:'assistant',content:'你好'}]),'')
  assert.equal(resolveMonitorTrafficClarification('GB',[history[0],{role:'assistant',content:'已经设置 200 GB（186 GiB）'}]),'')
})

test('monitor traffic commands enter the preview route without requiring the word traffic', () => {
  for (const question of [
    '当前服务器：Ali-HK（ID 4）。帮我设置成每月200g上限，上行，下行取最大值',
    '当前服务器：Ali-HK（ID 4）。帮我设置成每月200 GB上限，上行，下行取最大值',
    '帮我把 Ali-HK 上行下行改成取最大值',
    '把服务器入出计费改为取大',
    '把 Ali-HK 改成单向最大值',
    '请把 VPS 每月上限设置为 200 GiB',
    '当前服务器：Synthetic（ID 1）。设置每月２００ＧＢ上限'
  ]) {
    assert.equal(isMonitorChangeRequest(question), true, question)
    assert.equal(classifyAssistantIntent(question).action, true, question)
  }
})

test('monitor explanations, negation and bandwidth requests do not offer asset changes', () => {
  for (const question of [
    'Ali-HK 每月200g上限，上行下行取最大值是什么意思？',
    '如何给 Ali-HK 设置每月200GB上限？',
    '不要把 Ali-HK 上行下行设置成取最大值',
    'Ali-HK 暂时不修改流量额度，先讨论',
    'Ali-HK 设置每月200GB上限，我们先讨论',
    '请翻译“帮我设置服务器每月200GB上限”',
    '请改写“把服务器上行下行设置为取最大值”',
    '请把 Ali-HK 的带宽设置为2000Mbps上限',
    '请把 Ali-HK 上行带宽设置为2000Mbps上限',
    '请把服务器连接数上限设置为200',
    '帮我创建一条笔记，内容是服务器设置每月200GB上限'
  ]) {
    assert.equal(isMonitorChangeRequest(question), false, question)
    if (!question.includes('创建一条笔记')) assert.equal(classifyAssistantIntent(question).action, false, question)
  }
})

test('date and time questions use a deterministic clock intent without reminder retrieval', () => {
  const result = classifyAssistantIntent('今天日期', { now: FIXED_NOW })

  assert.equal(result.type, ASSISTANT_INTENT_TYPES.CURRENT_TIME)
  assert.equal(result.currentDateTime, true)
  assert.equal(result.reminderSearch, false)
  assert.equal(result.localSearch, false)
  assert.equal(result.clock.timeZone, 'Asia/Shanghai')
  assert.equal(result.clock.localDate, '2026-08-26')
  assert.equal(result.clock.localTime, '09:02:03')
})

test('reminder retrieval requires an explicit reminder or task phrase', () => {
  assert.equal(shouldSearchAssistantReminders('今天日期'), false)
  assert.equal(shouldSearchAssistantReminders('今天有什么到期提醒？'), true)
  assert.equal(shouldSearchAssistantReminders('我今天有哪些需要处理的事情？'), true)

  const result = classifyAssistantIntent('我今天有哪些待办？', { now: FIXED_NOW })
  assert.equal(result.type, ASSISTANT_INTENT_TYPES.LOCAL_SEARCH)
  assert.equal(result.reminderSearch, true)
  assert.equal(result.localSearch, true)
})

test('general, local and web research intents remain distinct', () => {
  assert.equal(
    classifyAssistantIntent('你好，你是谁？', { now: FIXED_NOW }).type,
    ASSISTANT_INTENT_TYPES.GENERAL
  )
  assert.equal(
    classifyAssistantIntent('从我的笔记里找部署配置', { now: FIXED_NOW }).type,
    ASSISTANT_INTENT_TYPES.LOCAL_SEARCH
  )
  assert.equal(
    classifyAssistantIntent('联网查一下最新版本', { now: FIXED_NOW }).type,
    ASSISTANT_INTENT_TYPES.WEB_RESEARCH
  )
})

test('compound research and save requests are actions while retaining web requirements', () => {
  const result = classifyAssistantIntent(
    '帮我查一些资料，然后保存到导航页',
    { now: FIXED_NOW }
  )

  assert.equal(result.type, ASSISTANT_INTENT_TYPES.ACTION)
  assert.equal(result.action, true)
  assert.equal(result.webSearch, true)
  assert.equal(result.localSearch, true)
})

test('creating today diary is an action, not a current-time query', () => {
  const result = classifyAssistantIntent('创建一个今天的日记', { now: FIXED_NOW })

  assert.equal(result.type, ASSISTANT_INTENT_TYPES.ACTION)
  assert.equal(result.action, true)
  assert.equal(result.currentDateTime, false)
  assert.equal(result.localContextRequested, false)
  assert.equal(result.emailSearch, false)
  assert.equal(result.clock.localDate, '2026-08-26')
})

test('tutorial questions never authorize writes or expose unrelated local data', () => {
  for (const question of [
    '我想知道怎么创建日记',
    '请告诉我如何创建书签',
    '创建日记需要什么',
    'how do I create a diary?',
    '请说明创建日记功能',
    '请解释创建日记是什么意思',
    '创建日记会发生什么？',
    '能不能创建日记？',
    'Please explain create diary',
    'Please explain how create diary'
  ]) {
    const result = classifyAssistantIntent(question, { now: FIXED_NOW })
    assert.equal(result.action, false, question)
    assert.equal(result.localContextRequested, false, question)
    assert.equal(result.emailSearch, false, question)
  }

  const emailConfig = classifyAssistantIntent('如何配置邮箱？', { now: FIXED_NOW })
  assert.equal(emailConfig.emailSearch, false)
  assert.equal(emailConfig.localSearch, false)

  for (const capabilityQuestion of [
    '你能创建日记吗？',
    '请问你能创建日记吗？',
    '你能读我的邮件吗？',
    '系统是不是会自动创建日记吧',
    '这个功能会自动创建日记吧',
    '现在系统会自动创建日记吗',
    '现在这个应用支持创建备忘录吗',
    '我想知道系统会创建日记吗',
    '我要知道系统会创建备忘录吗',
    '我想确认这个应用会保存书签吗',
    '帮我判断这个系统会创建日记吗',
    'can you create a diary?',
    'can you search my email?'
  ]) {
    const result = classifyAssistantIntent(capabilityQuestion, { now: FIXED_NOW })
    assert.equal(result.action, false, capabilityQuestion)
    assert.equal(result.localSearch, false, capabilityQuestion)
  }

  for (const explicitCommand of [
    '创建今天的日记吧',
    '现在请帮我创建今天的日记',
    '可以帮我创建今天的备忘录吗',
    '我想创建一个工作分组'
  ]) {
    const result = classifyAssistantIntent(explicitCommand, { now: FIXED_NOW })
    assert.equal(result.action, true, explicitCommand)
  }
})

test('translation, rewriting and quoted examples never authorize writes', () => {
  for (const nonExecutionRequest of [
    '把“创建日记”翻译成英文',
    '把"创建日记"翻译成英文',
    '把“创建日记”翻译成我的语言',
    '把“创建日记”翻译成本地语言',
    '请改写“创建一个日记”',
    '请总结“创建日记”这句话',
    '解释一下“创建日记”',
    '请举例说明创建日记',
    '给我一个创建日记的示例',
    '请给一个创建日记的例子',
    '请以“创建日记”为例造句',
    '帮我引用创建日记这句话',
    'Translate "create a diary" into Chinese',
    "Please explain 'create a diary'",
    'Please rewrite create a diary'
  ]) {
    const result = classifyAssistantIntent(nonExecutionRequest, { now: FIXED_NOW })
    assert.equal(result.action, false, nonExecutionRequest)
    assert.equal(result.localSearch, false, nonExecutionRequest)
    assert.equal(result.localContextRequested, false, nonExecutionRequest)
    assert.notEqual(result.type, ASSISTANT_INTENT_TYPES.LOCAL_SEARCH, nonExecutionRequest)
  }

  const explicitlyScopedRead = classifyAssistantIntent(
    '把我的日记里“创建日记”这句话翻译成英文',
    { now: FIXED_NOW }
  )
  assert.equal(explicitlyScopedRead.action, false)
  assert.equal(explicitlyScopedRead.nonExecutionContext, true)
  assert.equal(explicitlyScopedRead.explicitPrivateScope, true)
  assert.equal(explicitlyScopedRead.localSearch, true)
  assert.equal(explicitlyScopedRead.type, ASSISTANT_INTENT_TYPES.LOCAL_SEARCH)

  for (const explicitCommand of [
    '把今天的工作总结写成日记并保存',
    '把这个网址保存到导航',
    '帮我总结今天的工作并创建日记'
  ]) {
    const result = classifyAssistantIntent(explicitCommand, { now: FIXED_NOW })
    assert.equal(result.action, true, explicitCommand)
  }
})

test('explicit unsupported mutations remain actions so the route can refuse them safely', () => {
  const deletion = classifyAssistantIntent('请删除这篇日记', { now: FIXED_NOW })
  assert.equal(deletion.action, true)
  assert.equal(deletion.type, ASSISTANT_INTENT_TYPES.ACTION)

  const deletionTutorial = classifyAssistantIntent('请说明如何删除日记', { now: FIXED_NOW })
  assert.equal(deletionTutorial.action, false)
})

test('email retrieval is opt-in and local action context must be explicit', () => {
  const email = classifyAssistantIntent('查看我的重要邮件', { now: FIXED_NOW })
  assert.equal(email.emailSearch, true)

  const noteAction = classifyAssistantIntent(
    '从我的笔记里找上次部署信息并创建今天的日记',
    { now: FIXED_NOW }
  )
  assert.equal(noteAction.action, true)
  assert.equal(noteAction.localContextRequested, true)
  assert.equal(noteAction.emailSearch, false)

  const webSave = classifyAssistantIntent(
    '帮我查一些资料，然后保存到导航页',
    { now: FIXED_NOW }
  )
  assert.equal(webSave.localContextRequested, false)
  assert.equal(webSave.emailSearch, false)

  const reminderAction = classifyAssistantIntent(
    '创建一条明天提醒我的备忘录',
    { now: FIXED_NOW }
  )
  assert.equal(reminderAction.action, true)
  assert.equal(reminderAction.reminderSearch, true)
  assert.equal(reminderAction.localContextRequested, false)
})

test('clock context honors valid zones and safely falls back for invalid zones', () => {
  const tokyo = buildAssistantClockContext({
    now: FIXED_NOW,
    timeZone: 'Asia/Tokyo'
  })
  assert.equal(tokyo.localTime, '10:02:03')
  assert.equal(tokyo.timeZone, 'Asia/Tokyo')
  assert.equal(normalizeAssistantTimeZone('Invalid/Zone'), 'Asia/Shanghai')
  assert.throws(
    () => buildAssistantClockContext({ now: 'invalid-date' }),
    /valid date/
  )
})
