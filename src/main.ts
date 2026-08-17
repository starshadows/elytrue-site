import { createApp } from 'vue'
import './styles/site.scss'
import App from './app/App.vue'
import { applyDocumentMetadata } from './config/site'
import Settings from './settings'
import { initializeAuth } from './features/auth/auth-actions'
import { commentsStore } from './features/comments/comments-store'
import { markPerformanceEvent } from './lib/performance'

markPerformanceEvent('app-script-start')
Settings.init()
applyDocumentMetadata()
const commentsReady = commentsStore.initialize().catch(() => undefined)
const authReady = initializeAuth()
  .then((profile) => {
    markPerformanceEvent('auth-hydrated', { authenticated: Boolean(profile) })
    return profile
  })
  .catch(() => null)

createApp(App).mount('#app')
void Promise.all([commentsReady, authReady]).then(([, profile]) => {
  markPerformanceEvent('comments-hydrated', { viewerLikesComplete: false })
  if (profile) void commentsStore.hydrateViewerLikes().catch(() => undefined)
})
