const WEB_PUSH_STAGE_TIMEOUT_MS = Object.freeze({
  permission: 30_000,
  'service-worker': 15_000,
  'browser-subscription': 25_000,
  'server-registration': 20_000
})

function stagedWebPushError(error, stage) {
  const wrapped = new Error(error?.message || 'Web Push operation failed')
  wrapped.name = error?.name || 'Error'
  wrapped.status = Number(error?.status || 0)
  wrapped.code = String(error?.code || '')
  wrapped.webPushStage = stage
  wrapped.cause = error
  return wrapped
}

export async function runWebPushStage(
  stage,
  operation,
  timeoutMs = WEB_PUSH_STAGE_TIMEOUT_MS[stage] || 20_000
) {
  let timeoutId
  try {
    // Call the operation synchronously so permission prompts still originate
    // from the user's click. The timeout only races the returned promise.
    const pending = Promise.resolve(operation())
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        const error = new Error(`等待浏览器完成操作超过 ${Math.ceil(timeoutMs / 1000)} 秒`)
        error.name = 'TimeoutError'
        error.code = 'WEB_PUSH_TIMEOUT'
        reject(error)
      }, timeoutMs)
    })
    return await Promise.race([pending, timeout])
  } catch (error) {
    throw stagedWebPushError(error, stage)
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
