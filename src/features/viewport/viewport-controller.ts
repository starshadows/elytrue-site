export interface ViewportClassList {
  add(...tokens: string[]): void
  contains(token: string): boolean
  remove(...tokens: string[]): void
}

export interface ViewportElements {
  readonly body: { readonly classList: ViewportClassList }
  readonly comments: {
    clientHeight: number
    clientWidth: number
    scrollHeight: number
    scrollLeft: number
    scrollTop: number
    scrollWidth: number
  }
  readonly fullscreenButton: { innerHTML: string }
  readonly getActiveElement: () => EventTarget | null
  readonly messageInput?: EventTarget & { blur(): void }
  readonly newCommentBox?: { readonly offsetHeight: number }
  readonly wallpaperStyle?: { textContent: string | null }
}

export interface WallpaperProperty {
  readonly value: number
}

export type WallpaperProperties = Readonly<
  Record<string, WallpaperProperty | undefined>
>

export interface WallpaperPropertyListener {
  applyUserProperties(properties: WallpaperProperties): void
}

export interface ViewportControllerCallbacks {
  closeImageViewer(): void
  closePopup(): void
  forceLowerPanelDown(): void
  getPageScale(): number
  isImageViewerOpen(): boolean
  isPopupOpen(): boolean
  pauseCommentsScroll(milliseconds: number): void
  setMusicVolume(volume: number): void
  setPageScale(scale: number): void
  updateTimelineActiveMonth(scroll: boolean): void
}

export interface ViewportControllerOptions {
  readonly cancelScheduled?: (handle: number) => void
  readonly documentTarget?: EventTarget
  readonly getHash?: () => string
  readonly registerWallpaperListener?: (
    listener: WallpaperPropertyListener,
  ) => () => void
  readonly resolveElements?: () => ViewportElements
  readonly schedule?: (callback: () => void, delay: number) => number
  readonly setHash?: (hash: string) => void
  readonly windowTarget?: EventTarget
}

export interface ViewportController {
  readonly isFullscreen: boolean
  applyWallpaperProperties(properties: WallpaperProperties): void
  detectTouchKeyboard(): void
  dispose(): void
  init(): void
  setFullscreen(fullscreen: boolean): void
  toggleFullscreen(): void
}

export function getScrollProgress(
  offset: number,
  scrollSize: number,
  clientSize: number,
): number {
  const range = scrollSize - clientSize
  if (range <= 0) return 0
  return Math.max(0, Math.min(1, offset / range))
}

export function getScrollOffset(
  progress: number,
  scrollSize: number,
  clientSize: number,
): number {
  return (
    Math.max(0, scrollSize - clientSize) * Math.max(0, Math.min(1, progress))
  )
}

function getUrlHash(url: string): string {
  const hashIndex = url.indexOf('#')
  return hashIndex === -1 ? '' : url.slice(hashIndex)
}

function isEscapeEvent(event: Event): boolean {
  if ('key' in event && event.key === 'Escape') return true
  return 'keyCode' in event && event.keyCode === 27
}

class ViewportControllerImpl implements ViewportController {
  private readonly callbacks: ViewportControllerCallbacks
  private documentTarget?: EventTarget
  private elements?: ViewportElements
  private fullscreen = false
  private initialized = false
  private readonly options: ViewportControllerOptions
  private scheduled?: number
  private unregisterWallpaperListener?: () => void
  private windowTarget?: EventTarget

  constructor(
    callbacks: ViewportControllerCallbacks,
    options: ViewportControllerOptions,
  ) {
    this.callbacks = callbacks
    this.options = options
  }

  get isFullscreen(): boolean {
    return this.fullscreen
  }

  init(): void {
    if (this.initialized) return
    this.windowTarget = this.options.windowTarget ?? window
    this.documentTarget = this.options.documentTarget ?? document
    this.elements = this.options.resolveElements
      ? this.options.resolveElements()
      : this.resolveDomElements(document)

    this.windowTarget.addEventListener('resize', this.handleResize)
    this.windowTarget.addEventListener('hashchange', this.handleHashChange)
    this.documentTarget.addEventListener('keydown', this.handleKeyDown)
    this.unregisterWallpaperListener = (
      this.options.registerWallpaperListener ?? this.registerOnWindow
    )(this.wallpaperListener)
    this.initialized = true

    const hash = this.options.getHash?.() ?? window.location.hash
    if (hash === '#view-img' || hash === '#popup') {
      this.setHash('')
    }
    this.detectTouchKeyboard()
  }

  dispose(): void {
    if (!this.initialized) return
    this.windowTarget?.removeEventListener('resize', this.handleResize)
    this.windowTarget?.removeEventListener('hashchange', this.handleHashChange)
    this.documentTarget?.removeEventListener('keydown', this.handleKeyDown)
    if (this.scheduled !== undefined) {
      ;(this.options.cancelScheduled ?? window.clearTimeout)(this.scheduled)
      this.scheduled = undefined
    }
    this.unregisterWallpaperListener?.()
    this.unregisterWallpaperListener = undefined
    this.elements?.body.classList.remove('fullscreen', 'touchKeyboardShowing')
    this.fullscreen = false
    this.elements = undefined
    this.windowTarget = undefined
    this.documentTarget = undefined
    this.initialized = false
  }

  toggleFullscreen(): void {
    this.setFullscreen(!this.fullscreen)
  }

  setFullscreen(fullscreen: boolean): void {
    if (fullscreen === this.fullscreen) return
    const elements = this.requireElements()
    const comments = elements.comments
    const progress = this.fullscreen
      ? getScrollProgress(
          comments.scrollTop,
          comments.scrollHeight,
          comments.clientHeight,
        )
      : getScrollProgress(
          comments.scrollLeft,
          comments.scrollWidth,
          comments.clientWidth,
        )

    this.fullscreen = fullscreen
    if (fullscreen) elements.body.classList.add('fullscreen')
    else elements.body.classList.remove('fullscreen')
    elements.fullscreenButton.innerHTML = fullscreen
      ? '<span class="ui zh">\u9000\u51FA\u5168\u5C4F \u2199</span><span class="ui en">Collapse \u2199</span>'
      : '<span class="ui zh">\u7AD6\u5C4F \u2195</span><span class="ui en">Expand \u2195</span>'

    if (this.scheduled !== undefined) {
      ;(this.options.cancelScheduled ?? window.clearTimeout)(this.scheduled)
    }
    const applyPosition = () => {
      if (fullscreen) {
        comments.scrollTop = getScrollOffset(
          progress,
          comments.scrollHeight,
          comments.clientHeight,
        )
      } else {
        comments.scrollLeft = getScrollOffset(
          progress,
          comments.scrollWidth,
          comments.clientWidth,
        )
      }
      this.callbacks.updateTimelineActiveMonth(true)
      this.scheduled = undefined
    }
    this.scheduled = (this.options.schedule ?? window.setTimeout)(
      applyPosition,
      35,
    )
    this.callbacks.pauseCommentsScroll(500)
  }

  detectTouchKeyboard(): void {
    if (!this.options.resolveElements && typeof document !== 'undefined') {
      this.elements = this.resolveDomElements(document)
    }
    const elements = this.requireElements()
    const inputFocused =
      elements.messageInput !== undefined &&
      elements.getActiveElement() === elements.messageInput
    const keyboardShowing =
      inputFocused &&
      elements.newCommentBox !== undefined &&
      elements.newCommentBox.offsetHeight < 370 * this.callbacks.getPageScale()
    if (keyboardShowing) {
      elements.body.classList.add('touchKeyboardShowing')
    } else {
      elements.body.classList.remove('touchKeyboardShowing')
    }
  }

  applyWallpaperProperties(properties: WallpaperProperties): void {
    const scale = properties.ui_scale
    if (scale) this.callbacks.setPageScale(scale.value / 100)

    const bottom = properties.ui_bottom
    const wallpaperStyle = this.requireElements().wallpaperStyle
    if (bottom && wallpaperStyle) {
      wallpaperStyle.textContent = `
#lowerPanel {
  padding-bottom: 0rem;
  transition: transform 0.5s, padding-bottom 0.5s;
}

#lowerPanel:hover:not(.lowerPanelDown), #lowerPanel.lowerPanelUp {
  padding-bottom: ${(bottom.value / 48) * 3}rem;
}
`
    }

    const volume = properties.ui_volume
    if (volume) this.callbacks.setMusicVolume(volume.value / 100)
  }

  private readonly handleResize = (): void => {
    this.detectTouchKeyboard()
  }

  private readonly handleKeyDown = (event: Event): void => {
    if (!isEscapeEvent(event)) return
    if (this.callbacks.isImageViewerOpen()) {
      this.callbacks.closeImageViewer()
    } else if (this.callbacks.isPopupOpen()) {
      this.callbacks.closePopup()
    } else if (this.fullscreen) {
      this.toggleFullscreen()
    } else {
      this.callbacks.forceLowerPanelDown()
    }
  }

  private readonly handleHashChange = (event: Event): void => {
    if (!('oldURL' in event) || typeof event.oldURL !== 'string') return
    const oldHash = getUrlHash(event.oldURL)
    const newHash =
      'newURL' in event && typeof event.newURL === 'string'
        ? getUrlHash(event.newURL)
        : (this.options.getHash?.() ?? window.location.hash)
    if (oldHash === '#view-img') this.callbacks.closeImageViewer()
    if (oldHash === '#popup' && newHash !== '#view-img') {
      this.callbacks.closePopup()
    }
  }

  private readonly wallpaperListener: WallpaperPropertyListener = {
    applyUserProperties: (properties) => {
      this.applyWallpaperProperties(properties)
    },
  }

  private readonly registerOnWindow = (
    listener: WallpaperPropertyListener,
  ): (() => void) => {
    const previous = Reflect.get(window, 'wallpaperPropertyListener')
    Reflect.set(window, 'wallpaperPropertyListener', listener)
    return () => {
      Reflect.set(window, 'wallpaperPropertyListener', previous)
    }
  }

  private setHash(hash: string): void {
    if (this.options.setHash) this.options.setHash(hash)
    else window.location.hash = hash
  }

  private resolveDomElements(documentObject: Document): ViewportElements {
    const comments = documentObject.getElementById('comments')
    const fullscreenButton = documentObject.getElementById('fullscreenBtn')
    if (!comments || !fullscreenButton) {
      throw new Error('Viewport elements are missing')
    }
    const messageInput = documentObject.getElementById('msgText')
    return {
      body: documentObject.body,
      comments,
      fullscreenButton,
      getActiveElement: () => documentObject.activeElement,
      messageInput: messageInput ?? undefined,
      newCommentBox:
        documentObject.getElementById('newCommentBox') ?? undefined,
      wallpaperStyle:
        documentObject.getElementById('wallpaperEngineCSS') ?? undefined,
    }
  }

  private requireElements(): ViewportElements {
    if (!this.elements)
      throw new Error('Viewport controller is not initialized')
    return this.elements
  }
}

export function createViewportController(
  callbacks: ViewportControllerCallbacks,
  options: ViewportControllerOptions = {},
): ViewportController {
  return new ViewportControllerImpl(callbacks, options)
}
