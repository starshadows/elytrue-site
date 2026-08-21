<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide } from 'vue'
import AppShell from '../components/AppShell.vue'
import BackgroundLayer from '../components/BackgroundLayer.vue'
import FloatMessages from '../components/FloatMsgs/FloatMsgs.vue'
import ImageViewer from '../components/ImgViewer/ImgViewer.vue'
import LegalLinks from '../components/LegalLinks.vue'
import PopupHost from '../components/Popups/Popups.vue'
import ImgViewer from '../components/ImgViewer'
import Popups from '../components/Popups'
import { musicController } from '../features/music/music-controller'
import {
  createThemeController,
  themeControllerKey,
} from '../features/theme/theme-controller'
import Settings from '../settings'
import { logFrontendError } from './app-events'
import { markPerformanceEvent } from '../lib/performance'

function shuffle<T>(items: T[]): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1))
    const current = items[index]
    const replacement = items[target]
    if (current === undefined || replacement === undefined) continue
    items[index] = replacement
    items[target] = current
  }
  return items
}

const theme = createThemeController({
  logError: logFrontendError,
  onThemeMusicChanged(name, reason) {
    if (reason !== 'initial') return
    if (musicController.consumeInitialThemeRestoreProtection()) return
    try {
      musicController.setActiveSong(name)
    } catch {
      // Music mounts with the static popup host immediately after the theme scene.
    }
  },
  onVideoThemeChanged(video) {
    try {
      if (video) musicController.suspendForVideo()
      else musicController.resumeFromVideo()
    } catch {
      // The persistent music player can still be mounting during initial setup.
    }
  },
  setOneTimeCss(element, styles) {
    Object.assign(element.style, styles)
    window.setTimeout(() => {
      Object.keys(styles).forEach((name) => element.style.removeProperty(name))
    }, 35)
  },
  shuffle,
})
provide(themeControllerKey, theme)

let previousWallpaperListener: Window['wallpaperPropertyListener']

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (ImgViewer.isOpen()) ImgViewer.close()
  else if (Popups.isOpen()) Popups.close()
}

onMounted(() => {
  markPerformanceEvent('app-mounted')
  theme.init()
  previousWallpaperListener = window.wallpaperPropertyListener
  window.wallpaperPropertyListener = {
    applyUserProperties(properties) {
      if (properties.ui_scale) {
        Settings.pageScale = properties.ui_scale.value / 100
      }
      if (properties.ui_volume) {
        try {
          musicController.setVolume(properties.ui_volume.value / 100)
        } catch {
          // Audio can still be mounting when Wallpaper Engine restores settings.
        }
      }
    },
  }
  document.addEventListener('keydown', handleKeyDown)
  document.documentElement.dataset.appReady = 'true'
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeyDown)
  window.wallpaperPropertyListener = previousWallpaperListener
  theme.dispose()
  delete document.documentElement.dataset.appReady
})
</script>

<template>
  <BackgroundLayer />
  <AppShell />
  <LegalLinks />
  <div id="popups"><PopupHost /></div>
  <ImageViewer />
  <div id="floatMsgs"><FloatMessages /></div>
</template>
