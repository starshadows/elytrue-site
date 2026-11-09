<script setup lang="ts">
import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useTemplateRef,
  watch,
} from 'vue'
import type Hls from 'hls.js'
import type { ErrorData, Events } from 'hls.js'
import ProgressSlider from './controls/ProgressSlider.vue'
import {
  themeControllerKey,
  themeState,
} from '../features/theme/theme-controller'
import { VIDEO_THEMES, type VideoTheme } from '../config/assets'

const injectedTheme = inject(themeControllerKey)
if (!injectedTheme) throw new Error('Theme controller is not provided')
const themeController = injectedTheme

const stage = useTemplateRef<HTMLElement>('stage')
const video = useTemplateRef<HTMLVideoElement>('video')
const hidden = ref(true)
const progress = ref(0)
const currentTime = ref(0)
const duration = ref(0)
const paused = ref(true)
const muted = ref(false)
const volume = ref(1)
const desktopFullscreenActive = ref(false)
const mobileNativeFullscreenActive = ref(false)
const fullscreenActive = computed(
  () =>
    desktopFullscreenActive.value ||
    mobileNativeFullscreenActive.value ||
    Boolean(getFullscreenElement()),
)
const controlsVisible = ref(true)
const errorMessage = ref('')
let hls: Hls | undefined
let loadVersion = 0
let autoplayAttempted = false
let controlsTimer: number | undefined
let keyboardFocusActive = false
let loadedThemeId = ''
let restoredProgressThemeId = ''
let mobileFullscreenKind: 'standard' | 'webkit' | undefined

const VIDEO_PROGRESS_STORAGE_KEY = 'elytrue.video-progress:v1'
const VIDEO_HISTORY_STATE_KEY = 'elytrue-video-open'
let videoHistoryPushed = false

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element
  mozFullScreenElement?: Element
  msFullscreenElement?: Element
  webkitExitFullscreen?: () => Promise<void>
  mozCancelFullScreen?: () => Promise<void>
  msExitFullscreen?: () => Promise<void>
}

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: (options?: FullscreenOptions) => Promise<void>
  mozRequestFullScreen?: (options?: FullscreenOptions) => Promise<void>
  msRequestFullscreen?: (options?: FullscreenOptions) => Promise<void>
}

type WebkitFullscreenVideo = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void
  webkitExitFullscreen?: () => void
  webkitDisplayingFullscreen?: boolean
}

function getFullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null
  const doc = document as FullscreenDocument
  return (
    doc.fullscreenElement ??
    doc.webkitFullscreenElement ??
    doc.mozFullScreenElement ??
    doc.msFullscreenElement ??
    null
  )
}

function pushVideoHistoryState(): void {
  if (typeof window === 'undefined' || videoHistoryPushed) return
  try {
    const currentState = window.history.state || {}
    if (!currentState[VIDEO_HISTORY_STATE_KEY]) {
      window.history.pushState(
        { ...currentState, [VIDEO_HISTORY_STATE_KEY]: true },
        '',
        window.location.href,
      )
      videoHistoryPushed = true
    }
  } catch {
    // Ignore history restrictions
  }
}

function clearVideoHistoryState(): void {
  if (typeof window === 'undefined' || !videoHistoryPushed) return
  videoHistoryPushed = false
  try {
    if (window.history.state?.[VIDEO_HISTORY_STATE_KEY]) {
      window.history.back()
    }
  } catch {
    // Ignore
  }
}

function handlePopState(event: PopStateEvent): void {
  if (!activeTheme.value) return
  if (videoHistoryPushed && !event.state?.[VIDEO_HISTORY_STATE_KEY]) {
    videoHistoryPushed = false
    void returnToPreviousTheme({ fromHistory: true })
  }
}

function readVideoProgress(themeId: string): number | undefined {
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(VIDEO_PROGRESS_STORAGE_KEY) || '{}',
    ) as Record<string, unknown>
    const seconds = stored[themeId]
    return typeof seconds === 'number' &&
      Number.isFinite(seconds) &&
      seconds >= 0
      ? seconds
      : undefined
  } catch {
    return undefined
  }
}

function persistCurrentVideoProgress(): void {
  const element = video.value
  if (!element || !loadedThemeId || !Number.isFinite(element.currentTime))
    return
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(VIDEO_PROGRESS_STORAGE_KEY) || '{}',
    ) as Record<string, unknown>
    stored[loadedThemeId] = Math.max(0, element.currentTime)
    window.localStorage.setItem(
      VIDEO_PROGRESS_STORAGE_KEY,
      JSON.stringify(stored),
    )
  } catch {
    // Playback persistence must never interrupt video controls.
  }
}

const activeTheme = computed<VideoTheme | undefined>(() =>
  VIDEO_THEMES.find((theme) => theme.id === themeState.activeVideo),
)

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const rounded = Math.floor(seconds)
  const minutes = Math.floor(rounded / 60)
  return `${minutes}:${String(rounded % 60).padStart(2, '0')}`
}

function syncBodyMode(): void {
  document.body.classList.toggle(
    'video-theme-active',
    Boolean(activeTheme.value),
  )
  document.body.classList.toggle(
    'video-focus',
    Boolean(activeTheme.value) && hidden.value,
  )
  document.body.classList.toggle(
    'video-player-fullscreen',
    Boolean(activeTheme.value) && fullscreenActive.value,
  )
}

function destroySource(): void {
  loadVersion += 1
  hls?.destroy()
  hls = undefined
  const element = video.value
  if (element) {
    element.pause()
    element.removeAttribute('src')
    element.load()
  }
  autoplayAttempted = false
  progress.value = 0
  currentTime.value = 0
  duration.value = 0
  paused.value = true
  errorMessage.value = ''
}

function clearControlsTimer(): void {
  if (controlsTimer === undefined) return
  window.clearTimeout(controlsTimer)
  controlsTimer = undefined
}

function controlsHaveFocus(): boolean {
  const active = document.activeElement
  return Boolean(keyboardFocusActive && active && stage.value?.contains(active))
}

function scheduleControlsHide(): void {
  clearControlsTimer()
  controlsTimer = window.setTimeout(() => {
    controlsTimer = undefined
    if (!controlsHaveFocus()) controlsVisible.value = false
  }, 1_500)
}

function revealControls(): void {
  controlsVisible.value = true
  scheduleControlsHide()
}

function revealControlsFromPointer(): void {
  keyboardFocusActive = false
  revealControls()
}

function revealControlsFromKeyboard(): void {
  keyboardFocusActive = true
  revealControls()
}

function handleFocusOut(): void {
  window.setTimeout(() => {
    if (!controlsHaveFocus()) {
      keyboardFocusActive = false
      scheduleControlsHide()
    }
  })
}

async function attemptAutoplay(): Promise<void> {
  const element = video.value
  if (!element || autoplayAttempted || !activeTheme.value) return
  autoplayAttempted = true
  element.muted = false
  muted.value = false
  try {
    await element.play()
  } catch {
    element.muted = true
    muted.value = true
    try {
      await element.play()
    } catch {
      paused.value = true
    }
  }
}

async function loadTheme(theme: VideoTheme | undefined): Promise<void> {
  persistCurrentVideoProgress()
  if (loadedThemeId && theme?.id !== loadedThemeId) {
    await exitPlayerFullscreen()
  }
  loadedThemeId = theme?.id ?? ''
  restoredProgressThemeId = ''
  destroySource()
  hidden.value = true
  controlsVisible.value = true
  syncBodyMode()
  if (!theme) {
    clearControlsTimer()
    await exitPlayerFullscreen()
    clearVideoHistoryState()
    return
  }
  pushVideoHistoryState()
  scheduleControlsHide()
  await nextTick()
  const element = video.value
  if (!element) return
  const version = ++loadVersion

  if (element.canPlayType('application/vnd.apple.mpegurl')) {
    element.src = theme.playlist
    element.load()
    return
  }

  try {
    const { default: HlsConstructor } = await import('hls.js/light')
    if (version !== loadVersion || !activeTheme.value) return
    if (!HlsConstructor.isSupported()) {
      errorMessage.value = '当前浏览器不支持 HLS 视频播放'
      return
    }
    const instance = new HlsConstructor({
      enableWorker: true,
      startFragPrefetch: false,
    })
    hls = instance
    instance.on(HlsConstructor.Events.MANIFEST_PARSED, () => {
      if (version === loadVersion) void attemptAutoplay()
    })
    instance.on(
      HlsConstructor.Events.ERROR,
      (_event: Events, data: ErrorData) => {
        if (version === loadVersion && data.fatal) {
          errorMessage.value = '视频加载失败，请稍后重试'
        }
      },
    )
    instance.loadSource(theme.playlist)
    instance.attachMedia(element)
  } catch {
    errorMessage.value = '视频播放器加载失败'
  }
}

function syncPlayback(): void {
  const element = video.value
  if (!element) return
  currentTime.value = Number.isFinite(element.currentTime)
    ? element.currentTime
    : 0
  duration.value = Number.isFinite(element.duration) ? element.duration : 0
  progress.value = duration.value > 0 ? currentTime.value / duration.value : 0
  paused.value = element.paused
  muted.value = element.muted
  volume.value = element.volume
}

function restoreVideoProgress(): void {
  const element = video.value
  if (!element || !loadedThemeId || restoredProgressThemeId === loadedThemeId)
    return
  restoredProgressThemeId = loadedThemeId
  const saved = readVideoProgress(loadedThemeId)
  if (saved === undefined) return
  const maximum =
    Number.isFinite(element.duration) && element.duration > 0
      ? element.duration
      : saved
  element.currentTime = Math.min(saved, maximum)
  syncPlayback()
}

function handleTimeUpdate(): void {
  syncPlayback()
  persistCurrentVideoProgress()
}

function seek(ratio: number): void {
  const element = video.value
  if (!element || !Number.isFinite(element.duration) || element.duration <= 0)
    return
  element.currentTime = Math.min(
    element.duration,
    Math.max(0, ratio) * element.duration,
  )
  syncPlayback()
}

function togglePlayback(): void {
  const element = video.value
  if (!element) return
  if (element.paused) void element.play()
  else element.pause()
}

function toggleMute(): void {
  const element = video.value
  if (!element) return
  element.muted = !element.muted
  syncPlayback()
}

function changeVolume(event: Event): void {
  const element = video.value
  if (!element) return
  element.volume = Number((event.currentTarget as HTMLInputElement).value)
  if (element.volume > 0) element.muted = false
  syncPlayback()
}

let touchStartX = 0
let touchStartY = 0
let touchStartTime = 0

function handleStageTouchStart(event: TouchEvent): void {
  revealControlsFromPointer()
  if (event.touches.length === 1) {
    const touch = event.touches[0]
    if (touch) {
      touchStartX = touch.clientX
      touchStartY = touch.clientY
      touchStartTime = Date.now()
    }
  }
}

function handleStageTouchEnd(event: TouchEvent): void {
  if (event.changedTouches.length === 1 && touchStartX > 0) {
    const touch = event.changedTouches[0]
    if (touch) {
      const deltaX = touch.clientX - touchStartX
      const deltaY = Math.abs(touch.clientY - touchStartY)
      const elapsed = Date.now() - touchStartTime

      // Side-swipe right from left edge (within 80px or 20% of screen width)
      const edgeThreshold = Math.max(80, window.innerWidth * 0.2)
      if (
        touchStartX <= edgeThreshold &&
        deltaX >= 60 &&
        deltaY <= 50 &&
        elapsed <= 600
      ) {
        void returnToPreviousTheme()
      }
    }
  }
  touchStartX = 0
  touchStartY = 0
  touchStartTime = 0
}

function handleEscapeKey(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !activeTheme.value) return
  // If an overlay/popup is currently open on top of the video player, let it handle Esc
  if (
    document.querySelector('.popupContainer:not(.closing)') ||
    document.querySelector('.img-viewer-overlay:not(.closing)')
  ) {
    return
  }
  event.preventDefault()
  if (
    getFullscreenElement() ||
    desktopFullscreenActive.value ||
    mobileNativeFullscreenActive.value
  ) {
    void exitPlayerFullscreen()
  } else {
    // Esc directly acts as the "返回" (Back) button!
    void returnToPreviousTheme()
  }
}

function handleNativeFullscreenChange(): void {
  const fsEl = getFullscreenElement()
  if (!fsEl) {
    mobileFullscreenKind = undefined
    mobileNativeFullscreenActive.value = false
    desktopFullscreenActive.value = false
  } else if (fsEl === video.value) {
    mobileFullscreenKind = 'standard'
    mobileNativeFullscreenActive.value = true
    desktopFullscreenActive.value = false
  } else if (fsEl === stage.value) {
    mobileFullscreenKind = undefined
    desktopFullscreenActive.value = true
    mobileNativeFullscreenActive.value = false
  } else {
    desktopFullscreenActive.value = true
  }
  syncBodyMode()
}

function handleWebkitFullscreenStart(): void {
  mobileFullscreenKind = 'webkit'
  mobileNativeFullscreenActive.value = true
  syncBodyMode()
}

function handleWebkitFullscreenEnd(): void {
  mobileFullscreenKind = undefined
  mobileNativeFullscreenActive.value = false
  syncBodyMode()
}

function handleX5FullscreenStart(): void {
  mobileFullscreenKind = 'standard'
  mobileNativeFullscreenActive.value = true
  syncBodyMode()
}

function handleX5FullscreenEnd(): void {
  mobileFullscreenKind = undefined
  mobileNativeFullscreenActive.value = false
  syncBodyMode()
}

async function exitPlayerFullscreen(): Promise<void> {
  const element = video.value as WebkitFullscreenVideo | null
  const doc = document as FullscreenDocument

  if (getFullscreenElement()) {
    if (doc.exitFullscreen) {
      await doc.exitFullscreen().catch(() => undefined)
    } else if (doc.webkitExitFullscreen) {
      await doc.webkitExitFullscreen().catch(() => undefined)
    } else if (doc.mozCancelFullScreen) {
      await doc.mozCancelFullScreen().catch(() => undefined)
    } else if (doc.msExitFullscreen) {
      await doc.msExitFullscreen().catch(() => undefined)
    }
  } else if (
    element &&
    (mobileFullscreenKind === 'webkit' || element.webkitDisplayingFullscreen)
  ) {
    try {
      element.webkitExitFullscreen?.()
    } catch {
      // The native player may already have been dismissed by the system UI.
    }
  }
  mobileFullscreenKind = undefined
  mobileNativeFullscreenActive.value = false
  desktopFullscreenActive.value = false
  syncBodyMode()
}

async function toggleFullscreen(): Promise<void> {
  if (!stage.value) return
  revealControls()

  const element = video.value as WebkitFullscreenVideo | null
  const isCurrentlyFullscreen =
    Boolean(getFullscreenElement()) ||
    desktopFullscreenActive.value ||
    mobileNativeFullscreenActive.value ||
    Boolean(element?.webkitDisplayingFullscreen)

  if (isCurrentlyFullscreen) {
    await exitPlayerFullscreen()
    return
  }

  // 1. Attempt real Fullscreen on the stage container so custom controls, title, and buttons stay visible
  const stageEl = stage.value as FullscreenElement
  const requestStageFullscreen =
    stageEl.requestFullscreen?.bind(stageEl) ||
    stageEl.webkitRequestFullscreen?.bind(stageEl) ||
    stageEl.mozRequestFullScreen?.bind(stageEl) ||
    stageEl.msRequestFullscreen?.bind(stageEl)

  if (requestStageFullscreen) {
    try {
      await requestStageFullscreen({ navigationUI: 'hide' })
      desktopFullscreenActive.value = true
      syncBodyMode()
      return
    } catch {
      // Stage requestFullscreen failed or is unsupported (e.g., iPhone Safari)
    }
  }

  // 2. Mobile fallback: try HTMLVideoElement native fullscreen if container fullscreen failed
  if (element) {
    if (element.webkitEnterFullscreen) {
      try {
        element.webkitEnterFullscreen()
        return
      } catch {
        mobileFullscreenKind = undefined
        mobileNativeFullscreenActive.value = false
      }
    }
    const requestVideoFullscreen =
      element.requestFullscreen?.bind(element) ||
      (element as FullscreenElement).webkitRequestFullscreen?.bind(element)
    if (requestVideoFullscreen) {
      try {
        await requestVideoFullscreen({ navigationUI: 'hide' })
        return
      } catch {
        if (mobileFullscreenKind !== 'standard') {
          mobileNativeFullscreenActive.value = false
        }
      }
    }
  }

  // 3. Fallback: CSS fullscreen if native Fullscreen API is unavailable or rejected
  desktopFullscreenActive.value = true
  syncBodyMode()
}

async function returnToPreviousTheme(options?: {
  fromHistory?: boolean
}): Promise<void> {
  await exitPlayerFullscreen()
  if (!options?.fromHistory) {
    clearVideoHistoryState()
  }
  themeController.returnFromVideo()
}

watch(activeTheme, syncBodyMode, { flush: 'sync' })
watch(activeTheme, (theme) => void loadTheme(theme), { flush: 'post' })
watch(hidden, syncBodyMode)
onMounted(() => {
  document.addEventListener('keydown', handleEscapeKey)
  document.addEventListener('fullscreenchange', handleNativeFullscreenChange)
  document.addEventListener(
    'webkitfullscreenchange',
    handleNativeFullscreenChange,
  )
  window.addEventListener('popstate', handlePopState)
  window.addEventListener('pagehide', persistCurrentVideoProgress)
  syncBodyMode()
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleEscapeKey)
  document.removeEventListener('fullscreenchange', handleNativeFullscreenChange)
  document.removeEventListener(
    'webkitfullscreenchange',
    handleNativeFullscreenChange,
  )
  window.removeEventListener('popstate', handlePopState)
  window.removeEventListener('pagehide', persistCurrentVideoProgress)
  clearVideoHistoryState()
  persistCurrentVideoProgress()
  clearControlsTimer()
  destroySource()
  void exitPlayerFullscreen()
  document.body.classList.remove(
    'video-theme-active',
    'video-focus',
    'video-player-fullscreen',
  )
})
</script>

<template>
  <section
    v-if="activeTheme"
    id="videoPlayerLayer"
    ref="stage"
    :class="{
      'controls-hidden': !controlsVisible,
      'player-fullscreen': fullscreenActive,
    }"
    :aria-label="activeTheme.title.zh"
    @pointermove="revealControlsFromPointer"
    @pointerdown="revealControlsFromPointer"
    @touchstart.passive="handleStageTouchStart"
    @touchend.passive="handleStageTouchEnd"
    @keydown.capture="revealControlsFromKeyboard"
    @focusin="revealControls"
    @focusout="handleFocusOut"
  >
    <video
      ref="video"
      :poster="activeTheme.cardPreview"
      playsinline
      webkit-playsinline="true"
      x5-playsinline="true"
      x5-video-player-type="h5-page"
      x5-video-player-fullscreen="true"
      x5-video-orientation="landscape|portrait"
      t7-video-player-type="inline"
      x-webkit-airplay="allow"
      disablePictureInPicture
      disableRemotePlayback
      controlslist="nodownload nofullscreen noremoteplayback"
      preload="metadata"
      @play="syncPlayback"
      @pause="syncPlayback"
      @timeupdate="handleTimeUpdate"
      @durationchange="syncPlayback"
      @loadedmetadata="restoreVideoProgress"
      @volumechange="syncPlayback"
      @canplay="attemptAutoplay"
      @webkitbeginfullscreen="handleWebkitFullscreenStart"
      @webkitendfullscreen="handleWebkitFullscreenEnd"
      @x5videoenterfullscreen="handleX5FullscreenStart"
      @x5videoexitfullscreen="handleX5FullscreenEnd"
    ></video>
    <label class="videoFocusToggle setting-switch">
      <span>
        <span class="ui zh">隐藏其他内容</span
        ><span class="ui en">Hide other content</span>
      </span>
      <input v-model="hidden" type="checkbox" />
    </label>
    <div class="videoPlayerControls" aria-label="视频控制栏">
      <p v-if="errorMessage" class="videoPlayerError">{{ errorMessage }}</p>
      <div class="videoTimeline">
        <ProgressSlider
          v-model="progress"
          :on-change="seek"
          aria-label="视频进度"
        />
        <span>{{ formatTime(currentTime) }} / {{ formatTime(duration) }}</span>
      </div>
      <div class="videoControlRow">
        <button type="button" @click="togglePlayback">
          <span class="ui zh">{{ paused ? '播放' : '暂停' }}</span
          ><span class="ui en">{{ paused ? 'Play' : 'Pause' }}</span>
        </button>
        <button type="button" @click="toggleMute">
          <span class="ui zh">{{ muted ? '取消静音' : '静音' }}</span
          ><span class="ui en">{{ muted ? 'Unmute' : 'Mute' }}</span>
        </button>
        <input
          class="videoVolume"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="volume"
          aria-label="视频音量"
          @input="changeVolume"
        />
        <button type="button" @click="toggleFullscreen">
          <span class="ui zh">{{ fullscreenActive ? '退出全屏' : '全屏' }}</span
          ><span class="ui en">{{
            fullscreenActive ? 'Exit fullscreen' : 'Fullscreen'
          }}</span>
        </button>
        <button type="button" @click="() => returnToPreviousTheme()">
          <span class="ui zh">返回</span><span class="ui en">Back</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
#videoPlayerLayer {
  position: fixed;
  top: 50%;
  left: 50%;
  z-index: 5;
  width: min(1600px, calc(100vw - 4rem), calc((100vh - 4rem) * 16 / 9));
  aspect-ratio: 16 / 9;
  transform: translate(-50%, -50%);
  overflow: hidden;
  color: white;
  background: #08060a;
  box-shadow: 0 1rem 3rem rgba(0, 0, 0, 0.34);
  transition:
    width 0.25s ease,
    box-shadow 0.25s ease;
}

#videoPlayerLayer.player-fullscreen,
#videoPlayerLayer:fullscreen,
#videoPlayerLayer:-webkit-full-screen {
  inset: 0;
  z-index: 10000;
  width: 100vw;
  width: 100%;
  height: 100vh;
  height: 100%;
  aspect-ratio: auto;
  transform: none;
  box-shadow: none;
  transition: none;
}

video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #08060a;
  -webkit-touch-callout: none;
}

.videoPlayerControls {
  position: absolute;
  z-index: 1;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-flow: column;
  gap: 0.55rem;
  padding: 0.7rem 0.9rem;
  background: linear-gradient(transparent, rgba(13, 8, 17, 0.88) 38%);
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.videoFocusToggle {
  position: absolute;
  z-index: 2;
  top: 0.75rem;
  right: 0.75rem;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  white-space: nowrap;
  padding: 0.4rem 0.6rem;
  border-radius: 999px;
  background: rgba(13, 8, 17, 0.72);
  backdrop-filter: blur(0.5rem);
  transition: opacity 0.2s ease;
}

.controls-hidden .videoPlayerControls {
  opacity: 0;
  transform: translateY(0.75rem);
  pointer-events: none;
}

.controls-hidden {
  cursor: none;
}

.controls-hidden .videoFocusToggle {
  opacity: 0;
  pointer-events: none;
}

.videoTimeline {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 0.75rem;
  font-variant-numeric: tabular-nums;
  font-size: 0.82rem;
}

.videoTimeline :deep(.progress-slider) {
  width: 100%;
}

.videoControlRow {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

button {
  border: 0;
  border-radius: 999px;
  padding: 0.45rem 0.85rem;
  color: #3f2338;
  background: #ffd5e7;
  cursor: pointer;
}

.videoVolume {
  width: min(8rem, 22vw);
  accent-color: #ff9cba;
}

.videoPlayerError {
  margin: 0;
  color: #ffd1d1;
  text-align: center;
}

@media (max-width: 720px) {
  #videoPlayerLayer {
    width: min(calc(100vw - 0.75rem), calc((100vh - 0.75rem) * 16 / 9));
  }

  #videoPlayerLayer.player-fullscreen,
  #videoPlayerLayer:fullscreen,
  #videoPlayerLayer:-webkit-full-screen {
    width: 100vw;
    width: 100%;
    height: 100vh;
    height: 100%;
  }

  .videoPlayerControls {
    padding: 0.55rem;
  }

  .videoFocusToggle {
    top: 0.4rem;
    right: 0.4rem;
  }

  .videoControlRow {
    gap: 0.35rem;
  }

  button {
    padding: 0.4rem 0.65rem;
  }
}
</style>
