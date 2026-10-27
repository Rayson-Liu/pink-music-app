import { createApp } from 'vue'
import { createPinia } from 'pinia'
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate'
import './style.css'
import App from './App.vue'
import { setupWebElectronAPI } from './utils/webElectronAPI'

// 当在普通浏览器（localhost）运行而无 Electron preload 时，初始化 Web 适配器
setupWebElectronAPI()

const app = createApp(App)
const pinia = createPinia()
pinia.use(piniaPluginPersistedstate)
app.use(pinia)
app.mount('#app')

import './styles/wide-screen.css'
