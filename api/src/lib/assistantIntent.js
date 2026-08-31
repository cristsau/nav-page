import {
  isAssistantCreateMetaQuestion,
  isAssistantNonExecutionMutationContext,
  isExplicitAssistantMutationRequest
} from './assistantAuthorization.js'

export const DEFAULT_ASSISTANT_TIME_ZONE = 'Asia/Shanghai'

export const ASSISTANT_INTENT_TYPES = Object.freeze({
  CURRENT_TIME: 'current-time',
  GENERAL: 'general',
  LOCAL_SEARCH: 'local-search',
  WEB_RESEARCH: 'web-research',
  ACTION: 'action'
})

const CURRENT_TIME_PATTERN = new RegExp([
  '(?:今天|今日|当前|现在)(?:是)?(?:几号|几月几日|什么日期|日期|星期几|周几|几点|什么时间|时间)',
  '(?:当前|现在)(?:的)?(?:日期|时间)',
  '(?:日期|时间)(?:是)?(?:多少|什么)',
  'what(?:\\s+is)?(?:\\s+the)?\\s+(?:date|time|day)',
  'what\\s+day\\s+is\\s+it',
  'current\\s+(?:date|time)',
  "today(?:'s)?\\s+date"
].join('|'), 'iu')

const EXPLICIT_REMINDER_PATTERN = new RegExp([
  '提醒',
  '待办',
  '任务',
  '到期',
  '截止',
  '需要处理',
  '要处理',
  '日程',
  '安排',
  '\\breminders?\\b',
  '\\btodos?\\b',
  '\\bdue\\b',
  '\\bdeadlines?\\b',
  '\\btasks?\\b'
].join('|'), 'iu')

const LOCAL_SEARCH_PATTERN = new RegExp([
  '站内',
  '本地(?:资料|记录|内容|搜索|检索)',
  '我的(?:导航|书签|笔记|日记|备忘录|邮件|提醒|记录|资料)',
  '我(?:之前|以前|保存|收藏|记录|写)(?:的|过)?',
  '导航(?:页)?',
  '书签',
  '笔记',
  '日记',
  '备忘录',
  '邮件',
  '数字\\s*ID',
  '#\\d+',
  '\\b(?:my|local|saved)\\s+(?:bookmarks?|notes?|memos?|emails?|reminders?)\\b'
].join('|'), 'iu')

const LOCAL_CONTEXT_PATTERN = new RegExp([
  '站内',
  '本地(?:资料|记录|内容|搜索|检索)',
  '我的(?:导航|书签|笔记|日记|备忘录|提醒|待办|记录|资料)',
  '我(?:之前|以前|保存|收藏|记录|写)(?:的|过)?',
  '从.{0,20}(?:导航|书签|笔记|日记|备忘录|提醒|待办)',
  '数字\\s*ID',
  '#\\d+',
  '\\b(?:my|local|saved)\\s+(?:bookmarks?|notes?|memos?|reminders?)\\b'
].join('|'), 'iu')

const EXPLICIT_PRIVATE_SCOPE_PATTERN = new RegExp([
  '我的(?:导航|书签|笔记|日记|备忘录|邮件|提醒|记录|资料|内容|数据|工作区|nav)',
  '站内',
  '本地(?!化|语言|语种|口语)(?:的|资料|记录|内容|搜索|检索|工作区|导航|书签|笔记|日记|备忘录|邮件)?',
  '工作区',
  '(?:domo\\s*)?nav\\s*(?:里|内|中的|里的)',
  '从\\s*(?:我的(?:资料|内容|记录|工作区|nav)|站内|本地|工作区|(?:domo\\s*)?nav)',
  '\\b(?:my\\s+(?:workspace|nav|bookmarks?|notes?|diar(?:y|ies)|memos?|emails?|reminders?|records?|data|content)|local\\s+(?:workspace|nav|data|content|records?)|workspace|in\\s+(?:my\\s+)?nav)\\b'
].join('|'), 'iu')

const EMAIL_SEARCH_PATTERN = new RegExp([
  '邮件',
  '邮箱',
  '收件箱',
  '发件人',
  '\\b(?:email|mail|inbox|sender)\\b'
].join('|'), 'iu')

const ACTION_LOCAL_CONTEXT_CUE_PATTERN = new RegExp([
  '从',
  '根据',
  '参考',
  '读取',
  '查找',
  '搜索',
  '检索',
  '找到',
  '基于',
  '利用',
  '(?:把|用).{0,24}我的(?:导航|书签|笔记|日记|备忘录|提醒|待办|记录|资料)'
].join('|'), 'iu')

const WEB_RESEARCH_PATTERN = new RegExp([
  '联网',
  '网上',
  '网络',
  '全网',
  '网页',
  '搜索引擎',
  '公开资料',
  '最新(?:消息|新闻|资料|进展|版本|政策|价格)',
  '新闻',
  '官网',
  '查(?:找|询|一下|一查)?(?:一些)?资料',
  '\\b(?:web|internet|online)\\s+(?:search|research)\\b',
  '\\bsearch\\s+(?:the\\s+)?web\\b',
  '\\blatest\\s+(?:news|release|version|price|policy)\\b'
].join('|'), 'iu')

const ACTION_VERB_PATTERN = new RegExp([
  '创建',
  '新建',
  '添加',
  '保存',
  '存到',
  '记录到',
  '写(?:一篇|一个|入)?',
  '生成',
  '修改',
  '更新',
  '编辑',
  '移动',
  '删除',
  '归档',
  '置顶',
  '标记',
  '发送',
  '回复',
  '\\b(?:create|add|save|write|update|edit|move|delete|archive|pin|send|reply)\\b'
].join('|'), 'iu')

const ACTION_TARGET_PATTERN = new RegExp([
  '导航(?:页)?',
  '书签',
  '笔记',
  '日记',
  '备忘录',
  '提醒',
  '待办',
  '分组',
  '邮件',
  '分享',
  '草稿',
  '数据库',
  '数据表',
  '记录',
  '\\b(?:bookmark|note|diary|memo|reminder|todo|group|email|share|draft|database|row)\\b'
].join('|'), 'iu')

const EMAIL_RETRIEVAL_CUE_PATTERN = new RegExp([
  '我的(?:邮件|邮箱|收件箱)',
  '(?:查看|查找|搜索|检索|读取|分析|分类|总结|摘要).{0,20}(?:邮件|邮箱|收件箱)',
  '(?:邮件|邮箱|收件箱).{0,20}(?:未读|重要|最近|今天|昨天|来自|收到|有哪些|哪封|分类|总结|摘要)',
  '\b(?:my\s+(?:email|mail|inbox)|search\s+(?:email|mail)|unread\s+(?:email|mail)|email\s+summary)\b'
].join('|'), 'iu')

function normalizeQuestion(value) {
  return String(value ?? '').normalize('NFKC').trim()
}

export function normalizeAssistantTimeZone(
  value,
  fallback = DEFAULT_ASSISTANT_TIME_ZONE
) {
  const candidate = String(value || '').trim() || fallback
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate }).format(0)
    return candidate
  } catch {
    if (candidate === fallback) return DEFAULT_ASSISTANT_TIME_ZONE
    return normalizeAssistantTimeZone(fallback, DEFAULT_ASSISTANT_TIME_ZONE)
  }
}

export function buildAssistantClockContext({
  now = new Date(),
  timeZone = DEFAULT_ASSISTANT_TIME_ZONE
} = {}) {
  const instant = now instanceof Date ? new Date(now.getTime()) : new Date(now)
  if (Number.isNaN(instant.getTime())) {
    throw new TypeError('Assistant clock requires a valid date')
  }
  const normalizedTimeZone = normalizeAssistantTimeZone(timeZone)
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: normalizedTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(instant).map((part) => [part.type, part.value])
  )
  const weekday = new Intl.DateTimeFormat('zh-CN', {
    timeZone: normalizedTimeZone,
    weekday: 'long'
  }).format(instant)

  return {
    instant: instant.toISOString(),
    timeZone: normalizedTimeZone,
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${parts.hour}:${parts.minute}:${parts.second}`,
    weekday
  }
}

export function isAssistantCurrentTimeQuery(question) {
  return CURRENT_TIME_PATTERN.test(normalizeQuestion(question))
}

export function shouldSearchAssistantReminders(question) {
  return EXPLICIT_REMINDER_PATTERN.test(normalizeQuestion(question))
}

export function classifyAssistantIntent(
  question,
  {
    timeZone = DEFAULT_ASSISTANT_TIME_ZONE,
    now = new Date()
  } = {}
) {
  const query = normalizeQuestion(question)
  const createMetaQuestion = isAssistantCreateMetaQuestion(query)
  const nonExecutionContext = isAssistantNonExecutionMutationContext(query)
  const asksForExplanation = createMetaQuestion || nonExecutionContext
  const explicitPrivateScope = EXPLICIT_PRIVATE_SCOPE_PATTERN.test(query)
  const allowPrivateRetrieval = nonExecutionContext
    ? explicitPrivateScope
    : !createMetaQuestion
  const currentDateTime = isAssistantCurrentTimeQuery(query)
  const reminderSearch = allowPrivateRetrieval && shouldSearchAssistantReminders(query)
  const action = ACTION_VERB_PATTERN.test(query)
    && ACTION_TARGET_PATTERN.test(query)
    && isExplicitAssistantMutationRequest(query)
  const webSearch = WEB_RESEARCH_PATTERN.test(query)
  const localSearch = allowPrivateRetrieval && (reminderSearch || LOCAL_SEARCH_PATTERN.test(query))
  const localContextRequested = allowPrivateRetrieval && LOCAL_CONTEXT_PATTERN.test(query) && (
    !action || ACTION_LOCAL_CONTEXT_CUE_PATTERN.test(query)
  )
  const emailSearch = allowPrivateRetrieval
    && EMAIL_SEARCH_PATTERN.test(query)
    && EMAIL_RETRIEVAL_CUE_PATTERN.test(query)

  let type = ASSISTANT_INTENT_TYPES.GENERAL
  if (action) type = ASSISTANT_INTENT_TYPES.ACTION
  else if (currentDateTime) type = ASSISTANT_INTENT_TYPES.CURRENT_TIME
  else if (webSearch) type = ASSISTANT_INTENT_TYPES.WEB_RESEARCH
  else if (localSearch) type = ASSISTANT_INTENT_TYPES.LOCAL_SEARCH

  return {
    type,
    query,
    currentDateTime,
    asksForExplanation,
    nonExecutionContext,
    explicitPrivateScope,
    localSearch,
    webSearch,
    action,
    reminderSearch,
    localContextRequested,
    emailSearch,
    clock: buildAssistantClockContext({ now, timeZone })
  }
}
