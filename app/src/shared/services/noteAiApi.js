import { isBackendAuthEnabled } from '@/shared/services/authApi'
import { apiRequest } from '@/shared/services/apiClient'

export function canUseBackendNoteAi() {
  return isBackendAuthEnabled()
}

export async function runBackendNoteAi(action, note) {
  const payload = await apiRequest('/notes/ai', {
    method: 'POST',
    body: JSON.stringify({
      action,
      type: note?.type || 'memo',
      title: note?.title || '',
      content: note?.content || '',
      tags: Array.isArray(note?.tags) ? note.tags : []
    })
  })

  const result = payload?.result

  if (action === 'tags') {
    if (
      result?.kind !== 'tags'
      || !Array.isArray(result.tags)
      || result.tags.some((tag) => typeof tag !== 'string')
    ) {
      throw new Error('AI 标签结果格式无效，请重新生成。')
    }

    return result
  }

  if (!result || typeof result.text !== 'string') {
    throw new Error('AI 编辑结果格式无效，请重新生成。')
  }

  return {
    ...result,
    kind: result.kind || 'text'
  }
}
