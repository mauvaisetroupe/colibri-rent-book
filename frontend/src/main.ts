import { createApp } from 'vue'

import App from './App.vue'
import { installerOpenVue } from './openvue'
import router from './router'
import './style.css'

const app = createApp(App).use(router)
installerOpenVue(app)
app.mount('#app')
