import {
  apiFileRequest,
  apiRequest as request
} from '@/shared/services/apiClient'

export async function fetchAiUsageSummary(days = 30) {
  return request(`/ai-usage?days=${encodeURIComponent(days)}`, {
    method: 'GET',
    cache: 'no-store'
  })
}

export async function downloadAiUsageCsv(days = 30) {
  const result = await apiFileRequest(
    `/ai-usage.csv?days=${encodeURIComponent(days)}`,
    { method: 'GET', cache: 'no-store' }
  )
  const url = URL.createObjectURL(result.blob)
  const link = document.createElement('a')
  link.href = url
  link.download = result.filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
