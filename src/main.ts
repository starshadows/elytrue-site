import { createApp } from 'vue'
import './styles/site.scss'
import App from './app/App.vue'
import { applyDocumentMetadata } from './config/site'
import Settings from './settings'
import { markPerformanceEvent } from './lib/performance'

markPerformanceEvent('app-script-start')
Settings.init()
applyDocumentMetadata()
createApp(App).mount('#app')
