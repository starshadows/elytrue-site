import { DEFAULT_MUSIC, MUSIC_ROOT, OFFICIAL_MUSIC } from '../../config/assets'
import {
  getConfig as readConfig,
  setConfig as writeConfig,
} from '../../settings/config'

const PLAYBACK_STATE_KEY = 'musicPlaybackStateV1'
const PAUSED_CONFIG_KEY = 'mutebgm'

export interface MusicPlaybackState {
  readonly song: string
  readonly currentTime: number
  readonly paused: boolean
}

export interface MusicProgressSlider {
  progress: number | undefined
}

export interface MusicControllerElements {
  readonly player: HTMLAudioElement
  readonly playerImg: HTMLImageElement
  readonly playBtn: HTMLElement
  readonly playingIndicators: ArrayLike<Element>
  readonly titles: ArrayLike<Element>
  readonly progressSlider: MusicProgressSlider
  readonly list: HTMLOListElement
  readonly shuffleBtn: HTMLInputElement
  readonly playlistButton?: Element
}

export interface MusicControllerDependencies {
  readonly defaultMusic?: string
  readonly musicRoot?: string
  readonly officialMusic?: readonly string[]
  readonly random?: () => number
  readonly getConfig?: (key: string) => string | null
  readonly setConfig?: (key: string, value: string | boolean | number) => void
  readonly window?: Window
  readonly navigator?: Navigator
  readonly createMediaMetadata?: (init: MediaMetadataInit) => MediaMetadata
}

export interface MusicController {
  readonly playList: readonly string[]
  readonly userPaused: boolean
  dispose(): void
  init(elements: MusicControllerElements): void
  pause(): void
  play(index?: number): void
  playNext(): void
  playPrev(): void
  restorePlaybackState(): boolean
  seek(progress: number): void
  setActiveSong(song: number | string): void
  setVolume(volume: number): void
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.min(
      index,
      Math.floor(Math.max(0, random()) * (index + 1)),
    )
    const current = items[index]
    const replacement = items[randomIndex]
    if (current === undefined || replacement === undefined) continue
    items[index] = replacement
    items[randomIndex] = current
  }
  return items
}

export function buildMusicPlaylist(
  directory: string,
  songs: readonly string[],
  defaultSong: string,
  random: () => number = Math.random,
): string[] {
  const upcoming = songs.filter((song) => song !== defaultSong)
  shuffle(upcoming, random)
  return [defaultSong, ...upcoming].map(
    (song) => `${directory}${encodeURIComponent(song)}`,
  )
}

export function createPlayOrder(
  trackCount: number,
  shuffled: boolean,
  random: () => number = Math.random,
): number[] {
  const order = Array.from(
    { length: Math.max(0, Math.floor(trackCount)) },
    (_, index) => index,
  )
  return shuffled ? shuffle(order, random) : order
}

export function getAdjacentSongIndex(
  order: readonly number[],
  currentIndex: number,
  direction: 'next' | 'previous',
): number | undefined {
  if (order.length === 0) return undefined
  const position = order.indexOf(currentIndex)
  if (direction === 'next') return order[(position + 1) % order.length]
  const previousPosition = position > 0 ? position - 1 : order.length - 1
  return order[previousPosition]
}

export function parsePlaybackState(
  serialized: string | null | undefined,
): MusicPlaybackState | null {
  if (!serialized) return null

  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    return null
  }

  if (typeof value !== 'object' || value === null) return null
  if (!('song' in value) || typeof value.song !== 'string' || !value.song) {
    return null
  }
  if (
    !('currentTime' in value) ||
    typeof value.currentTime !== 'number' ||
    !Number.isFinite(value.currentTime)
  ) {
    return null
  }

  return {
    song: value.song,
    currentTime: value.currentTime,
    paused: !('paused' in value) || value.paused !== false,
  }
}

function fileNameFromUrl(url: string, includeExtension: boolean): string {
  const encodedName = url.slice(url.lastIndexOf('/') + 1)
  const name = decodeURIComponent(encodedName)
  if (includeExtension) return name
  const extensionIndex = name.lastIndexOf('.')
  return extensionIndex > 0 ? name.slice(0, extensionIndex) : name
}

function savesData(navigator: Navigator): boolean {
  if (
    'connection' in navigator &&
    typeof navigator.connection === 'object' &&
    navigator.connection !== null &&
    'saveData' in navigator.connection &&
    navigator.connection.saveData === true
  ) {
    return true
  }
  if (
    'mozConnection' in navigator &&
    typeof navigator.mozConnection === 'object' &&
    navigator.mozConnection !== null &&
    'saveData' in navigator.mozConnection &&
    navigator.mozConnection.saveData === true
  ) {
    return true
  }
  return (
    'webkitConnection' in navigator &&
    typeof navigator.webkitConnection === 'object' &&
    navigator.webkitConnection !== null &&
    'saveData' in navigator.webkitConnection &&
    navigator.webkitConnection.saveData === true
  )
}

class MusicControllerImpl implements MusicController {
  private readonly defaultMusic: string
  private readonly musicRoot: string
  private readonly officialMusic: readonly string[]
  private readonly random: () => number
  private readonly getConfig: (key: string) => string | null
  private readonly setConfig: (
    key: string,
    value: string | boolean | number,
  ) => void
  private readonly suppliedWindow: Window | undefined
  private readonly suppliedNavigator: Navigator | undefined
  private readonly createMediaMetadata: (
    init: MediaMetadataInit,
  ) => MediaMetadata

  private activeIndex = -1
  private elements: MusicControllerElements | undefined
  private listeners: Array<() => void> = []
  private mediaSession: MediaSession | undefined
  private mediaSessionActions = new Set<MediaSessionAction>()
  private timeoutIds = new Set<number>()
  private idleCallbackIds = new Set<number>()
  private prefetchLinks = new Set<HTMLLinkElement>()
  private progressInterval: number | undefined
  private playOrder: number[] = []
  private playlist: string[] = []
  private lastPersistedSecond = -1
  private prefetchScheduled = false
  private pausedByUser = true

  constructor(dependencies: MusicControllerDependencies) {
    this.defaultMusic = dependencies.defaultMusic ?? DEFAULT_MUSIC
    this.musicRoot = dependencies.musicRoot ?? MUSIC_ROOT
    this.officialMusic = dependencies.officialMusic ?? OFFICIAL_MUSIC
    this.random = dependencies.random ?? Math.random
    this.getConfig = dependencies.getConfig ?? readConfig
    this.setConfig = dependencies.setConfig ?? writeConfig
    this.suppliedWindow = dependencies.window
    this.suppliedNavigator = dependencies.navigator
    this.createMediaMetadata =
      dependencies.createMediaMetadata ?? ((init) => new MediaMetadata(init))
  }

  get playList(): readonly string[] {
    return this.playlist
  }

  get userPaused(): boolean {
    return this.pausedByUser
  }

  init(elements: MusicControllerElements): void {
    this.dispose()
    this.elements = elements
    this.activeIndex = -1
    this.lastPersistedSecond = -1
    this.playOrder = []
    this.prefetchScheduled = false
    this.loadPlaylist()
    this.bindEvents()
    this.bindMediaSession()
    this.startProgressUpdates()
    this.scheduleUpcomingPrefetch()

    if (this.restorePlaybackState()) return
    if (this.getConfig(PAUSED_CONFIG_KEY) === 'true') {
      this.pausedByUser = true
    } else {
      this.play()
    }
  }

  dispose(): void {
    if (this.elements) this.persistPlaybackState(true)

    this.listeners.forEach((remove) => remove())
    this.listeners = []

    const browserWindow =
      this.suppliedWindow ??
      (typeof window === 'undefined' ? undefined : window)
    this.timeoutIds.forEach((id) => browserWindow?.clearTimeout(id))
    this.timeoutIds.clear()
    this.idleCallbackIds.forEach((id) =>
      browserWindow?.cancelIdleCallback?.(id),
    )
    this.idleCallbackIds.clear()
    if (this.progressInterval !== undefined) {
      browserWindow?.clearInterval(this.progressInterval)
      this.progressInterval = undefined
    }

    if (this.mediaSession) {
      this.mediaSessionActions.forEach((action) => {
        try {
          this.mediaSession?.setActionHandler(action, null)
        } catch {
          // Some browsers expose Media Session without every action.
        }
      })
      this.mediaSession.metadata = null
    }
    this.mediaSession = undefined
    this.mediaSessionActions.clear()

    this.prefetchLinks.forEach((link) => link.remove())
    this.prefetchLinks.clear()
    this.prefetchScheduled = false

    if (this.elements) {
      this.elements.player.pause()
      Array.from(this.elements.playingIndicators).forEach((indicator) =>
        indicator.classList.remove('playing'),
      )
    }
    this.elements = undefined
  }

  setActiveSong(song: number | string): void {
    const elements = this.requireElements()
    const index =
      typeof song === 'number'
        ? song
        : this.playlist.findIndex((url) =>
            decodeURIComponent(url).includes(song),
          )
    const url = this.playlist[index]
    if (!url) return

    this.activeIndex = index
    elements.player.src = url
    elements.player.load()
    elements.playerImg.onclick = null
    elements.playerImg.src = '/res/music_note.svg'

    const title = fileNameFromUrl(url, false)
    Array.from(elements.titles).forEach((element) => {
      element.textContent = title
    })
    Array.from(elements.list.children).forEach((element) =>
      element.classList.remove('playing'),
    )
    elements.list.children[index]?.classList.add('playing')

    const mediaSession = this.getNavigator().mediaSession
    if (mediaSession) {
      mediaSession.metadata = this.createMediaMetadata({
        title,
        artist: 'elytrue.com',
      })
    }
  }

  play(index?: number): void {
    const elements = this.requireElements()
    if (index !== undefined) {
      this.setActiveSong(index)
    } else if (!elements.player.src) {
      this.setActiveSong(0)
    }

    const attempt = elements.player.play()
    void attempt.catch(() => undefined)
    this.pausedByUser = false
    this.setConfig(PAUSED_CONFIG_KEY, false)
    this.persistPlaybackState(true)
  }

  pause(): void {
    const elements = this.requireElements()
    this.pausedByUser = true
    this.setConfig(PAUSED_CONFIG_KEY, true)
    elements.player.pause()
    this.persistPlaybackState(true)
  }

  playNext(): void {
    this.checkPlayOrder()
    const index = getAdjacentSongIndex(
      this.playOrder,
      this.getPlayingIndex(),
      'next',
    )
    if (index !== undefined) this.play(index)
  }

  playPrev(): void {
    this.checkPlayOrder()
    const index = getAdjacentSongIndex(
      this.playOrder,
      this.getPlayingIndex(),
      'previous',
    )
    if (index !== undefined) this.play(index)
  }

  seek(progress: number): void {
    const player = this.requireElements().player
    player.currentTime = player.duration * progress
  }

  setVolume(volume: number): void {
    this.requireElements().player.volume = volume
  }

  restorePlaybackState(): boolean {
    const elements = this.requireElements()
    const state = parsePlaybackState(this.getConfig(PLAYBACK_STATE_KEY))
    if (!state) return false

    const index = this.playlist.findIndex(
      (url) => fileNameFromUrl(url, true) === state.song,
    )
    if (index < 0) return false

    this.setActiveSong(index)
    this.pausedByUser = state.paused
    this.setConfig(PAUSED_CONFIG_KEY, state.paused)
    const restore = () => {
      const duration = elements.player.duration
      const upperBound =
        Number.isFinite(duration) && duration > 0
          ? Math.max(0, duration - 0.25)
          : state.currentTime
      elements.player.currentTime = Math.max(
        0,
        Math.min(state.currentTime, upperBound),
      )
      this.lastPersistedSecond = Math.floor(elements.player.currentTime)
      if (!this.pausedByUser) this.play()
    }

    if (elements.player.readyState >= 1) {
      restore()
    } else {
      this.listen(elements.player, 'loadedmetadata', restore, { once: true })
    }
    return true
  }

  private requireElements(): MusicControllerElements {
    if (!this.elements) throw new Error('Music controller is not initialized')
    return this.elements
  }

  private getWindow(): Window {
    const browserWindow =
      this.suppliedWindow ??
      (typeof window === 'undefined' ? undefined : window)
    if (!browserWindow) throw new Error('Music controller requires a window')
    return browserWindow
  }

  private getNavigator(): Navigator {
    return this.suppliedNavigator ?? this.getWindow().navigator
  }

  private loadPlaylist(): void {
    const elements = this.requireElements()
    this.playlist = buildMusicPlaylist(
      this.musicRoot,
      this.officialMusic,
      this.defaultMusic,
      this.random,
    )
    elements.list.replaceChildren()
    this.playlist.forEach((url) => {
      const item = elements.list.ownerDocument.createElement('li')
      item.textContent = fileNameFromUrl(url, false)
      elements.list.appendChild(item)
    })
    this.setActiveSong(this.defaultMusic)
  }

  private getPlayingIndex(): number {
    return this.activeIndex >= 0 ? this.activeIndex : 0
  }

  private checkPlayOrder(): void {
    if (this.playOrder.length === this.playlist.length) return
    const shuffled = this.requireElements().shuffleBtn.checked
    this.playOrder = createPlayOrder(
      this.playlist.length,
      shuffled,
      this.random,
    )
  }

  private persistPlaybackState(force = false): void {
    const elements = this.elements
    const url = this.playlist[this.getPlayingIndex()]
    if (!elements || !url || !elements.player.src) return
    const currentTime = Number.isFinite(elements.player.currentTime)
      ? elements.player.currentTime
      : 0
    const currentSecond = Math.floor(currentTime)
    if (!force && Math.abs(currentSecond - this.lastPersistedSecond) < 2) {
      return
    }

    this.lastPersistedSecond = currentSecond
    this.setConfig(
      PLAYBACK_STATE_KEY,
      JSON.stringify({
        song: fileNameFromUrl(url, true),
        currentTime,
        paused: this.pausedByUser,
      }),
    )
  }

  private bindEvents(): void {
    const elements = this.requireElements()
    this.listen(elements.playBtn, 'click', () => {
      if (elements.player.paused) this.play()
      else this.pause()
    })
    this.listen(elements.list, 'click', (event) => {
      const path = event.composedPath()
      const index = Array.from(elements.list.children).findIndex((item) =>
        path.includes(item),
      )
      if (index >= 0) this.play(index)
    })
    this.listen(elements.shuffleBtn, 'change', () => {
      this.playOrder = []
    })

    const playlistButton =
      elements.playlistButton ??
      elements.list.parentElement?.parentElement?.querySelector('button')
    if (playlistButton) {
      this.listen(playlistButton, 'mouseenter', () => {
        elements.list
          .querySelector('.playing')
          ?.scrollIntoView({ block: 'center' })
      })
    }

    this.listen(elements.player, 'play', () => {
      Array.from(elements.playingIndicators).forEach((indicator) =>
        indicator.classList.add('playing'),
      )
      this.persistPlaybackState(true)
    })
    this.listen(elements.player, 'pause', () => {
      Array.from(elements.playingIndicators).forEach((indicator) =>
        indicator.classList.remove('playing'),
      )
      this.persistPlaybackState(true)
    })
    this.listen(elements.player, 'timeupdate', () =>
      this.persistPlaybackState(),
    )
    this.listen(elements.player, 'ended', () => this.playNext())
    this.listen(this.getWindow(), 'pagehide', () =>
      this.persistPlaybackState(true),
    )
    this.listen(elements.list.ownerDocument, 'click', () => {
      if (!this.pausedByUser && elements.player.paused) this.play()
    })
  }

  private bindMediaSession(): void {
    const mediaSession = this.getNavigator().mediaSession
    if (!mediaSession) return
    this.mediaSession = mediaSession
    const handlers: ReadonlyArray<
      readonly [MediaSessionAction, MediaSessionActionHandler]
    > = [
      ['play', () => this.play()],
      ['pause', () => this.pause()],
      ['previoustrack', () => this.playPrev()],
      ['nexttrack', () => this.playNext()],
    ]
    handlers.forEach(([action, handler]) => {
      try {
        mediaSession.setActionHandler(action, handler)
        this.mediaSessionActions.add(action)
      } catch {
        // Unsupported actions should not disable the remaining controls.
      }
    })
  }

  private startProgressUpdates(): void {
    const elements = this.requireElements()
    this.progressInterval = this.getWindow().setInterval(() => {
      elements.progressSlider.progress =
        elements.player.currentTime / elements.player.duration
    }, 500)
  }

  private scheduleUpcomingPrefetch(): void {
    if (this.prefetchScheduled) return
    this.prefetchScheduled = true
    if (savesData(this.getNavigator())) return

    const browserWindow = this.getWindow()
    const document = this.requireElements().list.ownerDocument
    const prefetch = () => {
      const player = this.requireElements().player
      const current = player.currentSrc || player.src
      this.playlist
        .filter(
          (url) => new URL(url, browserWindow.location.href).href !== current,
        )
        .forEach((url) => {
          const link = document.createElement('link')
          link.rel = 'prefetch'
          link.as = 'audio'
          link.href = url
          link.fetchPriority = 'low'
          link.dataset.elytruePrefetch = 'music'
          document.head.appendChild(link)
          this.prefetchLinks.add(link)
        })
    }
    const schedule = () => {
      if (typeof browserWindow.requestIdleCallback === 'function') {
        let callbackId = 0
        callbackId = browserWindow.requestIdleCallback(
          () => {
            this.idleCallbackIds.delete(callbackId)
            prefetch()
          },
          { timeout: 8_000 },
        )
        this.idleCallbackIds.add(callbackId)
      } else {
        this.setTimeout(prefetch, 2_500)
      }
    }

    if (document.readyState === 'complete') {
      this.setTimeout(schedule, 1_200)
    } else {
      this.listen(
        browserWindow,
        'load',
        () => this.setTimeout(schedule, 1_200),
        {
          once: true,
        },
      )
    }
  }

  private setTimeout(callback: () => void, delay: number): void {
    let timeoutId = 0
    timeoutId = this.getWindow().setTimeout(() => {
      this.timeoutIds.delete(timeoutId)
      callback()
    }, delay)
    this.timeoutIds.add(timeoutId)
  }

  private listen(
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: AddEventListenerOptions | boolean,
  ): void {
    target.addEventListener(type, listener, options)
    this.listeners.push(() =>
      target.removeEventListener(type, listener, options),
    )
  }
}

export function createMusicController(
  dependencies: MusicControllerDependencies = {},
): MusicController {
  return new MusicControllerImpl(dependencies)
}

export const musicController = createMusicController()
