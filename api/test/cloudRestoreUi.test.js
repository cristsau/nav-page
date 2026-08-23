import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const appSource = (path) => fs.readFile(
  fileURLToPath(new URL(`../../app/src/${path}`, import.meta.url)),
  'utf8'
)

test('cloud restore client uses bounded preview and password-confirmed apply contracts', async () => {
  const source = await appSource('shared/services/migrationApi.js')

  assert.match(source, /DATA_RESTORE_MAX_FILE_BYTES = 16 \* 1024 \* 1024/)
  assert.match(source, /new TextEncoder\(\)\.encode\(body\)\.byteLength > DATA_RESTORE_MAX_FILE_BYTES/)
  assert.match(source, /source: 'cloud-backup'/)
  assert.match(source, /source: 'local-browser'/)
  assert.match(source, /request\('\/migration\/restore\/preview',[\s\S]*?mode: 'replace'/)
  assert.match(source, /request\('\/migration\/restore\/apply'/)
  assert.match(source, /request\('\/migration\/restore\/safety-backup'/)
  assert.doesNotMatch(source, /restore\/apply'[\s\S]{0,240}expectedUnauthorized: true/)
  assert.match(source, /restoreShares: restoreShares === true/)
  assert.match(source, /planToken: String\(planToken \|\| ''\)/)
  assert.match(source, /backupReceipt: String\(backupReceipt \|\| ''\)/)
  assert.match(source, /currentPassword: String\(currentPassword \|\| ''\)/)
  assert.match(source, /confirmation: String\(confirmation \|\| ''\)/)
  assert.doesNotMatch(source, /\/migration\/import-local/)
})

test('settings restore flow requires preview, safety download and exact confirmation', async () => {
  const source = await appSource('modules/settings/components/DataSettings.vue')
  const fileSizeCheck = source.indexOf('ensureRestoreSize(file.size)')
  const fileRead = source.indexOf('const text = await file.text()', fileSizeCheck)
  const migrateStart = source.indexOf('async function handleMigrateToCloud')
  const migrateEnd = source.indexOf('async function handleClearData', migrateStart)
  const migrateSource = source.slice(migrateStart, migrateEnd)

  assert.ok(fileSizeCheck >= 0 && fileRead > fileSizeCheck, 'file size must be checked before reading')
  assert.match(source, /accept="\.json,application\/json"/)
  assert.match(source, /new Blob\(\[JSON\.stringify\(data\)\]/)
  assert.doesNotMatch(source, /JSON\.stringify\(data, null, 2\)/)
  assert.match(source, /createCloudRestoreBackup\(JSON\.parse\(text\)\)/)
  assert.match(source, /createLocalRestoreBackup\(await exportData\(\)\)/)
  assert.match(source, /await previewBackendRestore\(restoreBackup\.value/)
  assert.match(source, /restoreShares\.value = false/)
  assert.match(source, /@change="handleRestoreSharesChange"/)
  assert.match(source, /restoreSafetyBackupDownloaded\.value = false[\s\S]*?await previewBackendRestore/)
  assert.match(source, /async function downloadRestoreSafetyBackup\(\)[\s\S]*?await exportBackendRestoreSafetyBackup\(\)/)
  assert.match(source, /finally \{\s*if \(previewSequence === restorePreviewSequence\) \{\s*restoreSafetyBackupDownloading\.value = false/)
  assert.match(source, /catch \(error\) \{\s*if \(previewSequence === restorePreviewSequence && restoreModalOpen\.value\)/)
  assert.match(source, /restoreCanContinue[\s\S]*?restoreSafetyBackupDownloaded\.value/)
  assert.match(source, /restoreCanContinue[\s\S]*?restoreSafetyBackupReceipt\.value/)
  assert.match(source, /必须先下载一次当前云端数据/)
  assert.match(source, /图片元数据仅用于去重补充/)
  assert.match(source, /不按替换差值计算/)
  assert.match(source, /restoreConfirmation\.value === '恢复'/)
  assert.match(source, /currentPassword: restorePassword\.value/)
  assert.match(source, /backupReceipt: restoreSafetyBackupReceipt\.value/)
  assert.match(source, /confirmation: restoreConfirmation\.value/)
  assert.match(source, /autocomplete="current-password"/)
  assert.match(source, /for="cloud-restore-password"[\s\S]*?id="cloud-restore-password"/)
  assert.match(source, /输入“恢复”确认/)
  assert.match(source, /await importData\(data\.data\)/, 'local IndexedDB import must remain available')
  assert.doesNotMatch(migrateSource, /clearAllData/)
})

test('restore dialog keeps project accessibility and mobile interaction rules', async () => {
  const [source, modal] = await Promise.all([
    appSource('modules/settings/components/DataSettings.vue'),
    appSource('shared/components/Modal.vue')
  ])

  assert.match(source, /<Modal[\s\S]*?:show="restoreModalOpen"[\s\S]*?width="760px"/)
  assert.match(source, /:close-disabled="restoreApplying"/)
  assert.match(modal, /closeDisabled:\s*\{\s*type: Boolean,\s*default: false/)
  assert.match(modal, /function close\(\) \{\s*if \(props\.closeDisabled\) return/)
  assert.match(modal, /:disabled="closeDisabled"/)
  assert.match(source, /:aria-busy="restorePreviewing \|\| restoreApplying"/)
  assert.match(source, /role="status" aria-live="polite"/)
  assert.match(source, /role="alert"/)
  assert.match(source, /ref="restorePasswordInput"/)
  assert.match(source, /ref="restorePreviewFocus"/)
  assert.match(source, /ref="restoreSuccessFocus"/)
  assert.match(source, /async function focusRestoreStage[\s\S]*?restorePasswordInput\.value\?\.focus\(\)[\s\S]*?restoreSuccessFocus\.value\?\.focus\(\)[\s\S]*?restorePreviewFocus\.value\?\.focus\(\)/)
  assert.match(source, /restoreStage\.value = 'success'\s*await focusRestoreStage\('success'\)/)
  assert.match(source, /async function returnToRestorePreview[\s\S]*?await focusRestoreStage\('preview'\)/)
  assert.match(source, /restore-page-message--success/)
  assert.match(source, /restore-page-message--error/)
  assert.match(source, /:role="restorePageMessageKind === 'success' \? 'status' : 'alert'"/)
  assert.match(source, /\.btn\s*\{[\s\S]*?min-height: 44px;/)
  assert.match(source, /\.restore-toggle\s*\{[\s\S]*?min-height: 44px;/)
  assert.match(source, /@media \(max-width: 640px\)[\s\S]*?\.restore-footer[\s\S]*?flex-direction: column;/)
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/)
  assert.doesNotMatch(source, /[\u{1F300}-\u{1FAFF}]/u)
})
