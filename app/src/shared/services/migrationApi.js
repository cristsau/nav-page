import { isBackendAuthEnabled } from '@/shared/services/authApi'
import {
  apiFileRequest,
  apiRequest as request
} from '@/shared/services/apiClient'

export const DATA_RESTORE_MAX_FILE_BYTES = 16 * 1024 * 1024
export const DATA_RESTORE_MAX_STREAM_FILE_BYTES = 128 * 1024 * 1024
export const DATA_RESTORE_STREAM_CONTENT_TYPE = 'application/x-domo-nav-backup-ndjson'

const REQUIRED_RESTORE_COLLECTIONS = Object.freeze([
  'groups',
  'bookmarks',
  'notes',
  'customEngines',
  'shares',
  'settings'
])

export function shouldUseBackendMigration() {
  return isBackendAuthEnabled()
}

function requireBackupData(backup) {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) {
    throw new Error('备份文件格式无效')
  }
  if (!backup.data || typeof backup.data !== 'object' || Array.isArray(backup.data)) {
    throw new Error('备份文件缺少数据内容')
  }

  for (const collection of REQUIRED_RESTORE_COLLECTIONS) {
    if (!Array.isArray(backup.data[collection])) {
      throw new Error(`备份文件缺少 ${collection} 数组`)
    }
  }

  return backup.data
}

function restoreRequestBody(payload) {
  const body = JSON.stringify(payload)
  if (new TextEncoder().encode(body).byteLength > DATA_RESTORE_MAX_FILE_BYTES) {
    throw new Error('恢复请求不能超过 16 MB')
  }
  return body
}

function restorePayload(backupOrUpload) {
  const uploadId = String(backupOrUpload?.uploadId || '').trim()
  return uploadId ? { uploadId } : { backup: backupOrUpload }
}

export function createCloudRestoreBackup(backup) {
  const data = requireBackupData(backup)
  if (
    backup.schema !== 'domo-nav-backup'
    || Number(backup.version) !== 1
    || !backup.manifest
    || typeof backup.manifest !== 'object'
    || Array.isArray(backup.manifest)
  ) {
    throw new Error('只支持 DOMO NAV 第 1 版云端备份')
  }

  return {
    source: 'cloud-backup',
    schema: backup.schema,
    version: 1,
    exportedAt: backup.exportedAt || null,
    manifest: backup.manifest,
    data
  }
}

export function createLocalRestoreBackup(backup) {
  const data = requireBackupData(backup)
  if (Number(backup.version) !== 1) {
    throw new Error('只支持第 1 版本地备份')
  }

  return {
    source: 'local-browser',
    version: 1,
    data
  }
}

export async function previewBackendRestore(backupOrUpload, {
  restoreShares = false
} = {}) {
  const body = restoreRequestBody({
    ...restorePayload(backupOrUpload),
    mode: 'replace',
    restoreShares: restoreShares === true
  })
  return request('/migration/restore/preview', {
    method: 'POST',
    cache: 'no-store',
    body
  })
}

export async function applyBackendRestore(backupOrUpload, {
  restoreShares = false,
  planToken,
  backupReceipt,
  currentPassword,
  confirmation
} = {}) {
  const body = restoreRequestBody({
    ...restorePayload(backupOrUpload),
    mode: 'replace',
    restoreShares: restoreShares === true,
    planToken: String(planToken || ''),
    backupReceipt: String(backupReceipt || ''),
    currentPassword: String(currentPassword || ''),
    confirmation: String(confirmation || '')
  })
  return request('/migration/restore/apply', {
    method: 'POST',
    cache: 'no-store',
    body
  })
}

export async function exportBackendData() {
  return request('/migration/export-cloud', {
    method: 'GET',
    cache: 'no-store'
  })
}

export async function exportBackendDataStream() {
  return apiFileRequest('/migration/export-cloud-stream', {
    method: 'GET',
    cache: 'no-store'
  })
}

export async function uploadBackendRestoreStream(file) {
  if (!(file instanceof Blob)) throw new TypeError('流式恢复文件无效')
  if (file.size > DATA_RESTORE_MAX_STREAM_FILE_BYTES) {
    throw new Error('流式恢复文件不能超过 128 MB')
  }
  return request('/migration/restore/stream-upload', {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': DATA_RESTORE_STREAM_CONTENT_TYPE
    },
    body: file
  })
}

export async function exportBackendRestoreSafetyBackup() {
  return request('/migration/restore/safety-backup', {
    method: 'GET',
    cache: 'no-store'
  })
}
