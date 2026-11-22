import {
  DEFAULT_MUSIC,
  MUSIC_DISPLAY_TITLES,
  MUSIC_ROOT,
  OFFICIAL_MUSIC,
} from '../../config/assets'
import {
  getConfig as readConfig,
  setConfig as writeConfig,
} from '../../settings/config'
import { markPerformanceEvent } from '../../lib/performance'
import {
  readMusicMetadata,
  reportMusicMetadataDiagnostic,
} from './music-metadata'

const PLAYBACK_STATE_KEY = 'musicPlaybackStateV1'
const PAUSED_CONFIG_KEY = 'mutebgm'
const METADATA_RETRY_DELAY_MS = 300
const COVER_REVOKE_GRACE_MS = 1_000

type MusicSourceReason =
  'deferred-auto' | 'restore' | 'seek' | 'track-change' | 'user'

interface PendingSeek {
  readonly trackUrl: string
  readonly sourceVersion: number
  readonly kind: 'seconds' | 'ratio'
  readonly value: number
}

interface PendingSeekRequest {
  readonly kind: PendingSeek['kind']
  readonly value: number
}

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
  readonly displayTitles?: Readonly<Record<string, string>>
  readonly random?: () => number
  readonly getConfig?: (key: string) => string | null
  readonly setConfig?: (key: string, value: string | boolean | number) => void
  readonly window?: Window
  readonly navigator?: Navigator
  readonly createMediaMetadata?: (init: MediaMetadataInit) => MediaMetadata
  readonly createObjectURL?: (blob: Blob) => string
  readonly revokeObjectURL?: (url: string) => void
}

export interface MusicController {
  readonly playList: readonly string[]
  readonly userPaused: boolean
  consumeInitialThemeRestoreProtection(): boolean
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
  suspendForVideo(): void
  resumeFromVideo(): void
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

export function normalizeSeekProgress(progress: number): number | undefined {
  if (!Number.isFinite(progress)) return undefined
  return Math.min(1, Math.max(0, progress))
}

function fileNameFromUrl(url: string, includeExtension: boolean): string {
  const encodedName = url.slice(url.lastIndexOf('/') + 1)
  const name = decodeURIComponent(encodedName)
  if (includeExtension) return name
  const extensionIndex = name.lastIndexOf('.')
  return extensionIndex > 0 ? name.slice(0, extensionIndex) : name
}

function displayTitleFromUrl(url: string): string {
  const name = fileNameFromUrl(url, false)
  const separator = name.lastIndexOf(' - ')
  return separator >= 0 ? name.slice(separator + 3) : name
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
  private readonly displayTitles: Readonly<Record<string, string>>
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
  private readonly createObjectURL: (blob: Blob) => string
  private readonly revokeObjectURL: (url: string) => void

  private activeIndex = -1
  private elements: MusicControllerElements | undefined
  private listeners: Array<() => void> = []
  private mediaSession: MediaSession | undefined
  private mediaSessionActions = new Set<MediaSessionAction>()
  private timeoutIds = new Set<number>()
  private progressInterval: number | undefined
  private playOrder: number[] = []
  private playlist: string[] = []
  private lastPersistedSecond = -1
  private pendingSeek: PendingSeek | undefined
  private pausedByUser = true
  private videoSuspended = false
  private shouldResumeAfterVideo = false
  private activeTrackUrl: string | undefined
  private requestedTrackUrl: string | undefined
  private readyTrackUrl: string | undefined
  private sourceVersion = 0
  private readySourceVersion = -1
  private restoringPlaybackState = false
  private switchingTrack = false
  private initialThemeRestoreProtection = false
  private metadataVersion = 0
  private coverObjectUrl: string | undefined
  private metadataLoad:
    | {
        readonly url: string
        readonly version: number
        readonly promise: Promise<boolean>
      }
    | undefined
  private pendingCoverRevocations = new Map<string, number>()

  constructor(dependencies: MusicControllerDependencies) {
    this.defaultMusic = dependencies.defaultMusic ?? DEFAULT_MUSIC
    this.musicRoot = dependencies.musicRoot ?? MUSIC_ROOT
    this.officialMusic = dependencies.officialMusic ?? OFFICIAL_MUSIC
    this.displayTitles = dependencies.displayTitles ?? MUSIC_DISPLAY_TITLES
    this.random = dependencies.random ?? Math.random
    this.getConfig = dependencies.getConfig ?? readConfig
    this.setConfig = dependencies.setConfig ?? writeConfig
    this.suppliedWindow = dependencies.window
    this.suppliedNavigator = dependencies.navigator
    this.createMediaMetadata =
      dependencies.createMediaMetadata ?? ((init) => new MediaMetadata(init))
    this.createObjectURL =
      dependencies.createObjectURL ?? ((blob) => URL.createObjectURL(blob))
    this.revokeObjectURL =
      dependencies.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url))
  }

  get playList(): readonly string[] {
    return this.playlist
  }

  get userPaused(): boolean {
    return this.pausedByUser
  }

  private displayTitle(url: string): string {
    return (
      this.displayTitles[fileNameFromUrl(url, true)] ?? displayTitleFromUrl(url)
    )
  }

  consumeInitialThemeRestoreProtection(): boolean {
    const protectedRestore = this.initialThemeRestoreProtection
    this.initialThemeRestoreProtection = false
    this.videoSuspended = false
    this.shouldResumeAfterVideo = false
    return protectedRestore
  }

  init(elements: MusicControllerElements): void {
    this.dispose()
    this.elements = elements
    this.activeIndex = -1
    this.lastPersistedSecond = -1
    this.playOrder = []
    this.pendingSeek = undefined
    this.activeTrackUrl = undefined
    this.requestedTrackUrl = undefined
    this.readyTrackUrl = undefined
    this.sourceVersion = 0
    this.readySourceVersion = -1
    this.restoringPlaybackState = false
    this.switchingTrack = false
    this.initialThemeRestoreProtection = false
    this.loadPlaylist()
    this.bindEvents()
    this.bindMediaSession()
    this.startProgressUpdates()

    const restored = this.restorePlaybackState()
    if (!restored && this.getConfig(PAUSED_CONFIG_KEY) === 'true') {
      this.pausedByUser = true
    } else if (!restored) {
      this.pausedByUser = false
    }
    if (!this.pausedByUser) this.scheduleDeferredPlayback()
  }

  dispose(): void {
    this.metadataVersion += 1
    this.metadataLoad = undefined
    this.releaseCover(false)
    this.releasePendingCovers()
    if (this.elements) this.persistPlaybackState(true)

    this.listeners.forEach((remove) => remove())
    this.listeners = []

    const browserWindow =
      this.suppliedWindow ??
      (typeof window === 'undefined' ? undefined : window)
    this.timeoutIds.forEach((id) => browserWindow?.clearTimeout(id))
    this.timeoutIds.clear()
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
    this.videoSuspended = false
    this.shouldResumeAfterVideo = false

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

    const trackUrl = this.normalizeTrackUrl(url)
    if (index === this.activeIndex && trackUrl === this.activeTrackUrl) return

    this.metadataVersion += 1
    this.metadataLoad = undefined

    const previousTrackUrl = this.requestedTrackUrl
    const wasPlaying = Boolean(previousTrackUrl) && !elements.player.paused
    this.pendingSeek = undefined
    this.activeIndex = index
    this.activeTrackUrl = trackUrl
    if (previousTrackUrl && previousTrackUrl !== trackUrl) {
      this.sourceVersion += 1
      this.requestedTrackUrl = undefined
      this.readyTrackUrl = undefined
      this.readySourceVersion = -1
      this.switchingTrack = true
      elements.player.pause()
      elements.player.removeAttribute('src')
      elements.player.load()
    }
    const title = this.displayTitle(url)
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
    if (wasPlaying) this.beginArtworkLoading()
    else this.showFallbackArtwork()
    this.releaseCover(true)
    if (wasPlaying) this.startPlayback('track-change')
  }

  play(index?: number): void {
    if (index !== undefined) {
      this.setActiveSong(index)
    } else if (this.activeIndex < 0) {
      this.setActiveSong(0)
    }

    this.pausedByUser = false
    this.setConfig(PAUSED_CONFIG_KEY, false)
    this.startPlayback('user')
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
    const normalizedProgress = normalizeSeekProgress(progress)
    if (normalizedProgress === undefined) return
    const player = this.requireElements().player
    const currentTrackUrl = this.getCurrentPlayerTrackUrl()
    if (
      this.activeTrackUrl &&
      this.activeTrackUrl === this.requestedTrackUrl &&
      this.activeTrackUrl === this.readyTrackUrl &&
      this.activeTrackUrl === currentTrackUrl &&
      this.readySourceVersion === this.sourceVersion &&
      Number.isFinite(player.duration) &&
      player.duration > 0
    ) {
      player.currentTime = Math.min(
        Math.max(0, player.duration - 0.25),
        player.duration * normalizedProgress,
      )
      this.updateProgressFromPlayer()
      this.persistPlaybackState(true)
      return
    }
    this.ensurePlayerSource('seek', {
      kind: 'ratio',
      value: normalizedProgress,
    })
  }

  setVolume(volume: number): void {
    this.requireElements().player.volume = volume
  }

  suspendForVideo(): void {
    if (this.videoSuspended) return
    const elements = this.requireElements()
    this.shouldResumeAfterVideo = !this.pausedByUser && !elements.player.paused
    this.videoSuspended = true
    elements.player.pause()
  }

  resumeFromVideo(): void {
    if (!this.videoSuspended) return
    const shouldResume = this.shouldResumeAfterVideo
    this.videoSuspended = false
    this.shouldResumeAfterVideo = false
    if (shouldResume && !this.pausedByUser) this.startPlayback('user')
  }

  restorePlaybackState(): boolean {
    const state = parsePlaybackState(this.getConfig(PLAYBACK_STATE_KEY))
    if (!state) return false

    const index = this.playlist.findIndex(
      (url) => fileNameFromUrl(url, true) === state.song,
    )
    if (index < 0) return false

    this.setActiveSong(index)
    this.pausedByUser = state.paused
    this.setConfig(PAUSED_CONFIG_KEY, state.paused)
    this.restoringPlaybackState = true
    this.initialThemeRestoreProtection = true
    this.ensurePlayerSource('restore', {
      kind: 'seconds',
      value: Math.max(0, state.currentTime),
    })
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

  private normalizeTrackUrl(url: string): string {
    return new URL(url, this.requireElements().list.ownerDocument.baseURI).href
  }

  private getCurrentPlayerTrackUrl(): string | undefined {
    const currentSource = this.requireElements().player.currentSrc
    return currentSource ? this.normalizeTrackUrl(currentSource) : undefined
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
      item.textContent = this.displayTitle(url)
      elements.list.appendChild(item)
    })
    this.setActiveSong(this.defaultMusic)
  }

  private applyPendingSeek(): void {
    const pendingSeek = this.pendingSeek
    if (!pendingSeek) return
    const player = this.requireElements().player
    const currentTrackUrl = this.getCurrentPlayerTrackUrl()
    if (
      !this.activeTrackUrl ||
      pendingSeek.trackUrl !== this.activeTrackUrl ||
      pendingSeek.trackUrl !== this.requestedTrackUrl ||
      pendingSeek.trackUrl !== this.readyTrackUrl ||
      pendingSeek.trackUrl !== currentTrackUrl ||
      pendingSeek.sourceVersion !== this.sourceVersion ||
      pendingSeek.sourceVersion !== this.readySourceVersion
    ) {
      return
    }
    const duration = player.duration
    if (!Number.isFinite(duration) || duration <= 0) return

    const requestedTime =
      pendingSeek.kind === 'ratio'
        ? duration * pendingSeek.value
        : pendingSeek.value
    if (!Number.isFinite(requestedTime)) return

    const upperBound = Math.max(0, duration - 0.25)
    player.currentTime = Math.max(0, Math.min(requestedTime, upperBound))
    this.lastPersistedSecond = Math.floor(player.currentTime)
    this.pendingSeek = undefined
    const wasRestoring = this.restoringPlaybackState
    this.restoringPlaybackState = false
    this.switchingTrack = false
    this.updateProgressFromPlayer()
    if (
      wasRestoring ||
      pendingSeek.kind === 'ratio' ||
      pendingSeek.value > 0 ||
      this.pausedByUser
    ) {
      this.persistPlaybackState(true)
    }
  }

  private ensurePlayerSource(
    reason: MusicSourceReason,
    pendingSeek?: PendingSeekRequest,
  ): void {
    const elements = this.requireElements()
    const url = this.playlist[this.getPlayingIndex()]
    if (!url) return
    const trackUrl = this.normalizeTrackUrl(url)
    this.activeTrackUrl = trackUrl
    const version = this.metadataVersion
    if (
      !this.metadataLoad ||
      this.metadataLoad.url !== url ||
      this.metadataLoad.version !== version
    ) {
      this.beginArtworkLoading()
      const promise = this.loadActiveMetadata(url, version)
      void promise.then(
        (successful) => {
          if (!successful && this.metadataLoad?.promise === promise)
            this.metadataLoad = undefined
        },
        () => {
          if (this.metadataLoad?.promise === promise)
            this.metadataLoad = undefined
        },
      )
      this.metadataLoad = { url, version, promise }
    }

    if (this.requestedTrackUrl !== trackUrl) {
      this.sourceVersion += 1
      this.requestedTrackUrl = trackUrl
      this.readyTrackUrl = undefined
      this.readySourceVersion = -1
      this.switchingTrack = true
      const request = pendingSeek ?? { kind: 'seconds', value: 0 }
      this.pendingSeek = {
        trackUrl,
        sourceVersion: this.sourceVersion,
        ...request,
      }
      elements.player.src = trackUrl
      elements.player.load()
      markPerformanceEvent('music-network-start', {
        reason,
        song: fileNameFromUrl(url, true),
      })
    } else if (pendingSeek) {
      this.pendingSeek = {
        trackUrl,
        sourceVersion: this.sourceVersion,
        ...pendingSeek,
      }
    }
  }

  private handleSourceMetadataReady(): void {
    const elements = this.requireElements()
    const currentTrackUrl = this.getCurrentPlayerTrackUrl()
    if (
      elements.player.readyState < 1 ||
      !currentTrackUrl ||
      currentTrackUrl !== this.activeTrackUrl ||
      currentTrackUrl !== this.requestedTrackUrl
    ) {
      return
    }

    this.readyTrackUrl = currentTrackUrl
    this.readySourceVersion = this.sourceVersion
    this.switchingTrack = false
    this.applyPendingSeek()
    this.updateProgressFromPlayer()
  }

  private releaseCover(deferred: boolean): void {
    if (!this.coverObjectUrl) return
    const url = this.coverObjectUrl
    this.coverObjectUrl = undefined
    if (!deferred) {
      this.revokeObjectURL(url)
      return
    }
    if (this.pendingCoverRevocations.has(url)) return
    const id = this.getWindow().setTimeout(() => {
      this.pendingCoverRevocations.delete(url)
      this.revokeObjectURL(url)
    }, COVER_REVOKE_GRACE_MS)
    this.pendingCoverRevocations.set(url, id)
  }

  private beginArtworkLoading(): void {
    const image = this.requireElements().playerImg
    delete image.dataset.artwork
    image.setAttribute('aria-busy', 'true')
    image.style.visibility = 'hidden'
  }

  private showFallbackArtwork(): void {
    const image = this.requireElements().playerImg
    delete image.dataset.artwork
    image.removeAttribute('aria-busy')
    image.src = '/res/music_note.svg'
    image.style.removeProperty('visibility')
  }

  private showArtwork(url: string): void {
    const image = this.requireElements().playerImg
    image.src = url
    image.dataset.artwork = 'true'
    image.removeAttribute('aria-busy')
    image.style.removeProperty('visibility')
  }

  private releasePendingCovers(): void {
    const browserWindow =
      this.suppliedWindow ??
      (typeof window === 'undefined' ? undefined : window)
    this.pendingCoverRevocations.forEach((id, url) => {
      browserWindow?.clearTimeout(id)
      this.revokeObjectURL(url)
    })
    this.pendingCoverRevocations.clear()
  }

  private metadataStillCurrent(url: string, version: number): boolean {
    return (
      version === this.metadataVersion &&
      this.playlist[this.getPlayingIndex()] === url &&
      Boolean(this.elements)
    )
  }

  private async waitForMetadataRetry(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.getWindow().setTimeout(resolve, METADATA_RETRY_DELAY_MS)
    })
  }

  private async loadActiveMetadata(
    url: string,
    version: number,
  ): Promise<boolean> {
    let metadata = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        metadata = await readMusicMetadata(url)
      } catch (error) {
        reportMusicMetadataDiagnostic({
          song: fileNameFromUrl(url, true),
          reader: 'XhrFileReader',
          requestMode: 'range-get (avoid-head)',
          stage: 'controller-retry',
          attempt,
          error,
        })
      }
      if (!this.metadataStillCurrent(url, version)) return false
      if (metadata) break
      if (attempt < 2) {
        await this.waitForMetadataRetry()
        if (!this.metadataStillCurrent(url, version)) return false
      }
    }
    if (!metadata || !this.metadataStillCurrent(url, version)) {
      if (this.metadataStillCurrent(url, version)) this.showFallbackArtwork()
      return false
    }

    const elements = this.elements
    if (!elements) return false
    const index = this.playlist.indexOf(url)
    const title = metadata.title ?? this.displayTitle(url)
    const artist = metadata.artist ?? 'elytrue.com'

    let artworkUrl: string | undefined
    if (metadata.artwork) {
      try {
        const bytes = metadata.artwork.data.slice()
        const buffer = bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer
        artworkUrl = this.createObjectURL(
          new Blob([buffer], {
            type: metadata.artwork.type,
          }),
        )
        const probe = elements.playerImg.ownerDocument.createElement('img')
        probe.src = artworkUrl
        await probe.decode()
        if (!this.metadataStillCurrent(url, version)) {
          this.revokeObjectURL(artworkUrl)
          return false
        }
        this.releaseCover(true)
        this.coverObjectUrl = artworkUrl
        this.showArtwork(artworkUrl)
        reportMusicMetadataDiagnostic({
          song: fileNameFromUrl(url, true),
          reader: 'XhrFileReader',
          requestMode: 'range-get (avoid-head)',
          stage: 'decode',
          pictureFormat: metadata.artwork.type,
          pictureBytes: bytes.byteLength,
        })
      } catch (error) {
        if (artworkUrl && artworkUrl !== this.coverObjectUrl)
          this.revokeObjectURL(artworkUrl)
        artworkUrl = undefined
        reportMusicMetadataDiagnostic({
          song: fileNameFromUrl(url, true),
          reader: 'XhrFileReader',
          requestMode: 'range-get (avoid-head)',
          stage: 'blob/decode',
          error,
        })
      }
    }
    Array.from(elements.titles).forEach((element) => {
      element.textContent = title
    })
    if (index >= 0) elements.list.children[index]!.textContent = title
    if (!artworkUrl) this.showFallbackArtwork()
    const mediaSession = this.getNavigator().mediaSession
    if (mediaSession) {
      mediaSession.metadata = this.createMediaMetadata({
        title,
        artist,
        ...(metadata.album ? { album: metadata.album } : {}),
        ...(artworkUrl && metadata.artwork
          ? {
              artwork: [{ src: artworkUrl, type: metadata.artwork.type }],
            }
          : {}),
      })
    }
    return !metadata.artwork || Boolean(artworkUrl)
  }

  private startPlayback(reason: MusicSourceReason): void {
    if (this.videoSuspended) return
    const player = this.requireElements().player
    this.ensurePlayerSource(reason)
    void player.play().catch(() => undefined)
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
    if (!elements || !url || this.restoringPlaybackState || this.switchingTrack)
      return
    const activeTrackUrl = this.normalizeTrackUrl(url)
    const currentTrackUrl = this.getCurrentPlayerTrackUrl()
    if (
      activeTrackUrl !== this.activeTrackUrl ||
      activeTrackUrl !== this.requestedTrackUrl ||
      activeTrackUrl !== this.readyTrackUrl ||
      activeTrackUrl !== currentTrackUrl ||
      this.readySourceVersion !== this.sourceVersion ||
      this.pendingSeek
    ) {
      return
    }
    const currentTime = elements.player.currentTime
    if (!Number.isFinite(currentTime) || (!force && currentTime <= 0)) return
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
    })
    this.listen(elements.player, 'pause', () => {
      Array.from(elements.playingIndicators).forEach((indicator) =>
        indicator.classList.remove('playing'),
      )
    })
    this.listen(elements.player, 'loadedmetadata', () =>
      this.handleSourceMetadataReady(),
    )
    this.listen(elements.player, 'durationchange', () =>
      this.handleSourceMetadataReady(),
    )
    this.listen(elements.player, 'timeupdate', () =>
      this.persistPlaybackState(),
    )
    this.listen(elements.player, 'ended', () => this.playNext())
    this.listen(this.getWindow(), 'pagehide', () =>
      this.persistPlaybackState(true),
    )
    this.listen(elements.list.ownerDocument, 'click', () => {
      if (!this.videoSuspended && !this.pausedByUser && elements.player.paused)
        this.play()
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
    this.progressInterval = this.getWindow().setInterval(() => {
      this.updateProgressFromPlayer()
    }, 500)
  }

  private updateProgressFromPlayer(): void {
    const elements = this.requireElements()
    const currentTime = elements.player.currentTime
    const duration = elements.player.duration
    if (
      !Number.isFinite(currentTime) ||
      !Number.isFinite(duration) ||
      duration <= 0
    ) {
      return
    }
    elements.progressSlider.progress = currentTime / duration
  }

  private scheduleDeferredPlayback(): void {
    if (savesData(this.getNavigator())) return

    const browserWindow = this.getWindow()
    const document = this.requireElements().list.ownerDocument
    const start = () => {
      this.setTimeout(() => {
        const player = this.requireElements().player
        if (!this.videoSuspended && !this.pausedByUser && player.paused) {
          this.startPlayback('deferred-auto')
        }
      }, 1_200)
    }

    if (document.readyState === 'complete') {
      start()
    } else {
      this.listen(browserWindow, 'load', start, { once: true })
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
