import { apiRequest as request } from '@/shared/services/apiClient'

function imagePath(imageId, suffix = '') {
  const id = encodeURIComponent(String(imageId || ''))
  if (!id) throw new Error('图片 ID 不能为空')
  return `/media/images/${id}${suffix}`
}

function imageFromMutationPayload(payload = {}) {
  const image = payload.image || payload.item || null
  if (!image) return null
  return {
    ...image,
    deletion: payload.deletion || image.deletion || null
  }
}

export async function fetchMediaImages({
  filter = 'all',
  query = '',
  cursor = '',
  limit = 24
} = {}) {
  const search = new URLSearchParams()
  search.set('filter', filter)
  search.set('limit', String(limit))
  if (query.trim()) search.set('q', query.trim())
  if (cursor) search.set('cursor', cursor)

  const payload = await request(`/media/images?${search.toString()}`, { method: 'GET' })
  return {
    images: payload.images || payload.items || [],
    nextCursor: payload.nextCursor || payload.cursor || '',
    counts: payload.counts || null
  }
}

export async function updateMediaRetention(imageId, retention) {
  const payload = await request(imagePath(imageId, '/retention'), {
    method: 'PATCH',
    body: JSON.stringify({ retention })
  })
  return imageFromMutationPayload(payload)
}

export async function deleteMediaImage(imageId) {
  const payload = await request(imagePath(imageId), { method: 'DELETE' })
  return imageFromMutationPayload(payload)
}

export async function retryMediaDelete(imageId) {
  const payload = await request(imagePath(imageId, '/retry-delete'), {
    method: 'POST',
    body: JSON.stringify({})
  })
  return imageFromMutationPayload(payload)
}

export async function reconcileMediaLibrary() {
  return request('/media/reconcile', {
    method: 'POST',
    body: JSON.stringify({})
  })
}
