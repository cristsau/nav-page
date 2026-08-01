import path from 'node:path'
import { config } from '../config.js'
import { readAiApiKeyFile as readOwnerOnlySecretFile } from './aiProviderConfig.js'
import {
  assertMediaBelongsToUser,
  createMediaUserPrefix,
  encodeUpstreamPath,
  mediaUrlFromUpstreamId,
  normalizeMediaDeletionOutcome,
  normalizeUpstreamId
} from './mediaAssets.js'
import { getImgBedOrigin, isAllowedImageMime } from './noteAttachments.js'

function createLibraryError(message, code, statusCode = 502) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

export async function readImgBedLibraryToken({
  readSecretImpl = readOwnerOnlySecretFile
} = {}) {
  const tokenFile = String(config.imgBedLibraryTokenFile || '').trim()
  if (!tokenFile || !path.isAbsolute(tokenFile)) {
    throw createLibraryError('Image library is not configured', 'library_not_configured', 503)
  }

  let value
  try {
    // Reuse the hardened secret-file reader: absolute regular file, no
    // symlinks, owner-only permissions on Unix, bounded size and race checks.
    value = await readSecretImpl(tokenFile)
  } catch {
    throw createLibraryError('Image library is not configured', 'library_secret_unavailable', 503)
  }

  const token = String(value || '').trim()
  if (!token || token.length > 4096 || /[\r\n]/.test(token)) {
    throw createLibraryError('Image library is not configured', 'library_secret_invalid', 503)
  }
  return token
}

function getLibraryOrigin() {
  const origin = getImgBedOrigin(config.imgBedBaseUrl)
  if (!origin) {
    throw createLibraryError('Image library is not configured', 'library_not_configured', 503)
  }
  return origin
}

async function libraryFetch(url, options, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch
  const token = await readImgBedLibraryToken(dependencies)
  let response
  try {
    response = await fetchImpl(url, {
      ...options,
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options?.headers || {})
      },
      signal: AbortSignal.timeout(20_000)
    })
  } catch (error) {
    throw createLibraryError(
      'Image library upstream request failed',
      error?.name === 'TimeoutError' ? 'library_timeout' : 'library_unreachable'
    )
  }

  if (!response.ok) {
    throw createLibraryError(
      'Image library upstream rejected the request',
      `library_http_${response.status}`,
      response.status === 401 || response.status === 403 ? 503 : 502
    )
  }
  return response
}

function normalizeListedFile(file, userId, origin) {
  const upstreamId = normalizeUpstreamId(file?.name || file?.path || file?.key)
  if (!upstreamId) return null
  try {
    assertMediaBelongsToUser(userId, { upstreamId })
  } catch {
    return null
  }

  const metadata = file?.metadata && typeof file.metadata === 'object'
    ? file.metadata
    : {}
  const mime = String(
    metadata.contentType
    || metadata.content_type
    || metadata.mime
    || metadata.FileType
    || file?.mime
    || ''
  ).trim().toLowerCase()
  const size = Number(metadata.size || metadata.FileSizeBytes || file?.size || 0)
  if (!isAllowedImageMime(mime) || !Number.isSafeInteger(size) || size < 1) {
    return null
  }

  const createdAtValue = metadata.uploadedAt
    || metadata.uploaded_at
    || metadata.createdAt
    || metadata.TimeStamp
    || file?.createdAt
  const createdAtDate = new Date(createdAtValue || 0)
  const createdAt = Number.isNaN(createdAtDate.getTime())
    ? null
    : createdAtDate.toISOString()
  return {
    upstreamId,
    url: mediaUrlFromUpstreamId(upstreamId, origin),
    name: String(metadata.originalName || metadata.name || metadata.FileName || upstreamId.split('/').pop() || 'image')
      .replaceAll('\\', '/')
      .split('/')
      .pop()
      .slice(0, 255),
    mime,
    size,
    createdAt
  }
}

export async function listImgBedUserImages(userId, dependencies = {}) {
  const origin = getLibraryOrigin()
  const prefix = createMediaUserPrefix(userId)
  const files = []
  const pageSize = 100
  const maxFiles = 5000
  let start = 0
  let complete = false

  while (start < maxFiles) {
    const url = new URL('/api/manage/list', origin)
    url.searchParams.set('dir', prefix.replace(/\/$/, ''))
    url.searchParams.set('recursive', 'true')
    url.searchParams.set('start', String(start))
    url.searchParams.set('count', String(pageSize))
    const response = await libraryFetch(url, { method: 'GET' }, dependencies)
    let payload
    try {
      payload = await response.json()
    } catch {
      throw createLibraryError('Image library returned invalid data', 'library_invalid_response')
    }

    const page = Array.isArray(payload?.files) ? payload.files : []
    const reportedTotal = Number(payload?.totalCount)
    const hasReportedTotal = Number.isSafeInteger(reportedTotal) && reportedTotal >= 0
    for (const file of page) {
      const normalized = normalizeListedFile(file, userId, origin)
      if (normalized) files.push(normalized)
    }
    if (!page.length) {
      complete = true
      break
    }
    start += page.length
    if (page.length < pageSize || (hasReportedTotal && start >= reportedTotal)) {
      complete = true
      break
    }
  }

  return { files, complete }
}

export async function deleteImgBedUserImage(upstreamId, userId, dependencies = {}) {
  const scopedId = assertMediaBelongsToUser(userId, { upstreamId })
  const encodedPath = encodeUpstreamPath(scopedId)
  const url = new URL(`/api/manage/delete/${encodedPath}`, getLibraryOrigin())
  const response = await libraryFetch(url, { method: 'DELETE' }, dependencies)
  let payload
  try {
    payload = await response.json()
  } catch {
    throw createLibraryError(
      'Image library returned invalid deletion data',
      'library_invalid_delete_response'
    )
  }

  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || payload.success !== true
    || payload.fileId !== scopedId
  ) {
    throw createLibraryError(
      'Image library returned invalid deletion data',
      'library_invalid_delete_response'
    )
  }

  try {
    return normalizeMediaDeletionOutcome(payload)
  } catch {
    throw createLibraryError(
      'Image library returned invalid deletion data',
      'library_invalid_delete_response'
    )
  }
}
