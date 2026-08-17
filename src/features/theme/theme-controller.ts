import { reactive, readonly, type InjectionKey } from 'vue'
import { markPerformanceEvent } from '../../lib/performance'
import {
  IMAGE_THEMES,
  DESKTOP_THEME_SELECTIONS,
  imageThemeForSelection,
  videoThemeForSelection,
  type ImageTheme,
  type ImageThemeId,
  type MediaTheme,
  type ThemeAudience,
  type ThemeSelectionId,
  type VideoTheme,
  type VideoThemeId,
} from '../../config/assets'

const THEME_SELECTION_STORAGE_KEY = 'elytrue.theme-selection:v1'

function readPersistedThemeSelection(): ThemeSelectionId | undefined {
  try {
    const selection = window.localStorage.getItem(THEME_SELECTION_STORAGE_KEY)
    return DESKTOP_THEME_SELECTIONS.includes(selection as ThemeSelectionId)
      ? (selection as ThemeSelectionId)
      : undefined
  } catch {
    return undefined
  }
}

function persistThemeSelection(selection: ThemeSelectionId): void {
  try {
    window.localStorage.setItem(THEME_SELECTION_STORAGE_KEY, selection)
  } catch {
    // Theme selection persistence must never block rendering.
  }
}

export type ThemeMusicChangeReason = 'initial' | 'user' | 'layout' | 'auto'

interface ThemeControllerDependencies {
  logError(error: unknown, message: string): void
  onThemeMusicChanged(name: string, reason: ThemeMusicChangeReason): void
  onVideoThemeChanged(video: VideoTheme | undefined): void
  setOneTimeCss(element: HTMLElement, styles: Record<string, string>): void
  shuffle<T>(items: T[]): T[]
  now?: () => Date
  loadImage?: (source: string) => Promise<void>
}

interface ThemeElements {
  bgs: HTMLCollectionOf<Element>
  captionContainer: HTMLElement
  captions: HTMLCollection
}

interface CaptionBlock {
  group: string
  items: HTMLElement[]
}

const mutableThemeState = reactive({
  currentBackground: -1,
  currentCaption: -1,
  theme: 'auto-landscape' as ImageThemeId | VideoThemeId,
  selection: 'auto' as ThemeSelectionId,
  activeVideo: '' as '' | VideoThemeId,
  captionsVisible: true,
})

export const themeState = readonly(mutableThemeState)

function shanghaiMonthAndDay(date: Date): { month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(date)
  return {
    month: Number(parts.find((part) => part.type === 'month')?.value),
    day: Number(parts.find((part) => part.type === 'day')?.value),
  }
}

export function isShanghaiBirthday(date: Date): boolean {
  const { month, day } = shanghaiMonthAndDay(date)
  return month === 11 && day === 11
}

export function resolveThemeSelection(
  selection: ThemeSelectionId | undefined,
  audience: ThemeAudience,
  date: Date,
): MediaTheme {
  const requested = selection ?? 'auto'
  const video = videoThemeForSelection(requested)
  if (video) return video

  const imageSelection =
    requested === 'auto' && isShanghaiBirthday(date) ? 'birthday' : requested
  const compatible = imageThemeForSelection(imageSelection, audience)
  return (
    compatible ?? imageThemeForSelection('auto', audience) ?? IMAGE_THEMES[0]
  )
}

class TimerCollection {
  private timeouts: number[] = []
  private intervals: number[] = []

  setTimeout(callback: () => void, timeout: number): void {
    while (this.timeouts.length >= 100) this.timeouts.shift()
    this.timeouts.push(window.setTimeout(callback, timeout))
  }

  setInterval(callback: () => void, timeout: number): void {
    this.intervals.push(window.setInterval(callback, timeout))
  }

  clear(): void {
    this.timeouts.forEach((timer) => window.clearTimeout(timer))
    this.intervals.forEach((timer) => window.clearInterval(timer))
    this.timeouts = []
    this.intervals = []
  }
}

export interface ThemeController {
  readonly currentBG: number
  readonly currentCaption: number
  readonly theme: ImageThemeId | VideoThemeId
  readonly selection: ThemeSelectionId
  getAutoTheme(): ImageThemeId
  getCurrentBgCount(): number
  getCurrentBgs(): NodeListOf<HTMLElement>
  getThemeMusic(): string
  dispose(): void
  init(): void
  nextCaption(): void
  nextImg(): void
  returnFromVideo(): void
  set(theme: ThemeSelectionId): void
  setTheme(theme?: ThemeSelectionId, reason?: ThemeMusicChangeReason): void
}

class ThemeControllerImpl implements ThemeController {
  private readonly dependencies: ThemeControllerDependencies
  private elements!: ThemeElements
  private readonly timers = new TimerCollection()
  private readonly hashThemes: Record<string, ThemeSelectionId> = {
    '#default-theme': 'auto',
    '#birthday': 'birthday',
    '#mainline': 'mainline',
    '#summer': 'summer',
    '#youth': 'youth',
    '#for-elysia': 'for-elysia',
  }
  private lastAutoTheme: ImageThemeId | undefined
  private layoutQuery?: MediaQueryList
  private relayout?: () => void
  private autoThemeInterval?: number
  private firstBackgroundTracked = false
  private themeVersion = 0
  private backgroundAdvance: Promise<void> | undefined
  private readonly backgroundLoads = new Map<string, Promise<boolean>>()
  private previousImageSelection: Exclude<ThemeSelectionId, VideoThemeId> =
    'auto'
  private randomizeRestoredImageOrder = false

  constructor(dependencies: ThemeControllerDependencies) {
    this.dependencies = dependencies
  }

  private resolveElements(): ThemeElements {
    return {
      bgs: document.getElementsByClassName('mainbg'),
      captionContainer: this.requireElement('mainCaptions'),
      captions: this.requireElement('mainCaptions').children,
    }
  }

  get theme(): ImageThemeId | VideoThemeId {
    return mutableThemeState.theme
  }

  get selection(): ThemeSelectionId {
    return mutableThemeState.selection
  }

  get currentBG(): number {
    return mutableThemeState.currentBackground
  }

  get currentCaption(): number {
    return mutableThemeState.currentCaption
  }

  private requireElement(id: string): HTMLElement {
    const element = document.getElementById(id)
    if (!element) throw new Error(`Theme element #${id} is missing`)
    return element
  }

  private audience(): ThemeAudience {
    return window.matchMedia('(max-width: 720px)').matches
      ? 'mobile'
      : 'desktop'
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date()
  }

  init(): void {
    this.elements = this.resolveElements()
    this.prepareCaptionOrder()
    const hashSelection = this.hashThemes[location.hash]
    const persistedSelection = readPersistedThemeSelection()
    const initialSelection = hashSelection ?? persistedSelection ?? 'auto'
    const initialTheme = resolveThemeSelection(
      initialSelection,
      this.audience(),
      this.now(),
    )
    this.randomizeRestoredImageOrder =
      !hashSelection &&
      Boolean(persistedSelection) &&
      initialTheme.kind === 'image'
    this.setTheme(initialSelection, 'initial')
    this.layoutQuery = window.matchMedia('(max-width: 720px)')
    this.relayout = () => this.setTheme(mutableThemeState.selection, 'layout')
    if (this.layoutQuery.addEventListener) {
      this.layoutQuery.addEventListener('change', this.relayout)
    } else {
      this.layoutQuery.addListener(this.relayout)
    }
    this.lastAutoTheme = this.getAutoTheme()
    this.autoThemeInterval = window.setInterval(() => {
      const newAutoTheme = this.getAutoTheme()
      if (
        mutableThemeState.selection === 'auto' &&
        this.lastAutoTheme &&
        this.lastAutoTheme !== newAutoTheme
      ) {
        this.setTheme('auto', 'auto')
      }
      this.lastAutoTheme = newAutoTheme
    }, 1_000)
  }

  dispose(): void {
    this.timers.clear()
    if (this.autoThemeInterval !== undefined) {
      window.clearInterval(this.autoThemeInterval)
      this.autoThemeInterval = undefined
    }
    this.themeVersion += 1
    this.backgroundAdvance = undefined
    this.backgroundLoads.clear()
    if (this.layoutQuery && this.relayout) {
      if (this.layoutQuery.removeEventListener) {
        this.layoutQuery.removeEventListener('change', this.relayout)
      } else {
        this.layoutQuery.removeListener(this.relayout)
      }
    }
    this.layoutQuery = undefined
    this.relayout = undefined
    this.lastAutoTheme = undefined
    this.dependencies.onVideoThemeChanged(undefined)
  }

  private prepareCaptionOrder(): void {
    const blocks: CaptionBlock[] = []
    document
      .querySelectorAll<HTMLElement>('.defaultCaption')
      .forEach((caption) => {
        const group = caption.dataset.sequenceGroup || ''
        const lastBlock = blocks.at(-1)
        if (group && lastBlock?.group === group) lastBlock.items.push(caption)
        else blocks.push({ group, items: [caption] })
      })
    this.dependencies.shuffle(blocks)
    blocks
      .flatMap((block) => block.items)
      .forEach((caption) => this.elements.captionContainer.appendChild(caption))
  }

  private prepareBackgroundOrder(
    theme: ImageTheme,
    randomizeFirst: boolean,
  ): void {
    const backgrounds = Array.from(this.getCurrentBgs())
    let visitOrder: HTMLElement[]
    if (theme.automatic) {
      const layout = theme.backgrounds[0]?.layout
      const firstBackgroundId = layout
        ? window.__ELY_VISIT_ASSETS__?.backgroundByLayout[layout]?.id
        : undefined
      const first = backgrounds.find(
        (background) => background.dataset.backgroundId === firstBackgroundId,
      )
      const remaining = backgrounds.filter((background) => background !== first)
      this.dependencies.shuffle(remaining)
      visitOrder = first ? [first, ...remaining] : remaining
    } else if (!randomizeFirst) {
      const [cover, ...remaining] = backgrounds
      this.dependencies.shuffle(remaining)
      visitOrder = cover ? [cover, ...remaining] : remaining
    } else {
      this.dependencies.shuffle(backgrounds)
      visitOrder = backgrounds
    }
    visitOrder.forEach((background) => {
      background.dataset.activeSrc = background.dataset.src
      this.elements.captionContainer.before(background)
    })
  }

  private isCurrentBackground(
    background: HTMLElement,
    version: number,
    themeId: ImageThemeId,
  ): boolean {
    return (
      version === this.themeVersion &&
      mutableThemeState.theme === themeId &&
      background.dataset.themeId === themeId
    )
  }

  private clearInactiveBackgroundState(themeId: ImageThemeId): void {
    Array.from(this.elements.bgs).forEach((element) => {
      if (
        element instanceof HTMLElement &&
        element.dataset.themeId !== themeId
      ) {
        element.classList.remove(
          'ready',
          'animating',
          'visible',
          'bgzoom',
          'theme-switching-in',
          'theme-switching-out',
        )
      }
    })
    document
      .querySelectorAll<HTMLElement>('.backgroundCredit.visible')
      .forEach((credit) => {
        if (credit.dataset.themeId !== themeId) {
          credit.classList.remove('visible')
        }
      })
  }

  private showBackgroundCredit(background: HTMLElement): void {
    const themeId = background.dataset.themeId
    const backgroundId = background.dataset.backgroundId
    document
      .querySelectorAll<HTMLElement>('.backgroundCredit')
      .forEach((credit) => {
        credit.classList.toggle(
          'visible',
          credit.dataset.themeId === themeId &&
            credit.dataset.backgroundId === backgroundId,
        )
      })
  }

  getAutoTheme(): ImageThemeId {
    const resolved = resolveThemeSelection('auto', this.audience(), this.now())
    if (resolved.kind !== 'image')
      throw new Error('Automatic theme must be an image')
    return resolved.id
  }

  set(theme: ThemeSelectionId): void {
    this.setTheme(theme, 'user')
  }

  returnFromVideo(): void {
    this.setTheme(this.previousImageSelection, 'user')
  }

  setTheme(
    selection: ThemeSelectionId = mutableThemeState.selection,
    reason: ThemeMusicChangeReason = 'user',
  ): void {
    const resolved = resolveThemeSelection(
      selection,
      this.audience(),
      this.now(),
    )
    if (reason === 'user') persistThemeSelection(selection)
    const version = ++this.themeVersion
    const wasShowingVideo = mutableThemeState.activeVideo !== ''
    const previousSelection = mutableThemeState.selection
    const outgoingBackgrounds = Array.from(this.elements.bgs).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && element.classList.contains('visible'),
    )
    Array.from(this.elements.bgs).forEach((element) => {
      element.classList.remove('theme-switching-in', 'theme-switching-out')
      if (!outgoingBackgrounds.includes(element as HTMLElement)) {
        element.classList.remove('ready', 'animating', 'visible', 'bgzoom')
      }
    })
    Array.from(this.elements.captions).forEach((element) => {
      element.classList.remove('visible')
    })
    this.timers.clear()
    this.backgroundAdvance = undefined
    mutableThemeState.selection = selection
    mutableThemeState.theme = resolved.id
    mutableThemeState.currentBackground = -1
    mutableThemeState.currentCaption = -1
    mutableThemeState.captionsVisible =
      resolved.kind === 'image' && resolved.showCaptions
    this.elements.captionContainer.style.opacity = '0'

    if (resolved.kind === 'video') {
      if (!wasShowingVideo && !videoThemeForSelection(previousSelection)) {
        this.previousImageSelection = previousSelection as Exclude<
          ThemeSelectionId,
          VideoThemeId
        >
      }
      mutableThemeState.activeVideo = resolved.id
      this.dependencies.onVideoThemeChanged(resolved)
      return
    }

    this.previousImageSelection = selection as Exclude<
      ThemeSelectionId,
      VideoThemeId
    >
    const leavingVideo = wasShowingVideo
    mutableThemeState.activeVideo = ''
    if (leavingVideo) this.dependencies.onVideoThemeChanged(undefined)
    this.prepareBackgroundOrder(resolved, this.randomizeRestoredImageOrder)
    this.randomizeRestoredImageOrder = false
    mutableThemeState.currentBackground = -1
    this.getCurrentBgs()[0]?.classList.add('bgzoom')
    this.dependencies.setOneTimeCss(this.elements.captionContainer, {
      transition: 'none',
    })
    void this.showFirstBackground(resolved, version, outgoingBackgrounds)
    if (resolved.showCaptions) this.nextCaption()
    if (this.getCurrentBgCount() > 1 && resolved.showCaptions) {
      this.timers.setInterval(() => this.nextCaption(), 8_000)
    }
    this.dependencies.onThemeMusicChanged(this.getThemeMusic(), reason)
  }

  getThemeMusic(): string {
    return 'Elysian Realm'
  }

  getCurrentBgs(): NodeListOf<HTMLElement> {
    return document.querySelectorAll<HTMLElement>(
      `.mainbg[data-theme-id="${mutableThemeState.theme}"]`,
    )
  }

  getCurrentBgCount(): number {
    return this.getCurrentBgs().length
  }

  nextImg(): void {
    if (this.backgroundAdvance) return
    const version = this.themeVersion
    const advance = this.advanceBackground(version).finally(() => {
      if (this.backgroundAdvance === advance) this.backgroundAdvance = undefined
    })
    this.backgroundAdvance = advance
  }

  private async showFirstBackground(
    theme: ImageTheme,
    version: number,
    outgoingBackgrounds: HTMLElement[],
  ): Promise<void> {
    const backgrounds = Array.from(this.getCurrentBgs())
    for (let index = 0; index < backgrounds.length; index += 1) {
      const current = backgrounds[index]
      if (!current || !(await this.prepareBackground(current, version)))
        continue
      if (!this.isCurrentBackground(current, version, theme.id)) return
      mutableThemeState.currentBackground = index
      current.classList.add('theme-switching-in', 'animating', 'visible')
      this.showBackgroundCredit(current)
      const outgoing = outgoingBackgrounds.filter(
        (background) => background !== current,
      )
      outgoing.forEach((background) => {
        background.classList.add('theme-switching-out')
        background.classList.remove('ready', 'animating', 'visible', 'bgzoom')
      })
      this.clearInactiveBackgroundState(theme.id)
      requestAnimationFrame(() => {
        if (!this.isCurrentBackground(current, version, theme.id)) return
        current.classList.remove('theme-switching-in')
        outgoing.forEach((background) =>
          background.classList.remove('theme-switching-out'),
        )
        this.clearInactiveBackgroundState(theme.id)
      })
      this.trackFirstBackground(
        current,
        current.dataset.activeSrc || current.dataset.src || '',
      )
      if (theme.backgrounds.length > 1) {
        this.scheduleBackgroundAdvance(version, theme.id)
      }
      return
    }
    this.dependencies.logError(
      new Error(`No background could be decoded for ${theme.id}`),
      'failed to show first image',
    )
  }

  private async advanceBackground(version: number): Promise<void> {
    const themeId = mutableThemeState.theme
    const count = this.getCurrentBgCount()
    if (
      count <= 1 ||
      version !== this.themeVersion ||
      !IMAGE_THEMES.some((theme) => theme.id === themeId)
    )
      return
    const imageThemeId = themeId as ImageThemeId
    const previous = mutableThemeState.currentBackground
    const backgrounds = this.getCurrentBgs()
    try {
      for (let offset = 1; offset < count; offset += 1) {
        const currentIndex = (previous + offset) % count
        const current = backgrounds[currentIndex]
        if (
          !current ||
          !(await this.prepareBackground(current, version, imageThemeId))
        ) {
          continue
        }
        if (!this.isCurrentBackground(current, version, imageThemeId)) return
        const outgoing = backgrounds[previous]
        current.classList.add('animating')
        current.classList.remove('bgzoom')
        void current.offsetWidth
        outgoing?.classList.remove('visible')
        current.classList.add('visible')
        this.showBackgroundCredit(current)
        mutableThemeState.currentBackground = currentIndex
        this.timers.setTimeout(() => {
          if (!this.isCurrentBackground(current, version, imageThemeId)) return
          outgoing?.classList.remove('ready', 'animating', 'bgzoom')
          this.clearInactiveBackgroundState(imageThemeId)
        }, 2_500)
        void this.preloadNextBackground(version, imageThemeId)
        this.scheduleBackgroundAdvance(version, imageThemeId)
        return
      }
      this.scheduleBackgroundAdvance(version, imageThemeId)
    } catch (error) {
      this.dependencies.logError(error, 'failed to show next image')
      if (
        version === this.themeVersion &&
        mutableThemeState.theme === themeId
      ) {
        this.scheduleBackgroundAdvance(version, imageThemeId)
      }
    }
  }

  private scheduleBackgroundAdvance(
    version: number,
    themeId: ImageThemeId,
  ): void {
    this.timers.setTimeout(() => {
      if (
        version === this.themeVersion &&
        mutableThemeState.theme === themeId
      ) {
        this.nextImg()
      }
    }, 8_000)
  }

  private async preloadNextBackground(
    version: number,
    themeId: ImageThemeId,
  ): Promise<void> {
    const count = this.getCurrentBgCount()
    if (
      count <= 1 ||
      version !== this.themeVersion ||
      mutableThemeState.theme !== themeId
    )
      return
    const next = (mutableThemeState.currentBackground + 1) % count
    const background = this.getCurrentBgs()[next]
    if (background) await this.prepareBackground(background, version, themeId)
  }

  private prepareBackground(
    background: HTMLElement,
    version: number,
    themeId: ImageThemeId = mutableThemeState.theme as ImageThemeId,
  ): Promise<boolean> {
    const source = background.dataset.activeSrc || background.dataset.src || ''
    if (!source || !this.isCurrentBackground(background, version, themeId)) {
      return Promise.resolve(false)
    }
    let load = this.backgroundLoads.get(source)
    if (!load) {
      load = this.loadBackgroundSource(source)
      this.backgroundLoads.set(source, load)
    }
    return load.then((loaded) => {
      if (!loaded || !this.isCurrentBackground(background, version, themeId))
        return false
      const layer = background.firstElementChild
      if (!(layer instanceof HTMLElement)) return false
      layer.style.backgroundImage = `url("${source}")`
      background.classList.add('ready')
      return true
    })
  }

  private async loadBackgroundSource(source: string): Promise<boolean> {
    try {
      if (this.dependencies.loadImage) {
        await this.dependencies.loadImage(source)
        return true
      }
      const image = new Image()
      image.decoding = 'async'
      image.src = source
      await image.decode()
      return true
    } catch (error) {
      this.dependencies.logError(error, `failed to decode background ${source}`)
      return false
    }
  }

  private trackFirstBackground(background: HTMLElement, source: string): void {
    if (this.firstBackgroundTracked || !source) return
    this.firstBackgroundTracked = true
    markPerformanceEvent('first-background-requested', {
      id: background.dataset.backgroundId,
      source,
    })
    markPerformanceEvent('first-background-ready', {
      id: background.dataset.backgroundId,
      source,
    })
    document.getElementById('initialBackground')?.remove()
    document.documentElement.style.removeProperty('--ely-initial-background')
    document.documentElement.style.removeProperty('--ely-initial-position')
  }

  nextCaption(): void {
    if (!mutableThemeState.captionsVisible) return
    const themeCaptions = document.getElementsByClassName('defaultCaption')
    if (themeCaptions.length === 1) {
      this.timers.setTimeout(() => {
        themeCaptions[0]?.classList.add('visible')
        this.elements.captionContainer.style.opacity = '1'
      }, 500)
      return
    }
    this.elements.captionContainer.style.opacity = '0'
    this.timers.setTimeout(() => {
      Array.from(themeCaptions).forEach((caption) =>
        caption.classList.remove('visible'),
      )
      mutableThemeState.currentCaption =
        mutableThemeState.currentCaption < themeCaptions.length - 1
          ? mutableThemeState.currentCaption + 1
          : 0
      themeCaptions[mutableThemeState.currentCaption]?.classList.add('visible')
      this.elements.captionContainer.style.opacity = '1'
    }, 1_500)
  }
}

export function createThemeController(
  dependencies: ThemeControllerDependencies,
): ThemeController {
  return new ThemeControllerImpl(dependencies)
}

export const themeControllerKey: InjectionKey<ThemeController> =
  Symbol('theme-controller')
