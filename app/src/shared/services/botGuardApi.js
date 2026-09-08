import { apiRequest } from './apiClient'
let scriptPromise = null
export const fetchBotGuardConfig = () => apiRequest('/auth/bot-guard/config', {cache:'no-store',expectedUnauthorized:true})
export function loadTurnstile(browser = window, documentRef = document) {
  if (browser.turnstile) return Promise.resolve(browser.turnstile)
  if (scriptPromise) return scriptPromise
  scriptPromise = new Promise((resolve,reject) => {
    const script = documentRef.createElement('script')
    const fail = () => { browser.clearTimeout(timer); script.remove(); scriptPromise=null; reject(new Error('安全验证加载失败，请检查网络后重试。')) }
    const timer = browser.setTimeout(fail,15000)
    script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
    script.async=true; script.defer=true; script.referrerPolicy='no-referrer'
    script.onload=()=>{ browser.clearTimeout(timer); if(browser.turnstile)resolve(browser.turnstile);else fail() }
    script.onerror=fail
    documentRef.head.append(script)
  })
  return scriptPromise
}
