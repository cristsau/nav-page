import { spawnSync, spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { AuthorizationError, createAttempt, startReceiver, exchangeAndVerify, REDIRECT_URI } from './oauth.mjs'

const ownDirectory = dirname(fileURLToPath(import.meta.url))
const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function store(clientId, mode, credentials) {
  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(ownDirectory, 'Save-Connection.ps1'), '-ClientId', clientId, '-Mode', mode
  ], { input: credentials ? JSON.stringify(credentials) : '', encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 4096 })
  if (result.status !== 0) throw new AuthorizationError('private_local_store_unavailable')
  let receipt
  try { receipt = JSON.parse(result.stdout.trim()) } catch { throw new AuthorizationError('invalid_local_store_receipt') }
  const expected = mode === 'Store' ? 'LOCAL_AUTHORIZATION_SAVED' : 'LOCAL_STORE_READY'
  if (receipt.status !== expected) throw new AuthorizationError('invalid_local_store_receipt')
}

async function openBrowser(url) {
  // The URL contains a public client ID, state and PKCE challenge, NOT a verifier or token.
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    'Start-Process -FilePath $env:NAV_DROPBOX_CONSENT_URL | Out-Null'], {
    env: { ...process.env, NAV_DROPBOX_CONSENT_URL: url }, windowsHide: true, stdio: 'ignore'
  })
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(new AuthorizationError('cannot_open_browser')))
    child.once('exit', code => code === 0 ? resolve() : reject(new AuthorizationError('cannot_open_browser')))
  })
}

let receiver, rl
try {
  if (process.platform !== 'win32') throw new AuthorizationError('windows_operator_tool_only')
  rl = createInterface({ input: process.stdin, output: process.stdout })
  rl.on('SIGINT', () => { receiver?.stop(); rl.close() })
  console.log('NAV / Dropbox 备份专用授权。此助手不会上传、删除文件或修改服务器。')
  console.log(`请先在 Dropbox Settings 的 Redirect URIs 添加：${REDIRECT_URI}`)
  console.log('应用类型必须为 App Folder；Allow public clients 保持 Allow。不要输入 App secret。')
  const clientId = (await rl.question('粘贴 App key（公开应用编号），然后按回车：')).trim()
  const attempt = createAttempt(clientId)
  if ((await rl.question('已核对 App Folder 和回调地址，输入 YES 打开 Dropbox 授权页：')).trim() !== 'YES') {
    throw new AuthorizationError('authorization_cancelled')
  }
  store(clientId, 'Check')
  receiver = await startReceiver({ state: attempt.state })
  console.log('等待你在浏览器登录并点击允许，最长 10 分钟。授权后请回到本窗口。')
  await openBrowser(attempt.url)
  const code = await receiver.result
  const connected = await exchangeAndVerify(attempt, code)
  console.log(`Dropbox 返回的账号：${connected.display.replace(/[\x00-\x1f\x7f]/g, '')}`)
  if ((await rl.question('确认是你的备份账号？输入 YES 加密保存；其他输入不保存：')).trim() !== 'YES') {
    throw new AuthorizationError('account_not_confirmed')
  }
  store(clientId, 'Store', connected.credentials)
  console.log('LOCAL_AUTHORIZATION_SAVED：凭据已绑定当前 Windows 用户加密保存。')
  console.log('未传到服务器、未开始备份。请只把上述状态发给助手，不发送文件或 Token。')
} catch (error) {
  const code = error instanceof AuthorizationError ? error.message : 'authorization_failed'
  console.error(`未完成授权：${code}。不要发送完整地址、授权码或密钥。`)
  console.error('如已在 Dropbox 点过允许但本地保存失败，可在 Dropbox 设置 → 已关联应用中撤销该应用。')
  process.exitCode = 1
} finally { receiver?.stop(); rl?.close() }
