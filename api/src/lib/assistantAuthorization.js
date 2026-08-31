const CREATE_ACTION_PATTERN = /(?:创建|新建|添加|保存|收藏|记录|写(?:一篇|一个|条)?|create|add|save|bookmark|write)/iu
const MUTATION_ACTION_PATTERN = /(?:创建|新建|添加|保存|收藏|记录|写(?:一篇|一个|条)?|修改|更新|编辑|移动|删除|归档|置顶|标记|发送|回复|create|add|save|bookmark|write|update|edit|move|delete|archive|pin|send|reply)/iu
const CREATE_TARGET_PATTERNS = Object.freeze({
  create_diary: /(?:日记|日志|diary|journal)/iu,
  create_memo: /(?:备忘录|备忘|待办|memo|todo)/iu,
  create_bookmark: /(?:导航|书签|收藏|网页|网址|链接|网站|\b(?:bookmark|favorite|url|link|website|webpage)\b)/iu,
  create_group: /(?:分组|分类|group|category)/iu,
  advanced: /(?:笔记|分享|邮件草稿|草稿|数据库|数据表|记录|note|share|draft|database|row)/iu
})

const NEGATED_MUTATION_PATTERN = /(?:不要|别(?:再)?|无需|不需要|禁止|取消|do\s+not|don't|dont|never)\s*.{0,24}(?:创建|新建|添加|保存|收藏|记录|写|修改|更新|编辑|移动|删除|归档|置顶|标记|发送|回复|create|add|save|bookmark|write|update|edit|move|delete|archive|pin|send|reply)/iu

const NON_EXECUTION_OPERATOR_PATTERN = /(?:翻译|译成|翻成|改写|重写|润色|总结|概括|解释|说明|引用|摘录|复述|转述|举例|举(?:一个|个)?例子|示例|例句|例子|为例|造句|\b(?:translate|rewrite|rephrase|paraphrase|summari[sz]e|explain|quote|cite|give\s+(?:an?\s+)?example)\b)/iu
const STARTS_WITH_NON_EXECUTION_REQUEST_PATTERN = /^(?:(?:请(?:你)?(?:帮我)?|帮我|替我|给我|麻烦(?:你)?(?:帮我)?|please)\s*)?(?:翻译|译成|翻成|改写|重写|润色|总结|概括|解释|说明|引用|摘录|复述|转述|举例|举(?:一个|个)?例子|示例|例句|造句|translate|rewrite|rephrase|paraphrase|summari[sz]e|explain|quote|cite|give\s+(?:an?\s+)?example)/iu
const NON_EXECUTION_TEXT_MARKER_PATTERN = /(?:这(?:句|句话|段话|段文字|个短语|个命令|个表达)|以下(?:句子|文字|短语|命令|表达)|作为(?:示例|例句)|(?:一个|一条|以下)?(?:示例|例句|例子)|为例|\b(?:this|the|following)\s+(?:phrase|sentence|command|expression|text|example)\b)/iu
const EXPLICIT_COMPOUND_EXECUTION_PATTERN = /(?:并|然后|再|接着|随后|and\s+then|then)\s*(?:请(?:你)?(?:帮我)?|帮我|替我|给我|please\s+)?(?:创建|新建|添加|保存|收藏|记录|写|修改|更新|编辑|移动|删除|归档|置顶|标记|发送|回复|create|add|save|bookmark|write|update|edit|move|delete|archive|pin|send|reply)/iu
const MUTATION_TEXT_OBJECT_PATTERN = /(?:把|将)\s*(?:这(?:句|句话|个短语|个命令|个表达)\s*)?(?:创建|新建|添加|保存|收藏|记录|写|修改|更新|编辑|移动|删除|发送|回复)(?:(?!(?:并|然后|再|接着|随后)).){0,48}(?:日记|日志|备忘录|备忘|待办|导航|书签|收藏|网页|网址|链接|网站|分组|分类)(?:(?!(?:并|然后|再|接着|随后)).){0,48}(?:翻译|译成|翻成|改写|重写|润色|总结|概括|解释|说明|引用|摘录|复述|转述|举例|示例|例句|造句)/iu

// Meta questions can contain every word of a write command, but still do not
// authorize execution. Ambiguity is deliberately resolved toward no write.
const CREATE_META_QUESTION_PATTERN = new RegExp([
  '怎么',
  '如何',
  '怎样',
  '为什么',
  '为何',
  '教程',
  '步骤',
  '方法',
  '说明',
  '解释',
  '介绍',
  '什么意思',
  '是什么',
  '什么是',
  '会发生什么',
  '会怎么样',
  '会怎样',
  '有什么作用',
  '是否支持',
  '是否能',
  '请问',
  '(?:你|它|助理|助手|ai)\\s*(?:能|可以|会).{0,24}(?:创建|新建|添加|保存|收藏|记录|写|修改|更新|编辑|移动|删除|发送)',
  '(?:你|它|助理|助手|ai)\\s*(?:能|可以|会)(?![^，。！？]{0,8}(?:帮我|替我|给我)).{0,32}(?:导航|书签|笔记|日记|备忘录|提醒|待办|分组|邮件|邮箱).{0,8}吗',
  '^(?:能|可以|会)(?!\\s*(?:帮我|替我|给我)).{0,24}(?:创建|新建|添加|保存|收藏|记录|写|修改|更新|编辑|移动|删除|发送).{0,8}吗',
  '(?:能不能|可不可以|是否可以)\\s*(?:创建|新建|添加|保存|收藏|记录|写)',
  '(?:我想|我要|请(?:你)?|帮我|麻烦(?:你)?(?:帮我)?|给我)?\\s*(?:知道|了解|确认|判断|咨询|问|看看|核对).{0,40}(?:是否|是不是|会不会|能不能|可不可以|支不支持|支持|自动|会|能|可以).{0,40}(?:创建|新建|添加|保存|收藏|记录|写|修改|更新|编辑|移动|删除|发送|回复)',
  '(?:是否|是不是|会不会|能不能|可不可以|支不支持).{0,40}(?:创建|新建|添加|保存|收藏|记录|写|修改|更新|编辑|移动|删除|发送|回复)',
  '(?:系统|应用|软件|功能|网站|页面|服务|这个|当前).{0,40}(?:是否|是不是|会不会|能不能|可不可以|支不支持|支持|自动|会|能|可以).{0,40}(?:创建|新建|添加|保存|收藏|记录|写|修改|更新|编辑|移动|删除|发送|回复).{0,12}(?:吗|呢|么|吧|\\?|？)',
  '需要什么',
  '要什么条件',
  '告诉我.{0,24}(?:怎么|如何|怎样|步骤|方法)',
  '教(?:我|一下).{0,24}(?:怎么|如何|怎样|创建|新建|添加|保存)',
  '\\bhow\\s+(?:(?:do|can|should)\\s+i|to|create|add|save|write)\\b',
  '\\b(?:explain|describe|introduce|tutorial|guide)\\b',
  '\\bwhat\\s+(?:does|happens|is\\s+needed)\\b',
  '\\bis\\s+it\\s+(?:possible|supported)\\b',
  '\\bcan\\s+you\\s+(?:create|add|save|write)\\b',
  '\\bcan\\s+you(?!\\s+(?:please|help\\s+me)).{0,40}\\b(?:bookmark|note|diary|memo|reminder|todo|group|email|mail|inbox)\\b',
  '\\b(?:tell|show)\\s+me\\s+how\\b'
].join('|'), 'iu')

const DIRECT_CREATE_CUE_PATTERN = new RegExp([
  '(?:^|[，。！？,.!?\\s])(?:现在\\s*)?(?:请(?:你)?(?:帮我|替我)?|帮我|替我|给我|(?:可以|能|能否|可否)(?:请)?帮我|麻烦(?:你)?(?:帮我)?|直接|立即|我要|我想(?:要)?|把)',
  '(?:并|然后|再|接着)\\s*(?:请(?:你)?|帮我|替我)?\\s*(?=创建|新建|添加|保存|收藏|记录|写|修改|更新|编辑|移动|删除|归档|置顶|标记|发送|回复)',
  "(?:^|[,.!?\\s])(?:please|i\\s+want\\s+you\\s+to|do\\s+this\\s+now|let(?:'s|\\s+us))"
].join('|'), 'iu')

const STARTS_WITH_MUTATION_ACTION_PATTERN = /^(?:创建|新建|添加|保存|收藏|记录|写(?:一篇|一个|条)?|修改|更新|编辑|移动|删除|归档|置顶|标记|发送|回复|(?:create|add|save|bookmark|write|update|edit|move|delete|archive|pin|send|reply)\b)/iu

function normalizeCommand(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase()
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^$()|[\]\\{}]/g, '\\$&')
}

function hasQuotedMutationText(command) {
  const quotePatterns = [
    /“([^”]{1,240})”/gu,
    /‘([^’]{1,240})’/gu,
    /"([^"\r\n]{1,240})"/gu,
    /'([^'\r\n]{1,240})'/gu
  ]
  return quotePatterns.some((pattern) => Array.from(command.matchAll(pattern)).some((match) => (
    MUTATION_ACTION_PATTERN.test(match[1])
      && Object.values(CREATE_TARGET_PATTERNS).some((targetPattern) => targetPattern.test(match[1]))
  )))
}

export function isAssistantNonExecutionMutationContext(commandText) {
  const command = normalizeCommand(commandText)
  if (EXPLICIT_COMPOUND_EXECUTION_PATTERN.test(command)) return false
  if (!MUTATION_ACTION_PATTERN.test(command)) return false
  if (!Object.values(CREATE_TARGET_PATTERNS).some((pattern) => pattern.test(command))) return false
  if (STARTS_WITH_NON_EXECUTION_REQUEST_PATTERN.test(command)) return true
  if (MUTATION_TEXT_OBJECT_PATTERN.test(command)) return true
  if (NON_EXECUTION_TEXT_MARKER_PATTERN.test(command) && NON_EXECUTION_OPERATOR_PATTERN.test(command)) return true
  return hasQuotedMutationText(command) && NON_EXECUTION_OPERATOR_PATTERN.test(command)
}

export function isAssistantCreateMetaQuestion(commandText) {
  return CREATE_META_QUESTION_PATTERN.test(normalizeCommand(commandText))
}

export function isExplicitAssistantCreateRequest(commandText) {
  const command = normalizeCommand(commandText)
  return CREATE_ACTION_PATTERN.test(command) && isExplicitAssistantMutationRequest(command)
}

export function isExplicitAssistantMutationRequest(commandText) {
  const command = normalizeCommand(commandText)
  if (!command || command.length > 2_000) return false
  if (NEGATED_MUTATION_PATTERN.test(command)
    || CREATE_META_QUESTION_PATTERN.test(command)
    || isAssistantNonExecutionMutationContext(command)) return false
  if (!MUTATION_ACTION_PATTERN.test(command)) return false
  if (!Object.values(CREATE_TARGET_PATTERNS).some((pattern) => pattern.test(command))) return false
  return DIRECT_CREATE_CUE_PATTERN.test(command)
    || STARTS_WITH_MUTATION_ACTION_PATTERN.test(command)
}

export function isExplicitAssistantCreateCommand(commandText, toolName) {
  return selectExplicitAssistantCreateTool(commandText) === toolName
}

export function selectExplicitAssistantCreateTool(commandText) {
  const command = normalizeCommand(commandText)
  if (!isExplicitAssistantCreateRequest(command)) return ''
  if (CREATE_TARGET_PATTERNS.create_diary.test(command)) return 'create_diary'
  if (CREATE_TARGET_PATTERNS.create_memo.test(command)) return 'create_memo'

  const createsBookmarkObject = /(?:创建|新建|添加|保存|收藏|记录)\s*.{0,18}(?:书签|网页|网址|链接|网站|\b(?:bookmark|favorite|url|link|website|webpage)\b)/iu.test(command)
    || /(?:书签|网页|网址|链接|网站|\b(?:bookmark|favorite|url|link|website|webpage)\b).{0,24}(?:添加到|保存到|放到|存到|add\s+to|save\s+to)/iu.test(command)
  if (createsBookmarkObject) return 'create_bookmark'

  const createsGroup = /(?:创建|新建|新增).{0,20}(?:分组|分类|\b(?:group|category)\b)/iu.test(command)
    || /添加\s*(?:一个|新的|新建的)\s*(?:分组|分类)/iu.test(command)
  if (createsGroup) return 'create_group'
  if (CREATE_TARGET_PATTERNS.create_bookmark.test(command)) return 'create_bookmark'
  return ''
}

export function selectExplicitAssistantAdvancedTool(commandText) {
  const command = normalizeCommand(commandText)
  if (!isExplicitAssistantMutationRequest(command)) return ''
  const matches = []
  const add = (tool, action, target) => {
    if (action.test(command) && target.test(command)) matches.push(tool)
  }
  add('send_email_draft', /(?:发送|寄出|send)/iu, /(?:邮件草稿|草稿邮件|邮件|email|draft)/iu)
  add('create_email_draft', /(?:创建|新建|保存|起草|create|save|draft)/iu, /(?:邮件草稿|草稿邮件|email\s+draft|mail\s+draft)/iu)
  add('revoke_note_share', /(?:撤销|关闭|取消|revoke|disable)/iu, /(?:笔记)?分享|share/iu)
  add('create_note_share', /(?:创建|开启|公开|分享|create|enable|share)/iu, /(?:笔记.{0,12}分享|分享.{0,12}笔记|note\s+share)/iu)
  add('archive_database_row', /(?:归档|archive)/iu, /(?:数据库|数据表).{0,16}(?:记录|行)|(?:记录|行).{0,16}(?:数据库|数据表)|database\s+row/iu)
  add('create_database_row', /(?:创建|新建|添加|新增|create|add)/iu, /(?:数据库|数据表).{0,16}(?:记录|行)|(?:记录|行).{0,16}(?:数据库|数据表)|database\s+row/iu)
  add('update_database_row', /(?:修改|更新|编辑|update|edit)/iu, /(?:数据库|数据表).{0,16}(?:记录|行)|(?:记录|行).{0,16}(?:数据库|数据表)|database\s+row/iu)
  add('delete_note', /(?:删除|delete)/iu, /(?:笔记|note)/iu)
  add('update_note', /(?:修改|更新|编辑|update|edit)/iu, /(?:笔记|note)/iu)
  add('delete_bookmark', /(?:删除|delete)/iu, /(?:书签|bookmark)/iu)
  add('update_bookmark', /(?:修改|更新|编辑|移动|update|edit|move)/iu, /(?:书签|bookmark)/iu)
  add('delete_group', /(?:删除|delete)/iu, /(?:分组|分类|group|category)/iu)
  add('update_group', /(?:修改|更新|编辑|update|edit)/iu, /(?:分组|分类|group|category)/iu)
  const unique = [...new Set(matches)]
  return unique.length === 1 ? unique[0] : ''
}

export function selectAssistantBookmarkGroup(groups, commandText) {
  const command = normalizeCommand(commandText)
  const candidates = (Array.isArray(groups) ? groups : [])
    .filter((group) => group?.id && String(group?.name || '').trim())
    .sort((left, right) => String(right.name).length - String(left.name).length)
  const explicitlyRequested = /(?:分组|分类|\b(?:group|category)\b)/iu.test(command)

  for (const group of candidates) {
    const escapedName = escapeRegExp(normalizeCommand(group.name))
    const namedGroup = new RegExp([
      escapedName + '\\s*(?:分组|分类|\\b(?:group|category)\\b)',
      "(?:分组|分类|\\b(?:group|category)\\b)\\s*[\"'“”]?" + escapedName,
      "(?:保存|存|放|添加|收藏|save|add).{0,16}(?:到|进|至|to)\\s*[\"'“”]?" + escapedName
        + '(?:\\s*(?:分组|分类|\\b(?:group|category)\\b))?'
    ].join('|'), 'iu')
    if (namedGroup.test(command)) {
      return { group, explicitlyRequested: true }
    }
  }

  return { group: null, explicitlyRequested }
}
