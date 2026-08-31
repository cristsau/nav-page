import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  }
  CRC_TABLE[index] = value >>> 0
}

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function writeUInt32(buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset)
}

export function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const supplied of entries) {
    const name = Buffer.from(String(supplied.name), 'utf8')
    const content = Buffer.isBuffer(supplied.content)
      ? supplied.content
      : Buffer.from(String(supplied.content ?? ''), 'utf8')
    const method = supplied.store === true ? 0 : 8
    const encoded = method === 0 ? content : deflateRawSync(content, { level: 9 })
    const flags = 0x0800 | (supplied.encrypted ? 0x0001 : 0)
    const checksum = crc32(content)

    const local = Buffer.alloc(30 + name.length)
    writeUInt32(local, 0, 0x04034b50)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    writeUInt32(local, 14, checksum)
    writeUInt32(local, 18, encoded.length)
    writeUInt32(local, 22, content.length)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    locals.push(local, encoded)

    const central = Buffer.alloc(46 + name.length)
    writeUInt32(central, 0, 0x02014b50)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    writeUInt32(central, 16, checksum)
    writeUInt32(central, 20, encoded.length)
    writeUInt32(central, 24, content.length)
    central.writeUInt16LE(name.length, 28)
    writeUInt32(central, 42, offset)
    name.copy(central, 46)
    centrals.push(central)
    offset += local.length + encoded.length
  }

  const centralDirectory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  writeUInt32(end, 0, 0x06054b50)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  writeUInt32(end, 12, centralDirectory.length)
  writeUInt32(end, 16, offset)
  return Buffer.concat([...locals, centralDirectory, end])
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>`

export function buildDocx(text = 'Hello DOCX') {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    {
      name: 'word/document.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body>
        </w:document>`
    }
  ])
}

export function buildPptx(text = 'Hello PPTX') {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    {
      name: 'ppt/presentation.xml',
      content: `<p:presentation xmlns:p="urn:p" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      content: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml" Type="slide"/></Relationships>`
    },
    {
      name: 'ppt/slides/slide1.xml',
      content: `<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:cSld></p:sld>`
    }
  ])
}

export function buildXlsx(text = 'Hello XLSX') {
  return buildZip([
    { name: '[Content_Types].xml', content: CONTENT_TYPES },
    {
      name: 'xl/workbook.xml',
      content: `<workbook xmlns="urn:x" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inbox" sheetId="1" r:id="rId1"/></sheets></workbook>`
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="worksheet"/></Relationships>`
    },
    {
      name: 'xl/sharedStrings.xml',
      content: `<sst xmlns="urn:x"><si><t>${text}</t></si></sst>`
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: `<worksheet xmlns="urn:x"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`
    }
  ])
}

export function buildPdf(text = 'Hello PDF') {
  const escaped = String(text).replace(/([\\()])/g, '\\$1')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${escaped.length + 34} >>\nstream\nBT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let source = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(source, 'latin1'))
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(source, 'latin1')
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) {
    source += `${String(offset).padStart(10, '0')} 00000 n \n`
  }
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(source, 'latin1')
}
