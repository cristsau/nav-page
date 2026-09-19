import { apiRequest } from '@/shared/services/apiClient'

const root = '/dropbox-files'
export const filesStatus = () => apiRequest(root + '/status')
export const filesAction = (action, body) => apiRequest(root + '/' + action, { method: 'POST', body: JSON.stringify(body) })
export const uploadFile = (path, file) => apiRequest(root + '/upload', { method: 'POST', body: file,
  headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(path) } })
export function contentUrl(id, inline = false) {
  return `${import.meta.env.VITE_API_BASE_URL || '/api'}${root}/content/${encodeURIComponent(id)}${inline ? '?inline=1' : ''}`
}
