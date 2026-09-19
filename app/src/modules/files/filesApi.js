import { apiRequest } from '@/shared/services/apiClient'

const root = '/dropbox-files'
export const filesStatus = () => apiRequest(root + '/status')
export const filesAction = (action, body) => apiRequest(root + '/' + action, { method: 'POST', body: JSON.stringify(body) })
export const uploadFile = (path, file) => apiRequest(root + '/upload', { method: 'POST', body: file,
  headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(path) } })
export const uploadChunk = (uploadId, offset, bytes) => apiRequest(root + '/upload/chunk', { method: 'POST', body: bytes,
  headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Id': uploadId, 'X-Upload-Offset': String(offset) } })
export function contentUrl(id, inline = false, rev = null) {
  const params = new URLSearchParams()
  if (inline) params.set('inline', '1')
  if (rev) params.set('rev', rev)
  return `${import.meta.env.VITE_API_BASE_URL || '/api'}${root}/content/${encodeURIComponent(id)}${params.size ? '?' + params : ''}`
}
