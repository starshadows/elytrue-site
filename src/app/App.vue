<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide, useTemplateRef, watch } from 'vue'
import AppShell from '../components/AppShell.vue'
import BackgroundLayer from '../components/BackgroundLayer.vue'
import CommentsPanel from '../components/CommentsPanel.vue'
import FloatMessages from '../components/FloatMsgs/FloatMsgs.vue'
import ImageViewer from '../components/ImgViewer/ImgViewer.vue'
import PopupHost from '../components/Popups/Popups.vue'
import FloatMsgs from '../components/FloatMsgs'
import ImgViewer from '../components/ImgViewer'
import Popups from '../components/Popups'
import { commentsStore } from '../features/comments/comments-store'
import { musicController } from '../features/music/music-controller'
import { createPwaController } from '../features/pwa/pwa-controller'
import {
  createThemeController,
  themeControllerKey,
} from '../features/theme/theme-controller'
import { createTimelineController } from '../features/timeline/timeline-controller'
import { createViewportController } from '../features/viewport/viewport-controller'
import Settings from '../settings'
import { logFrontendError } from './app-events'
import { markPerformanceEvent } from '../lib/performance'

const commentsPanel =
  useTemplateRef<InstanceType<typeof CommentsPanel>>('commentsPanel')

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
  onThemeMusicChanged(name) {
    try {
      musicController.setActiveSong(name)
      if (!musicController.userPaused) musicController.play()
    } catch {
      // Music mounts with the static popup host immediately after the theme scene.
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

const pwa = createPwaController()
const timeline = createTimelineController({
  getCurrentCommentTime: () =>
    commentsStore.state.currentVisibleTime ?? undefined,
  getMaxTimelineTime: () =>
    commentsStore.state.items[0]?.time ?? Date.now() / 1_000,
  isFullscreen: () => viewport.isFullscreen,
  loadCommentsAtTime: (time) => commentsStore.loadAtTime(time),
  logError: logFrontendError,
  returnToLatest: () => commentsStore.returnToLatest(),
})
const viewport = createViewportController({
  closeImageViewer: ImgViewer.close,
  closePopup: Popups.close,
  forceLowerPanelDown: () => commentsPanel.value?.forceLowerPanelDown(),
  getPageScale: () => Settings.pageScale,
  isImageViewerOpen: ImgViewer.isOpen,
  isPopupOpen: Popups.isOpen,
  pauseCommentsScroll: (milliseconds) =>
    commentsPanel.value?.pauseScroll(milliseconds),
  setMusicVolume: (volume) => {
    try {
      musicController.setVolume(volume)
    } catch {
      // The host may set Wallpaper Engine properties before audio mounts.
    }
  },
  setPageScale: (scale) => (Settings.pageScale = scale),
  updateTimelineActiveMonth: (scroll) => timeline.setActiveDate(scroll),
})

async function installPwa(): Promise<void> {
  if (await pwa.prompt()) return
  if (pwa.isStandalone) {
    FloatMsgs.show({
      type: 'info',
      msg: '<span class="ui zh">你已安装过App</span><span class="ui en">App already installed</span>',
    })
    return
  }
  window.alert(
    '你的浏览器不支持安装PWA App\n\n建议使用谷歌Chrome/微软Edge浏览器\n\n你也可以从浏览器菜单手动添加到桌面\n\nYour browser does not seem to support PWA Apps.\nWe recommend using Google Chrome or Microsoft Edge to do this.',
  )
}

onMounted(() => {
  markPerformanceEvent('app-mounted')
  theme.init()
  timeline.init()
  pwa.init()
  viewport.init()
  if (location.hash.startsWith('#popup-')) {
    const popup = location.hash.slice(7)
    if (popup === 'loginPopup') Popups.show('loginPopup')
  }
  document.documentElement.dataset.appReady = 'true'
})

watch(
  () => commentsStore.state.currentVisibleTime,
  () => timeline.setActiveDate(),
)
watch(
  () => commentsStore.state.items[0]?.time,
  (time) => {
    if (time) timeline.render(time)
  },
)

onBeforeUnmount(() => {
  viewport.dispose()
  pwa.dispose()
  timeline.dispose()
  theme.dispose()
  delete document.documentElement.dataset.appReady
})
</script>

<template>
  <BackgroundLayer />
  <AppShell />
  <CommentsPanel
    ref="commentsPanel"
    @fullscreen="viewport.toggleFullscreen()"
    @install="installPwa"
  />
  <div id="popups"><PopupHost /></div>
  <ImageViewer />
  <div id="floatMsgs"><FloatMessages /></div>
</template>
