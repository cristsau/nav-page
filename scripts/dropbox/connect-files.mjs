// Separate Full Dropbox authorization. No cloud file API or production transfer.
import { spawnSync, spawn } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { AuthorizationError, validateClientId, createAttempt, startReceiver, exchangeAndVerify, REDIRECT_URI } from './oauth.mjs'

const ownDirectory = dirname(fileURLToPath(import.meta.url))
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

export function windowsPowerShellEnvironment(source = process.env) {
  // Node does not apply PowerShell's PS7 -> Windows PowerShell path compatibility.
  // Let the child construct its own module path. Never modify the parent/system.
  return Object.fromEntries(Object.entries(source).filter(([key]) => key.toLowerCase() !== 'psmodulepath'))
}

export function storeFilesConnection(clientId, mode, credentials, { spawnImpl = spawnSync, environment = process.env } = {}) {
  validateClientId(clientId)
  if (!['Check', 'Store'].includes(mode)) throw new AuthorizationError('invalid_store_mode')
  const result = spawnImpl(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(ownDirectory, 'Save-Connection.ps1'), '-ClientId', clientId, '-Mode', mode
  ], { input: credentials ? JSON.stringify(credentials) : '', encoding: 'utf8', windowsHide: true,
    timeout: 15_000, maxBuffer: 4096, env: windowsPowerShellEnvironment(environment) })
  let receipt
  try { receipt = JSON.parse(result.stdout?.trim()) } catch { throw new AuthorizationError('private_local_store_unavailable') }
  if (receipt.reason === 'connection_already_exists_no_overwrite') throw new AuthorizationError('connection_already_exists_no_overwrite')
  if (result.status !== 0 || receipt.status !== (mode === 'Store' ? 'LOCAL_AUTHORIZATION_SAVED' : 'LOCAL_STORE_READY')) {
    throw new AuthorizationError('private_local_store_unavailable')
  }
}

export function validateSeparateApps(clientId, backupClientId) {
  validateClientId(clientId)
  validateClientId(backupClientId)
  if (clientId === backupClientId) throw new AuthorizationError('backup_app_must_remain_separate')
}

// Dependency injection permits offline tests of every consent/storage boundary.
export async function authorizeFileLibrary({ clientId, backupClientId }, io) {
  validateSeparateApps(clientId, backupClientId)
  if (await io.confirmApp() !== 'YES') throw new AuthorizationError('authorization_cancelled')
  await io.store(clientId, 'Check')
  const attempt = createAttempt(clientId)
  const receiver = await io.startReceiver({ state: attempt.state })
  try {
    await io.openBrowser(attempt.url)
    const code = await receiver.result
    const connected = await io.exchange(attempt, code)
    if (connected.credentials?.client_id !== clientId) throw new AuthorizationError('app_identity_mismatch')
    if (await io.confirmAccount(connected.display) !== 'YES') throw new AuthorizationError('account_not_confirmed')
    await io.store(clientId, 'Store', connected.credentials)
    return 'NAV_FILES_AUTHORIZATION_SAVED'
  } finally { receiver.stop() }
}

async function main() {
  let rl
  try {
    if (process.platform !== 'win32' || !process.stdin.isTTY) throw new AuthorizationError('interactive_windows_operator_required')
    rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('NAV / Dropbox 文件管理独立授权（整个个人 Dropbox）。')
    console.log('旧备份应用保持不动；本助手不会读取网盘文件、上传、删除或修改服务器。')
    console.log(`请核对新应用类型为 Full Dropbox，Redirect URIs 已添加：${REDIRECT_URI}`)
    console.log('Allow public clients 保持 Allow。不要输入 App secret、Token 或授权码。')
    const args = process.argv.slice(2)
    if (args.length > 2) throw new AuthorizationError('invalid_arguments')
    const clientId = args[0] || (await rl.question('新文件管理应用 App key：')).trim()
    const backupClientId = args[1] || (await rl.question('原备份应用 App key（仅用于防止混用，不读取旧凭据）：')).trim()
    const status = await authorizeFileLibrary({ clientId, backupClientId }, {
      confirmApp: () => rl.question('已确认是独立 Full Dropbox 应用及个人账号，输入 YES 打开授权页：'),
      store: storeFilesConnection,
      async startReceiver(options) {
        const receiver = await startReceiver(options)
        rl.once('SIGINT', () => { receiver.stop(); rl.close() })
        return receiver
      },
      async openBrowser(url) {
        console.log('请在这台电脑的浏览器中登录并点击允许，最长等待 10 分钟。随后回到本窗口确认账号。')
        const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command',
          'Start-Process -FilePath $env:NAV_DROPBOX_CONSENT_URL | Out-Null'], {
          env: { ...windowsPowerShellEnvironment(), NAV_DROPBOX_CONSENT_URL: url }, windowsHide: true, stdio: 'ignore'
        })
        await new Promise((resolve, reject) => {
          child.once('error', () => reject(new AuthorizationError('cannot_open_browser')))
          child.once('exit', code => code === 0 ? resolve() : reject(new AuthorizationError('cannot_open_browser')))
        })
      },
      exchange: exchangeAndVerify,
      confirmAccount(display) {
        console.log(`Dropbox 返回的账号：${String(display).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')}`)
        return rl.question('确认这是你的个人网盘账号？输入 YES 加密保存；其他输入不保存：')
      }
    })
    console.log(`${status}：文件管理凭据已绑定当前 Windows 用户加密保存。`)
    console.log('未传到服务器、未读取或修改网盘文件、未修改备份连接。请只发送上述状态，不发送文件或 Token。')
  } catch (error) {
    const code = error instanceof AuthorizationError ? error.message : 'authorization_failed'
    console.error(`未完成授权：${code}。不要发送完整地址、授权码或密钥。`)
    console.error('如果已点允许但未保存，可在 Dropbox 设置 → 已关联应用中仅撤销这个新文件管理应用。不要撤销原备份应用。')
    process.exitCode = 1
  } finally { rl?.close() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
