import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { bootstrapSystem } from '@/shared/db/database'

import './styles/reset.css'
import './styles/variables.css'
import './styles/animations.css'

async function bootstrapApp() {
  await bootstrapSystem()

  const app = createApp(App)
  app.use(router)
  await router.isReady()
  app.mount('#app')
}

function renderStartupError(error) {
  console.error('Failed to start DOMO NAV:', error)

  const root = document.querySelector('#app')
  if (!root) return

  const panel = document.createElement('main')
  panel.setAttribute('role', 'alert')
  panel.style.cssText = [
    'min-height:100vh',
    'display:grid',
    'place-items:center',
    'padding:24px',
    'background:#171310',
    'color:#f4eee8',
    'font-family:system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif'
  ].join(';')

  const card = document.createElement('section')
  card.style.cssText = [
    'width:min(460px,100%)',
    'padding:32px',
    'border:1px solid rgba(255,255,255,.12)',
    'border-radius:24px',
    'background:#2a211d',
    'box-shadow:0 24px 80px rgba(0,0,0,.35)'
  ].join(';')

  const title = document.createElement('h1')
  title.textContent = '暂时无法连接 DOMO NAV'
  title.style.cssText = 'margin:0 0 10px;font-size:24px'

  const description = document.createElement('p')
  description.textContent = '登录服务或网络暂时不可用。系统未载入任何账号数据，请稍后重试。'
  description.style.cssText = 'margin:0 0 22px;color:#cbbdb2;line-height:1.7'

  const retry = document.createElement('button')
  retry.type = 'button'
  retry.textContent = '重新连接'
  retry.style.cssText = [
    'border:0',
    'border-radius:14px',
    'padding:12px 18px',
    'background:#a08060',
    'color:#fff',
    'font:inherit',
    'font-weight:700',
    'cursor:pointer'
  ].join(';')
  retry.addEventListener('click', () => window.location.reload())

  card.append(title, description, retry)
  panel.append(card)
  root.replaceChildren(panel)
}

bootstrapApp().catch(renderStartupError)
