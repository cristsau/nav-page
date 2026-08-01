import { createHash, randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { withTransaction } from '../db/index.js'
import { registerMediaAsset } from '../lib/mediaAssets.js'
import {
  getImgBedOrigin,
  isAllowedImageMime,
  normalizeNoteAttachments
} from '../lib/noteAttachments.js'

const IMAGE_CONTENT_TYPES = [
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp'
]

function hasPrefix(buffer, bytes, offset = 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + bytes.length) {
    return false
  }

  return bytes.every((byte, index) => buffer[offset + index] === byte)
}

function matchesImageSignature(buffer, mime) {
  switch (mime) {
    case 'image/jpeg':
      return hasPrefix(buffer, [0xff, 0xd8, 0xff])
    case 'image/png':
      return hasPrefix(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/gif':
      return hasPrefix(buffer, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
        || hasPrefix(buffer, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    case 'image/webp':
      return hasPrefix(buffer, [0x52, 0x49, 0x46, 0x46])
        && hasPrefix(buffer, [0x57, 0x45, 0x42, 0x50], 8)
    default:
      return false
  }
}

function extensionForMime(mime) {
  return {
    'image/gif': 'gif',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  }[mime] || 'bin'
}

function normalizeFileName(value, mime) {
  const encoded = String(value || '').trim()
  let decoded = encoded

  try {
    decoded = decodeURIComponent(encoded)
  } catch {
    decoded = encoded
  }

  const baseName = decoded
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    ?.replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 255)

  if (baseName) return baseName

  return `note-image.${extensionForMime(mime)}`
}

function normalizeUploadFolderPrefix(value) {
  const normalized = String(value || 'nav-notes')
    .split('/')
    .map((segment) => segment
      .trim()
      .replace(/[^a-z0-9_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48))
    .filter(Boolean)
    .slice(0, 4)
    .join('/')

  return normalized || 'nav-notes'
}

function createImgBedUploadUrl(userId, uploadedAt) {
  const origin = getImgBedOrigin(config.imgBedBaseUrl)
  if (!origin || !config.imgBedUploadToken) return null

  const userPartition = createHash('sha256')
    .update(String(userId || ''))
    .digest('hex')
    .slice(0, 12)
  const monthPartition = uploadedAt.toISOString().slice(0, 7)
  const uploadFolder = [
    normalizeUploadFolderPrefix(config.imgBedUploadFolder),
    userPartition,
    monthPartition
  ].join('/')
  const url = new URL('/upload', origin)
  url.searchParams.set('returnFormat', 'full')
  url.searchParams.set('uploadNameType', 'origin')
  url.searchParams.set('uploadFolder', uploadFolder)
  return url
}

function normalizeUploadedUrl(value, expectedOrigin) {
  const input = String(value || '').trim()
  if (!input) return ''

  try {
    const url = new URL(input, expectedOrigin)
    if (
      url.protocol !== 'https:'
      || url.origin !== expectedOrigin
      || url.username
      || url.password
      || !url.pathname.startsWith('/file/')
    ) {
      return ''
    }

    return url.toString()
  } catch {
    return ''
  }
}

async function parseImgBedResponse(response, expectedOrigin) {
  let payload

  try {
    payload = await response.json()
  } catch {
    throw new Error('图床返回了无法识别的数据')
  }

  const uploadedUrl = Array.isArray(payload)
    ? normalizeUploadedUrl(payload[0]?.src, expectedOrigin)
    : ''

  if (!uploadedUrl) {
    throw new Error('图床未返回有效的图片地址')
  }

  return uploadedUrl
}

export function registerImageContentTypes(fastify) {
  fastify.addContentTypeParser(
    IMAGE_CONTENT_TYPES,
    { parseAs: 'buffer' },
    (_request, body, done) => done(null, body)
  )
}

export async function uploadImageRequest(request, reply, {
  source = 'note',
  retention = 'auto'
} = {}) {
  const uploadedAt = new Date()
  const uploadUrl = createImgBedUploadUrl(request.currentUser.id, uploadedAt)
  if (!uploadUrl) {
    reply.code(503)
    return { error: '图片上传服务尚未配置' }
  }

  const mime = String(request.headers['content-type'] || '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase()
  const image = request.body

  if (!isAllowedImageMime(mime) || !Buffer.isBuffer(image) || !image.length) {
    reply.code(400)
    return { error: '请选择 JPEG、PNG、WebP 或 GIF 图片' }
  }

  if (image.length > config.imgBedMaxImageBytes) {
    reply.code(413)
    return { error: `图片不能超过 ${Math.ceil(config.imgBedMaxImageBytes / 1024 / 1024)} MiB` }
  }

  if (!matchesImageSignature(image, mime)) {
    reply.code(400)
    return { error: '图片内容与文件类型不匹配' }
  }

  const name = normalizeFileName(request.headers['x-file-name'], mime)
  const storedName = `${randomUUID()}.${extensionForMime(mime)}`
  const form = new FormData()
  form.append('file', new Blob([image], { type: mime }), storedName)

  let upstreamResponse
  try {
    upstreamResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.imgBedUploadToken}`
      },
      body: form,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    })
  } catch (error) {
    request.log.warn({
      error: error?.name || 'UploadError'
    }, 'note image upload request failed')
    reply.code(502)
    return { error: '暂时无法连接图片上传服务，请稍后重试' }
  }

  if (!upstreamResponse.ok) {
    request.log.warn({
      upstreamStatus: upstreamResponse.status
    }, 'note image upload rejected by image bed')
    reply.code(502)
    return { error: `图床上传失败（HTTP ${upstreamResponse.status}）` }
  }

  let url
  try {
    url = await parseImgBedResponse(upstreamResponse, uploadUrl.origin)
  } catch (error) {
    reply.code(502)
    return { error: error.message }
  }

  const attachment = normalizeNoteAttachments([{
    id: randomUUID(),
    url,
    name,
    mime,
    size: image.length,
    createdAt: uploadedAt.toISOString()
  }], {
    allowedOrigin: uploadUrl.origin,
    maxBytes: config.imgBedMaxImageBytes,
    strict: true
  })[0]

  try {
    const asset = await withTransaction((client) => registerMediaAsset(
      client,
      request.currentUser.id,
      attachment,
      {
        source,
        retention,
        state: source === 'note' ? 'orphan' : 'active'
      }
    ))
    reply.code(201)
    return { attachment, assetId: asset.id }
  } catch (error) {
    request.log.error({
      error: error?.code || error?.name || 'MediaRegistrationError'
    }, 'uploaded image could not be registered in media library')
    reply.code(500)
    return {
      error: '图片已上传但未能登记到图片库，请运行图片库对账',
      code: 'media_registration_failed'
    }
  }
}

export default async function noteImagesRoutes(fastify) {
  registerImageContentTypes(fastify)

  fastify.post('/note-images', {
    bodyLimit: config.imgBedMaxImageBytes
  }, async (request, reply) => {
    await fastify.requireAuth(request, reply)
    return uploadImageRequest(request, reply, {
      source: 'note',
      retention: 'auto'
    })
  })
}
