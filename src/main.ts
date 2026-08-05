import { createApp } from 'vue'
import './styles/site.scss'
import './style.css'
import App from './app/App.vue'
import { applyDocumentMetadata } from './config/site'
import Settings from './settings'
import { startAppBootstrap } from './features/bootstrap/bootstrap-controller'

Settings.init()
void startAppBootstrap()
applyDocumentMetadata()
createApp(App).mount('#app')
