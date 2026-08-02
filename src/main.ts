import { createApp } from 'vue'
import './styles/site.scss'
import './style.css'
import App from './App.vue'
import { applyBackgroundMetadata } from './config/assets'
import { applyDocumentMetadata } from './config/site'
import * as index from '.'
import components from './components'

applyDocumentMetadata()
applyBackgroundMetadata()

Object.assign(window, index)
Object.assign(window, components)
createApp(App).mount('#app')
