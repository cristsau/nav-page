import { posix as pathPosix } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'
import { TextDecoder } from 'node:util'
import { SaxesParser } from 'saxes'
import { fromBufferPromise } from 'yauzl'

// Document extraction is deliberately offline. PDF.js is given only in-memory
// bytes and OOXML relationships are inspected before any content is parsed.
globalThis.fetch = async () => {
  throw new Error('Network access is disabled for document extraction')
}

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })
const OFFICE_FORMATS = new Set(['docx', 'pptx', 'xlsx'])
const XML_UNSAFE_PATTERN = /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i
const ABSOLUTE_RELATIONSHIP_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i
const MACRO_PART_PATTERN = /(?:^|\/)(?:vbaProject\.bin|macrosheets\/|xlmMacros\/|_vba_project_cur\/)/i
const EMBEDDED_PART_PATTERN = /(?:^|\/)(?:embeddings|oleObjects|activeX|ctrlProps)(?:\/|$)/i
const EXTERNAL_LINK_PART_PATTERN = /(?:^|\/)externalLinks(?:\/|$)/i
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])

class SafeDocumentError extends Error {
  constructor(message, statusCode, code) {
    super(message)
    this.name = 'SafeDocumentError'
    this.statusCode = statusCode
    this.code = code
  }
}

function fail(message, statusCode, code) {
  throw new SafeDocumentError(message, statusCode, code)
}

function safeInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

const limits = Object.freeze({
  maximumCharacters: safeInteger(workerData?.limits?.maximumCharacters, 12_000),
  maximumArchiveEntries: safeInteger(workerData?.limits?.maximumArchiveEntries, 512),
  maximumArchiveUncompressedBytes: safeInteger(workerData?.limits?.maximumArchiveUncompressedBytes, 32 * 1024 * 1024),
  maximumArchiveEntryBytes: safeInteger(workerData?.limits?.maximumArchiveEntryBytes, 8 * 1024 * 1024),
  maximumCompressionRatio: safeInteger(workerData?.limits?.maximumCompressionRatio, 100),
  maximumPages: safeInteger(workerData?.limits?.maximumPages, 200),
  maximumSlides: safeInteger(workerData?.limits?.maximumSlides, 200),
  maximumSheets: safeInteger(workerData?.limits?.maximumSheets, 64),
  maximumXmlNodes: safeInteger(workerData?.limits?.maximumXmlNodes, 50_000),
  maximumCells: safeInteger(workerData?.limits?.maximumCells, 20_000)
})

function decodeXml(buffer, label) {
  let xml
  try {
    xml = UTF8_DECODER.decode(buffer)
  } catch {
    fail(`${label} 不是有效的 UTF-8 XML`, 422, 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID')
  }
  if (XML_UNSAFE_PATTERN.test(xml)) {
    fail(
      `${label} 包含 DTD、实体或外部样式声明，已停止解析`,
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_UNSAFE_XML'
    )
  }
  return xml
}

function xmlAttribute(node, localName) {
  const expected = String(localName || '').toLowerCase()
  for (const attribute of Object.values(node?.attributes || {})) {
    const local = String(attribute?.local || attribute?.name || '').toLowerCase()
    if (local === expected) return String(attribute?.value ?? '')
  }
  return ''
}

function relationshipIdAttribute(node) {
  for (const attribute of Object.values(node?.attributes || {})) {
    if (String(attribute?.local || '').toLowerCase() !== 'id') continue
    if (String(attribute?.prefix || '').toLowerCase() === 'r'
      || String(attribute?.uri || '').includes('/relationships')) {
      return String(attribute?.value ?? '')
    }
  }
  return ''
}

function parseXml(xml, handlers = {}) {
  const parser = new SaxesParser({ xmlns: true, fragment: false })
  let nodes = 0
  parser.on('doctype', () => fail(
    'OOXML 包含不允许的文档类型声明',
    422,
    'EMAIL_ATTACHMENT_TRANSLATION_UNSAFE_XML'
  ))
  parser.on('opentag', (node) => {
    nodes += 1
    if (nodes > limits.maximumXmlNodes) {
      fail(
        'OOXML XML 节点数量超过安全上限',
        413,
        'EMAIL_ATTACHMENT_TRANSLATION_RESOURCE_LIMIT'
      )
    }
    handlers.open?.(node)
  })
  parser.on('text', (text) => handlers.text?.(text))
  parser.on('closetag', (node) => handlers.close?.(node))
  try {
    parser.write(xml).close()
  } catch (error) {
    if (error instanceof SafeDocumentError) throw error
    fail(
      'OOXML XML 结构无效，已停止解析',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID'
    )
  }
}

function normalizedPartName(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '')
}

function resolveRelationshipPart(baseDirectory, target) {
  const raw = String(target || '').replace(/\\/g, '/')
  if (!raw || ABSOLUTE_RELATIONSHIP_PATTERN.test(raw)) {
    fail(
      'OOXML 包含外部关系目标，已停止解析',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_EXTERNAL_RELATIONSHIP'
    )
  }
  const resolved = pathPosix.normalize(pathPosix.join(baseDirectory, raw))
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) {
    fail(
      'OOXML 关系目标越出文档容器，已停止解析',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_EXTERNAL_RELATIONSHIP'
    )
  }
  return normalizedPartName(resolved)
}

function parseRelationships(xml, baseDirectory) {
  const relationships = new Map()
  parseXml(xml, {
    open(node) {
      if (String(node.local || '').toLowerCase() !== 'relationship') return
      const id = xmlAttribute(node, 'Id')
      const target = xmlAttribute(node, 'Target')
      const targetMode = xmlAttribute(node, 'TargetMode').toLowerCase()
      if (targetMode === 'external' || ABSOLUTE_RELATIONSHIP_PATTERN.test(target)) {
        fail(
          'OOXML 包含外部关系，已停止解析',
          422,
          'EMAIL_ATTACHMENT_TRANSLATION_EXTERNAL_RELATIONSHIP'
        )
      }
      if (id && target) relationships.set(id, resolveRelationshipPart(baseDirectory, target))
    }
  })
  return relationships
}

async function readZipEntry(zipfile, entry) {
  const stream = await zipfile.openReadStreamPromise(entry)
  const chunks = []
  let bytes = 0
  try {
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > limits.maximumArchiveEntryBytes || bytes > Number(entry.uncompressedSize)) {
        stream.destroy()
        fail(
          `OOXML 部件 ${entry.fileName} 解压后超过安全上限`,
          413,
          'EMAIL_ATTACHMENT_TRANSLATION_ARCHIVE_LIMIT'
        )
      }
      chunks.push(Buffer.from(chunk))
    }
  } catch (error) {
    for (const chunk of chunks) chunk.fill(0)
    if (error instanceof SafeDocumentError) throw error
    fail(
      `OOXML 部件 ${entry.fileName} 无法安全解压`,
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID'
    )
  }
  const result = Buffer.concat(chunks, bytes)
  for (const chunk of chunks) chunk.fill(0)
  return result
}

function shouldReadOfficePart(format, name) {
  if (name === '[Content_Types].xml' || name.endsWith('.rels')) return true
  if (format === 'docx') {
    return name === 'word/document.xml'
      || /^word\/(?:header|footer)\d+\.xml$/i.test(name)
      || /^word\/(?:footnotes|endnotes)\.xml$/i.test(name)
  }
  if (format === 'pptx') {
    return name === 'ppt/presentation.xml'
      || /^ppt\/slides\/slide\d+\.xml$/i.test(name)
  }
  return name === 'xl/workbook.xml'
    || name === 'xl/sharedStrings.xml'
    || /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)
}

async function loadOfficeParts(content, format) {
  if (content.subarray(0, OLE_MAGIC.length).equals(OLE_MAGIC)) {
    fail(
      '附件是加密 OOXML 包或旧版 OLE Office 文件，已拒绝解析',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_ENCRYPTED'
    )
  }
  if (!(content[0] === 0x50 && content[1] === 0x4b)) {
    fail(
      'Office 附件不是有效的 Open XML 容器',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID'
    )
  }

  let zipfile
  const parts = new Map()
  const seenPartNames = new Set()
  try {
    zipfile = await fromBufferPromise(content, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    })
    let entryCount = 0
    let totalUncompressed = 0
    for await (const entry of zipfile.eachEntry()) {
      entryCount += 1
      if (entryCount > limits.maximumArchiveEntries) {
        fail(
          'Office 附件包含过多文件，已停止解析',
          413,
          'EMAIL_ATTACHMENT_TRANSLATION_ARCHIVE_LIMIT'
        )
      }
      const name = normalizedPartName(entry.fileName)
      const collisionKey = name.toLowerCase()
      if (seenPartNames.has(collisionKey)) {
        fail(
          `Office 附件包含重复部件 ${name}，已停止解析`,
          422,
          'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID'
        )
      }
      seenPartNames.add(collisionKey)
      const directory = name.endsWith('/')
      const compressedSize = Number(entry.compressedSize)
      const uncompressedSize = Number(entry.uncompressedSize)
      if (![compressedSize, uncompressedSize].every(Number.isSafeInteger)
        || compressedSize < 0 || uncompressedSize < 0) {
        fail(
          'Office 附件包含无效的压缩尺寸',
          422,
          'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID'
        )
      }
      if (entry.isEncrypted?.()) {
        fail(
          'Office 附件已加密，无法在不解密的情况下安全提取',
          422,
          'EMAIL_ATTACHMENT_TRANSLATION_ENCRYPTED'
        )
      }
      if (!directory && !entry.canDecodeFileData?.()) {
        fail(
          'Office 附件使用了不支持的压缩或加密方法',
          422,
          'EMAIL_ATTACHMENT_TRANSLATION_ENCRYPTED'
        )
      }
      if (MACRO_PART_PATTERN.test(name)) {
        fail('Office 附件包含宏，已拒绝解析', 422, 'EMAIL_ATTACHMENT_TRANSLATION_MACRO')
      }
      if (EMBEDDED_PART_PATTERN.test(name)) {
        fail('Office 附件包含嵌入对象或 ActiveX，已拒绝解析', 422, 'EMAIL_ATTACHMENT_TRANSLATION_EMBEDDED_OBJECT')
      }
      if (EXTERNAL_LINK_PART_PATTERN.test(name)) {
        fail('Office 附件包含外部链接部件，已拒绝解析', 422, 'EMAIL_ATTACHMENT_TRANSLATION_EXTERNAL_RELATIONSHIP')
      }
      if (directory) continue
      if (uncompressedSize > limits.maximumArchiveEntryBytes) {
        fail(
          `Office 部件 ${name} 超过单文件安全上限`,
          413,
          'EMAIL_ATTACHMENT_TRANSLATION_ARCHIVE_LIMIT'
        )
      }
      totalUncompressed += uncompressedSize
      if (totalUncompressed > limits.maximumArchiveUncompressedBytes) {
        fail(
          'Office 附件解压后总体积超过安全上限',
          413,
          'EMAIL_ATTACHMENT_TRANSLATION_ARCHIVE_LIMIT'
        )
      }
      if (uncompressedSize > 16 * 1024
        && (uncompressedSize / Math.max(1, compressedSize)) > limits.maximumCompressionRatio) {
        fail(
          `Office 部件 ${name} 的压缩比异常，疑似压缩炸弹`,
          413,
          'EMAIL_ATTACHMENT_TRANSLATION_COMPRESSION_BOMB'
        )
      }
      if (!shouldReadOfficePart(format, name)) continue
      parts.set(name, await readZipEntry(zipfile, entry))
    }
  } catch (error) {
    if (error instanceof SafeDocumentError) throw error
    fail(
      'Office Open XML 容器损坏或使用了不支持的结构',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID'
    )
  } finally {
    try { zipfile?.close?.() } catch {}
  }

  const contentTypes = parts.get('[Content_Types].xml')
  if (!contentTypes) {
    fail('Office Open XML 缺少内容类型清单', 422, 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID')
  }
  const contentTypesXml = decodeXml(contentTypes, '[Content_Types].xml')
  if (/macroEnabled|vbaProject|application\/vnd\.ms-office/i.test(contentTypesXml)) {
    fail('Office 附件声明了宏或活动内容，已拒绝解析', 422, 'EMAIL_ATTACHMENT_TRANSLATION_MACRO')
  }
  for (const [name, buffer] of parts) {
    if (!name.endsWith('.rels')) continue
    const baseDirectory = name.endsWith('/_rels/.rels')
      ? name.slice(0, -'/_rels/.rels'.length)
      : name === '_rels/.rels'
        ? ''
        : pathPosix.dirname(pathPosix.dirname(name))
    parseRelationships(decodeXml(buffer, name), baseDirectory)
  }
  return parts
}

function appendBoundedSection(sections, type, label, index, value) {
  const text = String(value || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) return
  const block = `[${label}]\n${text}`
  const currentLength = sections.reduce((sum, section) => sum + section.block.length + 2, 0)
  if ((currentLength + block.length) > limits.maximumCharacters) {
    fail(
      `文档提取正文超过 ${limits.maximumCharacters.toLocaleString('en-US')} 个字符`,
      413,
      'EMAIL_ATTACHMENT_TRANSLATION_TEXT_TOO_LARGE'
    )
  }
  sections.push({
    block,
    unit: { type, label, index, characters: text.length }
  })
}

function finalizeSections(format, sections) {
  if (!sections.length) {
    fail(
      '文档没有可提取的文本层；当前安全模式不执行 OCR',
      422,
      'EMAIL_ATTACHMENT_TRANSLATION_NO_TEXT_LAYER'
    )
  }
  return {
    format,
    text: sections.map((section) => section.block).join('\n\n'),
    sourceUnits: sections.map((section) => section.unit)
  }
}

function extractParagraphs(xml, label) {
  const paragraphs = []
  let current = []
  let textDepth = 0
  parseXml(xml, {
    open(node) {
      const local = String(node.local || '').toLowerCase()
      if (local === 'p' && current.length) {
        const residual = current.join('').trim()
        if (residual) paragraphs.push(residual)
        current = []
      }
      if (local === 't') textDepth += 1
      if (local === 'tab') current.push('\t')
      if (local === 'br' || local === 'cr') current.push('\n')
    },
    text(value) {
      if (textDepth > 0) current.push(value)
    },
    close(node) {
      const local = String(node.local || '').toLowerCase()
      if (local === 't') textDepth = Math.max(0, textDepth - 1)
      if (local === 'p') {
        const paragraph = current.join('').trim()
        if (paragraph) paragraphs.push(paragraph)
        current = []
        if (paragraphs.length > limits.maximumXmlNodes) {
          fail(`${label} 段落数量超过安全上限`, 413, 'EMAIL_ATTACHMENT_TRANSLATION_RESOURCE_LIMIT')
        }
      }
    }
  })
  const residual = current.join('').trim()
  if (residual) paragraphs.push(residual)
  return paragraphs.join('\n')
}

function numericPartSort(pattern) {
  return (left, right) => {
    const leftNumber = Number(left.match(pattern)?.[1] || 0)
    const rightNumber = Number(right.match(pattern)?.[1] || 0)
    return leftNumber - rightNumber || left.localeCompare(right)
  }
}

function extractDocx(parts) {
  const main = parts.get('word/document.xml')
  if (!main) fail('DOCX 缺少 word/document.xml', 422, 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID')
  const sections = []
  appendBoundedSection(sections, 'document', '文档正文', 1, extractParagraphs(decodeXml(main, 'word/document.xml'), '文档正文'))

  const supplemental = [...parts.keys()]
    .filter((name) => /^word\/(?:header|footer)\d+\.xml$/i.test(name)
      || /^word\/(?:footnotes|endnotes)\.xml$/i.test(name))
    .sort(numericPartSort(/(\d+)\.xml$/i))
  let index = 1
  for (const name of supplemental) {
    const base = pathPosix.basename(name, '.xml')
    const label = base.startsWith('header')
      ? `页眉 ${base.replace(/\D/g, '') || index}`
      : base.startsWith('footer')
        ? `页脚 ${base.replace(/\D/g, '') || index}`
        : base === 'footnotes' ? '脚注' : '尾注'
    appendBoundedSection(
      sections,
      base.startsWith('header') ? 'header' : base.startsWith('footer') ? 'footer' : 'note',
      label,
      index,
      extractParagraphs(decodeXml(parts.get(name), name), label)
    )
    index += 1
  }
  return finalizeSections('docx', sections)
}

function orderedPresentationSlides(parts) {
  const presentation = parts.get('ppt/presentation.xml')
  const relationships = parts.get('ppt/_rels/presentation.xml.rels')
  if (!presentation || !relationships) {
    return [...parts.keys()]
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
      .sort(numericPartSort(/slide(\d+)\.xml$/i))
  }
  const relationMap = parseRelationships(
    decodeXml(relationships, 'ppt/_rels/presentation.xml.rels'),
    'ppt'
  )
  const ids = []
  parseXml(decodeXml(presentation, 'ppt/presentation.xml'), {
    open(node) {
      if (String(node.local || '').toLowerCase() !== 'sldid') return
      const id = relationshipIdAttribute(node)
      if (id) ids.push(id)
    }
  })
  return ids.map((id) => relationMap.get(id)).filter((name) => parts.has(name))
}

function extractPptx(parts) {
  const slideNames = orderedPresentationSlides(parts)
  if (!slideNames.length) fail('PPTX 没有可读取的幻灯片', 422, 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID')
  if (slideNames.length > limits.maximumSlides) {
    fail('PPTX 幻灯片数量超过安全上限', 413, 'EMAIL_ATTACHMENT_TRANSLATION_RESOURCE_LIMIT')
  }
  const sections = []
  for (let index = 0; index < slideNames.length; index += 1) {
    const name = slideNames[index]
    appendBoundedSection(
      sections,
      'slide',
      `幻灯片 ${index + 1}`,
      index + 1,
      extractParagraphs(decodeXml(parts.get(name), name), `幻灯片 ${index + 1}`)
    )
  }
  return finalizeSections('pptx', sections)
}

function extractSharedStrings(buffer) {
  if (!buffer) return []
  const strings = []
  let current = []
  let inText = 0
  parseXml(decodeXml(buffer, 'xl/sharedStrings.xml'), {
    open(node) {
      const local = String(node.local || '').toLowerCase()
      if (local === 'si') current = []
      if (local === 't') inText += 1
    },
    text(value) {
      if (inText > 0) current.push(value)
    },
    close(node) {
      const local = String(node.local || '').toLowerCase()
      if (local === 't') inText = Math.max(0, inText - 1)
      if (local === 'si') strings.push(current.join(''))
    }
  })
  return strings
}

function extractWorksheet(xml, sharedStrings, label) {
  const cells = []
  let cell = null
  let inValue = 0
  let inInlineText = 0
  parseXml(xml, {
    open(node) {
      const local = String(node.local || '').toLowerCase()
      if (local === 'c') {
        if (cells.length >= limits.maximumCells) {
          fail(`${label} 单元格数量超过安全上限`, 413, 'EMAIL_ATTACHMENT_TRANSLATION_RESOURCE_LIMIT')
        }
        cell = {
          reference: xmlAttribute(node, 'r').slice(0, 32),
          type: xmlAttribute(node, 't').toLowerCase(),
          value: [],
          inline: []
        }
      }
      if (cell && local === 'v') inValue += 1
      if (cell && local === 't') inInlineText += 1
    },
    text(value) {
      if (!cell) return
      if (inValue > 0) cell.value.push(value)
      if (inInlineText > 0) cell.inline.push(value)
    },
    close(node) {
      const local = String(node.local || '').toLowerCase()
      if (local === 'v') inValue = Math.max(0, inValue - 1)
      if (local === 't') inInlineText = Math.max(0, inInlineText - 1)
      if (local !== 'c' || !cell) return
      const raw = cell.value.join('').trim()
      let value = cell.inline.join('').trim()
      if (!value && cell.type === 's') {
        const sharedIndex = Number(raw)
        value = Number.isSafeInteger(sharedIndex) && sharedIndex >= 0
          ? String(sharedStrings[sharedIndex] ?? '')
          : ''
      } else if (!value && cell.type === 'b') {
        value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw
      } else if (!value) {
        value = raw
      }
      if (value) cells.push(`${cell.reference || `单元格 ${cells.length + 1}`}: ${value}`)
      cell = null
    }
  })
  return cells.join('\n')
}

function orderedWorkbookSheets(parts) {
  const workbook = parts.get('xl/workbook.xml')
  const relationships = parts.get('xl/_rels/workbook.xml.rels')
  if (!workbook || !relationships) {
    return [...parts.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .sort(numericPartSort(/sheet(\d+)\.xml$/i))
      .map((name, index) => ({ name: `工作表 ${index + 1}`, part: name }))
  }
  const relationMap = parseRelationships(
    decodeXml(relationships, 'xl/_rels/workbook.xml.rels'),
    'xl'
  )
  const sheets = []
  parseXml(decodeXml(workbook, 'xl/workbook.xml'), {
    open(node) {
      if (String(node.local || '').toLowerCase() !== 'sheet') return
      const id = relationshipIdAttribute(node)
      const name = xmlAttribute(node, 'name').trim().slice(0, 120)
      const part = relationMap.get(id)
      if (part && parts.has(part)) sheets.push({ name: name || `工作表 ${sheets.length + 1}`, part })
    }
  })
  return sheets
}

function extractXlsx(parts) {
  const sheets = orderedWorkbookSheets(parts)
  if (!sheets.length) fail('XLSX 没有可读取的工作表', 422, 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID')
  if (sheets.length > limits.maximumSheets) {
    fail('XLSX 工作表数量超过安全上限', 413, 'EMAIL_ATTACHMENT_TRANSLATION_RESOURCE_LIMIT')
  }
  const sharedStrings = extractSharedStrings(parts.get('xl/sharedStrings.xml'))
  const sections = []
  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index]
    const label = `工作表 ${index + 1}：${sheet.name}`
    appendBoundedSection(
      sections,
      'sheet',
      label,
      index + 1,
      extractWorksheet(decodeXml(parts.get(sheet.part), sheet.part), sharedStrings, label)
    )
  }
  return finalizeSections('xlsx', sections)
}

function pdfText(items) {
  const output = []
  for (const item of items || []) {
    const value = String(item?.str || '')
    if (value) output.push(value)
    if (item?.hasEOL) output.push('\n')
    else if (value) output.push(' ')
  }
  return output.join('').replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
}

function outlineHasExternalTarget(items) {
  for (const item of items || []) {
    if (item?.url || item?.unsafeUrl || item?.action) return true
    if (outlineHasExternalTarget(item?.items)) return true
  }
  return false
}

async function extractPdf(content) {
  const header = content.subarray(0, Math.min(content.length, 1024)).toString('latin1')
  if (!/^\s*%PDF-/i.test(header)) {
    fail('PDF 文件头无效', 422, 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID')
  }
  const encryptedScan = content.subarray(0, Math.min(content.length, 1024 * 1024)).toString('latin1')
  if (/\/Encrypt\b/.test(encryptedScan)) {
    fail('PDF 已加密，无法安全提取', 422, 'EMAIL_ATTACHMENT_TRANSLATION_ENCRYPTED')
  }

  let loadingTask
  let document
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
      disableWorker: true,
      disableFontFace: true,
      isEvalSupported: false,
      useSystemFonts: false,
      useWasm: false,
      verbosity: 0
    })
    document = await loadingTask.promise
    if (document.numPages > limits.maximumPages) {
      fail('PDF 页数超过安全上限', 413, 'EMAIL_ATTACHMENT_TRANSLATION_RESOURCE_LIMIT')
    }
    const scripts = typeof document.getJavaScript === 'function' ? await document.getJavaScript() : []
    const actions = typeof document.getJSActions === 'function' ? await document.getJSActions() : null
    if ((Array.isArray(scripts) && scripts.some(Boolean)) || (actions && Object.keys(actions).length)) {
      fail('PDF 包含 JavaScript 或活动动作，已拒绝解析', 422, 'EMAIL_ATTACHMENT_TRANSLATION_MACRO')
    }
    const attachments = typeof document.getAttachments === 'function' ? await document.getAttachments() : null
    if (attachments && Object.keys(attachments).length) {
      fail('PDF 包含嵌入附件，已拒绝解析', 422, 'EMAIL_ATTACHMENT_TRANSLATION_EMBEDDED_OBJECT')
    }
    const outline = typeof document.getOutline === 'function' ? await document.getOutline() : null
    if (outlineHasExternalTarget(outline)) {
      fail('PDF 包含外部链接或动作，已拒绝解析', 422, 'EMAIL_ATTACHMENT_TRANSLATION_EXTERNAL_RELATIONSHIP')
    }

    const sections = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      try {
        const annotations = await page.getAnnotations({ intent: 'display' })
        if (annotations.some((annotation) => annotation?.url
          || annotation?.unsafeUrl
          || annotation?.action
          || annotation?.attachment
          || annotation?.file
          || annotation?.richMedia)) {
          fail('PDF 页面包含外部链接、动作或嵌入对象，已拒绝解析', 422, 'EMAIL_ATTACHMENT_TRANSLATION_EXTERNAL_RELATIONSHIP')
        }
        const textContent = await page.getTextContent({ disableNormalization: false })
        appendBoundedSection(
          sections,
          'page',
          `PDF 第 ${pageNumber} 页`,
          pageNumber,
          pdfText(textContent.items)
        )
      } finally {
        page.cleanup?.()
      }
    }
    return finalizeSections('pdf', sections)
  } catch (error) {
    if (error instanceof SafeDocumentError) throw error
    if (error?.name === 'PasswordException' || Number(error?.code) === 1 || Number(error?.code) === 2) {
      fail('PDF 已加密，无法安全提取', 422, 'EMAIL_ATTACHMENT_TRANSLATION_ENCRYPTED')
    }
    fail('PDF 损坏或无法安全读取文本层', 422, 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID')
  } finally {
    try { await document?.destroy?.() } catch {}
    try { await loadingTask?.destroy?.() } catch {}
  }
}

async function extractOffice(content, format) {
  const parts = await loadOfficeParts(content, format)
  try {
    if (format === 'docx') return extractDocx(parts)
    if (format === 'pptx') return extractPptx(parts)
    return extractXlsx(parts)
  } finally {
    for (const buffer of parts.values()) buffer.fill(0)
  }
}

async function main() {
  const format = String(workerData?.format || '').toLowerCase()
  const content = Buffer.from(workerData?.content || new ArrayBuffer(0))
  try {
    if (!content.length) fail('附件内容为空', 422, 'EMAIL_ATTACHMENT_TRANSLATION_EMPTY')
    const result = format === 'pdf'
      ? await extractPdf(content)
      : OFFICE_FORMATS.has(format)
        ? await extractOffice(content, format)
        : fail('附件格式不受支持', 415, 'EMAIL_ATTACHMENT_TRANSLATION_UNSUPPORTED_TYPE')
    parentPort.postMessage({ ok: true, ...result })
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      message: error?.message || '文档无法安全解析',
      statusCode: Number(error?.statusCode) || 422,
      code: error?.code || 'EMAIL_ATTACHMENT_TRANSLATION_DOCUMENT_INVALID'
    })
  } finally {
    // PDF.js may transfer the ArrayBuffer to its internal worker, detaching it.
    // A detached buffer no longer contains readable plaintext and cannot be filled.
    try { content.fill(0) } catch {}
  }
}

void main()
