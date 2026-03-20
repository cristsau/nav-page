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
  app.mount('#app')
}

bootstrapApp()
