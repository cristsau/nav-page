export function currentActiveWebPushSubscription(subscriptions, subscriptionId) {
  const id = String(subscriptionId || '').trim()
  if (!id || !Array.isArray(subscriptions)) return null
  return subscriptions.find((subscription) => (
    subscription?.active === true && String(subscription.id || '') === id
  )) || null
}

export function webPushEnableLabel({ permission, currentSubscription, keyMatches }) {
  if (currentSubscription && keyMatches !== false) return '重新登记当前设备'
  if (permission === 'granted') return '继续完成启用'
  return '启用当前设备'
}

export function webPushTestDisabledReason({
  busy,
  configured,
  supported,
  permission,
  serviceWorkerReady,
  browserSubscribed,
  keyMatches,
  subscriptionId,
  currentSubscription
}) {
  if (busy) return '正在处理当前设备的通知设置'
  if (!configured) return '服务器尚未配置 Web Push'
  if (!supported) return '当前浏览器或打开方式不支持后台通知'
  if (permission !== 'granted') return '请先允许当前网站发送系统通知'
  if (!serviceWorkerReady) return 'Service Worker 尚未就绪，请刷新页面后重试'
  if (!browserSubscribed) return '系统权限已允许，但浏览器 Push 订阅尚未建立，请继续完成启用'
  if (keyMatches === false) return '当前订阅密钥已更新，请重新登记当前设备'
  if (!subscriptionId || !currentSubscription) {
    return '浏览器订阅尚未在 NAV 服务器登记，请继续完成启用'
  }
  return ''
}

function boundedDetail(error, fallback) {
  const detail = String(error?.message || fallback || '未知错误')
    .replace(/https?:\/\/\S+/gi, '[已隐藏地址]')
    .replace(/\s+/g, ' ')
    .trim()
  return detail.slice(0, 180)
}

export function webPushFailureMessage(error, {
  fallback = '后台通知操作失败',
  stage = error?.webPushStage || ''
} = {}) {
  const detail = boundedDetail(error, fallback)
  if (stage === 'permission') {
    if (error?.code === 'WEB_PUSH_TIMEOUT') {
      return '系统通知权限等待超时，按钮已恢复。请确认从主屏幕打开 DOMO NAV 后再重试。'
    }
    return `系统通知权限未完成：${detail}`
  }
  if (stage === 'service-worker') {
    if (error?.code === 'WEB_PUSH_TIMEOUT') {
      return 'Service Worker 等待超时，按钮已恢复。请完全退出 DOMO NAV，从主屏幕重新打开后重试。'
    }
    return `Service Worker 未就绪：${detail}。请刷新页面后重试。`
  }
  if (stage === 'browser-subscription') {
    if (error?.code === 'WEB_PUSH_TIMEOUT') {
      return '浏览器 Push 订阅等待超时，按钮已恢复。请完全退出 DOMO NAV，从主屏幕重新打开后点“继续完成启用”。'
    }
    return '通知权限已允许，但浏览器 Push 订阅没有建立。请使用普通窗口（不要使用无痕或 InPrivate），确认系统通知和网络可用后重试。'
  }
  if (stage === 'server-registration') {
    if (error?.code === 'WEB_PUSH_TIMEOUT') {
      return '浏览器订阅已建立，但 NAV 服务器登记超时。按钮已恢复，请检查网络后重试。'
    }
    return `浏览器订阅已建立，但 NAV 服务器登记失败：${detail}`
  }
  if (stage === 'test-delivery') {
    return `当前设备已登记，但测试通知发送失败：${detail}`
  }
  return detail || fallback
}
