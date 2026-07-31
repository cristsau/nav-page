const MAX_ANALYZED_CHARACTERS = 50_000
const MAX_COPY_TOKENS = 500

function hasOverlap(ranges, start, end) {
  return ranges.some((range) => start < range.end && end > range.start)
}

function addRange(ranges, start, end, value, kind, label, maxRanges = MAX_COPY_TOKENS) {
  if (
    ranges.length >= maxRanges
    ||
    !Number.isInteger(start)
    || !Number.isInteger(end)
    || start < 0
    || end <= start
    || !value
    || hasOverlap(ranges, start, end)
  ) {
    return
  }

  ranges.push({
    start,
    end,
    value,
    kind,
    label
  })
}

function addPatternRanges(ranges, line, pattern, kind, label, options = {}) {
  pattern.lastIndex = 0

  for (const match of line.matchAll(pattern)) {
    const captureIndex = options.captureIndex || 0
    const rawValue = match[captureIndex]
    if (!rawValue) continue

    const offset = captureIndex === 0
      ? 0
      : match[0].lastIndexOf(rawValue)
    let value = rawValue

    if (options.trimTrailingPunctuation) {
      value = trimTrailingUrlPunctuation(value)
    }

    if (!value || (options.validate && !options.validate(value))) {
      continue
    }

    const start = match.index + offset
    addRange(
      ranges,
      start,
      start + value.length,
      value,
      kind,
      label,
      options.maxRanges
    )
  }
}

function addLabeledIdRanges(ranges, line, maxRanges) {
  const patterns = [
    /(?:^|[^\p{L}\p{N}_])((?:身份证(?:号|ID)?|证件(?:号|ID)?|用户ID|设备ID|订单号|工单号|合同号|序列号|设备号|编号|编码|单号))\s*(?:[:：#=]\s*)?([A-Za-z0-9][A-Za-z0-9._/-]{1,})/giu,
    /(?:^|[^\p{L}\p{N}_])(UID|UUID|IMEI|VIN|SN|ID)(?:\s*[:：#=]\s*|\s+)([A-Za-z0-9][A-Za-z0-9._/-]{1,})/giu
  ]

  for (const pattern of patterns) {
    for (const match of line.matchAll(pattern)) {
      const fieldLabel = match[1]
      const value = match[2]
      const identityField = /^(?:身份证|证件)/iu.test(fieldLabel)

      if (identityField && !isValidChineseResidentId(value)) {
        continue
      }

      const start = match.index + match[0].lastIndexOf(value)
      addRange(
        ranges,
        start,
        start + value.length,
        value,
        identityField ? 'identity' : 'id',
        identityField ? '身份证 ID' : fieldLabel.toUpperCase(),
        maxRanges
      )
    }
  }
}

function addStructuredValueRange(ranges, line, maxRanges, namesOnly = false) {
  const target = extractLineCopyTarget(line)
  if (!target || target.label === '整行') return

  const start = line.lastIndexOf(target.value)
  if (start < 0) return

  const isName = /(?:姓名|名称|联系人|公司|企业|机构|项目|服务|用户|账户|账号|主机|容器|目录|方式)/u.test(target.label)
  if (namesOnly !== isName) return

  addRange(
    ranges,
    start,
    start + target.value.length,
    target.value,
    isName ? 'name' : 'field',
    isName ? '名称' : '字段值',
    maxRanges
  )
}

function trimTrailingUrlPunctuation(rawValue) {
  let value = rawValue.replace(/[:：,.;!?，。；！？”’]+$/u, '')
  const pairs = [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['（', '）'],
    ['【', '】'],
    ['《', '》']
  ]

  for (const [opening, closing] of pairs) {
    while (
      value.endsWith(closing)
      && value.split(closing).length > value.split(opening).length
    ) {
      value = value.slice(0, -closing.length)
    }
  }

  return value
}

function isValidIpAddress(value) {
  const [address, port] = value.split(':')
  const octets = address.split('.')

  if (
    octets.length !== 4
    || octets.some((octet) => {
      const number = Number(octet)
      return !Number.isInteger(number) || number < 0 || number > 255
    })
  ) {
    return false
  }

  if (port === undefined) return true

  const portNumber = Number(port)
  return Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
}

function isValidDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
  )
}

function isValidDateOrTimeToken(value) {
  const [datePart, timePart = ''] = value.split(/[T\s]/u, 2)
  const dateParts = datePart.split(/[-/]/u).map(Number)
  if (
    dateParts.length < 2
    || !isValidDate(dateParts[0], dateParts[1], dateParts[2] || 1)
  ) {
    return false
  }

  return !timePart || isValidTimeToken(timePart)
}

function isValidTimeToken(value) {
  const parts = value.split(':').map(Number)
  return (
    (parts.length === 2 || parts.length === 3)
    && parts[0] >= 0
    && parts[0] <= 23
    && parts[1] >= 0
    && parts[1] <= 59
    && (parts.length === 2 || (parts[2] >= 0 && parts[2] <= 59))
  )
}

function isValidChineseResidentId(value) {
  if (value.slice(0, 6) === '000000') return false

  if (/^\d{15}$/.test(value)) {
    const year = Number(`19${value.slice(6, 8)}`)
    const month = Number(value.slice(8, 10))
    const day = Number(value.slice(10, 12))
    const birthDate = new Date(Date.UTC(year, month - 1, day))
    return (
      value.slice(12, 15) !== '000'
      && isValidDate(year, month, day)
      && birthDate <= new Date()
    )
  }

  if (!/^\d{17}[\dXx]$/.test(value)) return false

  const year = Number(value.slice(6, 10))
  const month = Number(value.slice(10, 12))
  const day = Number(value.slice(12, 14))
  const birthDate = new Date(Date.UTC(year, month - 1, day))
  if (
    value.slice(14, 17) === '000'
    || !isValidDate(year, month, day)
    || birthDate > new Date()
  ) {
    return false
  }

  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  const sum = value
    .slice(0, 17)
    .split('')
    .reduce((total, digit, index) => total + Number(digit) * weights[index], 0)

  return checks[sum % 11] === value.at(-1).toUpperCase()
}

function extractLineCopyTarget(line) {
  const trimmed = line.trim()
  if (!trimmed) return null

  const fieldMatch = (
    line.match(/^(\s*(?:[-*•]\s*)?)([^:：\n]{1,32})[:：]\s*(\S(?:.*\S)?)\s*$/u)
    || line.match(/^(\s*(?:[-*•]\s*)?)([^=\n]{1,32})=\s*(\S(?:.*\S)?)\s*$/u)
  )

  if (fieldMatch) {
    const label = fieldMatch[2].trim()
    const value = fieldMatch[3].trim()
    const looksLikeProtocol = /^(?:https?|ftp)$/i.test(label)
    const looksLikeTime = /^\d{1,2}$/.test(label)
    const looksLikeCode = /[{}\[\]"']/u.test(label)

    if (value && !looksLikeProtocol && !looksLikeTime && !looksLikeCode) {
      return {
        label,
        value
      }
    }
  }

  return {
    label: '整行',
    value: trimmed
  }
}

function tokenizeLine(line, maxRanges = MAX_COPY_TOKENS) {
  const ranges = []
  const withLimit = (options = {}) => ({
    ...options,
    maxRanges
  })

  addPatternRanges(
    ranges,
    line,
    /(?:https?:\/\/|www\.)[^\s<>"'，。；、]+/giu,
    'url',
    '网址',
    withLimit({ trimTrailingPunctuation: true })
  )
  addPatternRanges(
    ranges,
    line,
    /\b\d{17}[\dXx]\b|\b\d{15}\b/gu,
    'identity',
    '身份证 ID',
    withLimit({ validate: isValidChineseResidentId })
  )
  addPatternRanges(
    ranges,
    line,
    /\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/giu,
    'id',
    'UUID',
    withLimit()
  )
  addPatternRanges(
    ranges,
    line,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
    'email',
    '邮箱',
    withLimit()
  )
  addPatternRanges(
    ranges,
    line,
    /(?<!@)\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:\/[^\s<>"'，。；、]*)?/giu,
    'url',
    '网址',
    withLimit({ trimTrailingPunctuation: true })
  )
  addPatternRanges(
    ranges,
    line,
    /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/gu,
    'address',
    '地址',
    withLimit({ validate: isValidIpAddress })
  )
  addLabeledIdRanges(ranges, line, maxRanges)
  addStructuredValueRange(ranges, line, maxRanges, true)
  addPatternRanges(
    ranges,
    line,
    /\b\d{4}[-/]\d{1,2}(?:[-/]\d{1,2})?(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?)?\b/gu,
    'date',
    '日期或时间',
    withLimit({ validate: isValidDateOrTimeToken })
  )
  addPatternRanges(
    ranges,
    line,
    /\b\d{1,2}:\d{2}(?::\d{2})?\b/gu,
    'date',
    '时间',
    withLimit({ validate: isValidTimeToken })
  )
  addPatternRanges(
    ranges,
    line,
    /#[0-9]+|\b[0-9]+(?:\.[0-9]+)?\b/gu,
    'number',
    '数字',
    withLimit()
  )
  addStructuredValueRange(ranges, line, maxRanges, false)

  ranges.sort((left, right) => left.start - right.start || left.end - right.end)

  const segments = []
  let cursor = 0

  for (const range of ranges) {
    if (range.start > cursor) {
      segments.push({
        type: 'text',
        value: line.slice(cursor, range.start)
      })
    }

    segments.push({
      type: 'copy',
      value: range.value,
      kind: range.kind,
      label: range.label
    })
    cursor = range.end
  }

  if (cursor < line.length || !segments.length) {
    segments.push({
      type: 'text',
      value: line.slice(cursor)
    })
  }

  return segments
}

export function parseCopyableContent(value) {
  let analyzedCharacters = 0
  let remainingTokens = MAX_COPY_TOKENS

  return String(value ?? '')
    .split('\n')
    .map((line, index) => {
      const charactersLeft = Math.max(0, MAX_ANALYZED_CHARACTERS - analyzedCharacters)
      const analyzedText = line.slice(0, charactersLeft)
      const remainder = line.slice(analyzedText.length)
      const segments = remainingTokens > 0
        ? tokenizeLine(analyzedText, remainingTokens)
        : [{ type: 'text', value: analyzedText }]

      if (remainder && segments.at(-1)?.type === 'copy') {
        const boundaryToken = segments.pop()
        segments.push({
          type: 'text',
          value: boundaryToken.value
        })
      }

      const tokenCount = segments.filter((segment) => segment.type === 'copy').length

      if (remainder) {
        segments.push({
          type: 'text',
          value: remainder
        })
      }

      analyzedCharacters += line.length + 1
      remainingTokens = Math.max(0, remainingTokens - tokenCount)

      return {
        id: index,
        raw: line,
        segments,
        copyTarget: extractLineCopyTarget(line)
      }
    })
}
