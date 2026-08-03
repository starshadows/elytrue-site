import { createApp } from 'vue'
import './styles/site.scss'
import './style.css'
import App from './app/App.vue'
import { applyDocumentMetadata } from './config/site'
import Settings from './settings'

Settings.init()
applyDocumentMetadata()
createApp(App).mount('#app')
