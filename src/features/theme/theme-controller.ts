import { reactive, readonly, type InjectionKey } from 'vue'

interface ThemeControllerDependencies {
  logError(error: unknown, message: string): void
  onThemeMusicChanged(name: string): void
  setOneTimeCss(element: HTMLElement, styles: Record<string, string>): void
  shuffle<T>(items: T[]): T[]
}

interface ThemeElements {
  bgs: HTMLCollectionOf<Element>
  captionContainer: HTMLElement
  captions: HTMLCollection
  themeIndicators: HTMLCollection
}

interface CaptionBlock {
  group: string
  items: HTMLElement[]
}

const mutableThemeState = reactive({
  currentBackground: -1,
  currentCaption: -1,
  theme: '',
})

export const themeState = readonly(mutableThemeState)

export function resolveThemeSelection(
  theme: string | undefined,
  automaticTheme: string,
): string {
  return theme || automaticTheme
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
  readonly theme: string
  getAutoTheme(): string
  getCurrentBgCount(): number
  getCurrentBgs(): NodeListOf<HTMLElement>
  getThemeMusic(): string
  dispose(): void
  init(): void
  nextCaption(): void
  nextImg(): void
  prepareVisitOrder(): void
  set(theme: string): void
  setTheme(theme?: string): void
}

class ThemeControllerImpl implements ThemeController {
  private readonly dependencies: ThemeControllerDependencies
  private elements!: ThemeElements
  private readonly timers = new TimerCollection()
  private readonly themes: Record<string, string> = {
    '#default-theme': 'default',
  }
  private lastAutoTheme: string | undefined
  private layoutQuery?: MediaQueryList
  private relayout?: () => void

  constructor(dependencies: ThemeControllerDependencies) {
    this.dependencies = dependencies
  }

  private resolveElements(): ThemeElements {
    return {
      bgs: document.getElementsByClassName('mainbg'),
      captionContainer: this.requireElement('mainCaptions'),
      captions: this.requireElement('mainCaptions').children,
      themeIndicators: this.requireElement('currentTheme').children,
    }
  }

  get theme(): string {
    return mutableThemeState.theme
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

  init(): void {
    this.elements = this.resolveElements()
    this.prepareVisitOrder()
    this.setTheme(this.themes[location.hash])
    this.layoutQuery = window.matchMedia('(max-width: 720px)')
    this.relayout = () => {
      this.prepareVisitOrder()
      this.setTheme()
    }
    if (this.layoutQuery.addEventListener) {
      this.layoutQuery.addEventListener('change', this.relayout)
    } else {
      this.layoutQuery.addListener(this.relayout)
    }
    this.timers.setInterval(() => {
      const newAutoTheme = this.getAutoTheme()
      if (this.lastAutoTheme && this.lastAutoTheme !== newAutoTheme) {
        this.setTheme()
      }
      this.lastAutoTheme = newAutoTheme
    }, 1_000)
  }

  dispose(): void {
    this.timers.clear()
    if (this.layoutQuery && this.relayout) {
      if (this.layoutQuery.removeEventListener) {
        this.layoutQuery.removeEventListener('change', this.relayout)
      } else {
        this.layoutQuery.removeListener(this.relayout)
      }
    }
    this.layoutQuery = undefined
    this.relayout = undefined
  }

  prepareVisitOrder(): void {
    document
      .querySelectorAll<HTMLElement>('.mainbg[data-layout]')
      .forEach((background) => background.classList.add('defaultbg'))
    const activeLayout = window.matchMedia('(max-width: 720px)').matches
      ? 'portrait'
      : 'landscape'
    const allBackgrounds = Array.from(
      document.querySelectorAll<HTMLElement>('.mainbg.defaultbg'),
    )
    const backgrounds = allBackgrounds.filter(
      (background) => background.dataset.layout === activeLayout,
    )
    allBackgrounds
      .filter((background) => background.dataset.layout !== activeLayout)
      .forEach((background) => background.classList.remove('defaultbg'))
    this.dependencies.shuffle(backgrounds)
    backgrounds.forEach((background) => {
      background.dataset.activeSrc = background.dataset.src
      this.elements.captionContainer.before(background)
    })
    const firstBackground = backgrounds[0]?.dataset.activeSrc
    if (firstBackground) {
      const preload = document.createElement('link')
      preload.rel = 'preload'
      preload.as = 'image'
      preload.type = 'image/webp'
      preload.href = firstBackground
      preload.fetchPriority = 'high'
      document.head.appendChild(preload)
    }

    const blocks: CaptionBlock[] = []
    document
      .querySelectorAll<HTMLElement>('.defaultCaption')
      .forEach((caption) => {
        const group = caption.dataset.sequenceGroup || ''
        const lastBlock = blocks.at(-1)
        if (group && lastBlock?.group === group) {
          lastBlock.items.push(caption)
        } else {
          blocks.push({ group, items: [caption] })
        }
      })
    this.dependencies.shuffle(blocks)
    blocks
      .flatMap((block) => block.items)
      .forEach((caption) => this.elements.captionContainer.appendChild(caption))
  }

  getAutoTheme(): string {
    return 'default'
  }

  set(theme: string): void {
    this.setTheme(theme)
  }

  setTheme(theme?: string): void {
    const resolvedTheme = resolveThemeSelection(theme, this.getAutoTheme())
    Array.from(this.elements.bgs).forEach((element) => {
      element.classList.remove('ready', 'animating', 'visible')
    })
    Array.from(this.elements.captions).forEach((element) => {
      element.classList.remove('visible')
    })
    Array.from(this.elements.themeIndicators).forEach((element) => {
      element.classList.remove('visible')
    })
    try {
      this.requireElement(`themeTxt-${resolvedTheme}`).classList.add('visible')
    } catch (error) {
      this.dependencies.logError(error, 'theme indicator text not defined')
    }

    this.timers.clear()
    mutableThemeState.theme = resolvedTheme
    mutableThemeState.currentBackground = this.getCurrentBgCount() - 1
    mutableThemeState.currentCaption = -1
    this.getCurrentBgs()[0]?.classList.add('bgzoom')
    this.elements.captionContainer.style.opacity = '0'
    this.dependencies.setOneTimeCss(this.elements.captionContainer, {
      transition: 'none',
    })
    this.nextImg()
    this.nextCaption()
    if (this.getCurrentBgCount() > 1) {
      this.timers.setInterval(() => this.nextImg(), 8_000)
      this.timers.setInterval(() => this.nextCaption(), 8_000)
    }
    this.dependencies.onThemeMusicChanged(this.getThemeMusic())
  }

  getThemeMusic(): string {
    return 'Elysian Realm'
  }

  getCurrentBgs(): NodeListOf<HTMLElement> {
    return document.querySelectorAll<HTMLElement>(
      `.mainbg.${mutableThemeState.theme}bg`,
    )
  }

  getCurrentBgCount(): number {
    return document.getElementsByClassName(`${mutableThemeState.theme}bg`)
      .length
  }

  nextImg(): void {
    const previous = mutableThemeState.currentBackground
    mutableThemeState.currentBackground =
      previous + 1 < this.getCurrentBgCount() ? previous + 1 : 0
    const next =
      mutableThemeState.currentBackground + 1 < this.getCurrentBgCount()
        ? mutableThemeState.currentBackground + 1
        : 0
    const backgrounds = this.getCurrentBgs()
    try {
      backgrounds[previous]?.classList.remove('visible')
      const current = backgrounds[mutableThemeState.currentBackground]
      if (!current) throw new Error('Current theme background is missing')
      current.classList.add('ready', 'animating', 'visible')
      const currentSource =
        current.dataset.activeSrc || current.dataset.src || ''
      const currentLayer = current.firstElementChild
      if (currentLayer instanceof HTMLElement) {
        currentLayer.style.backgroundImage = `url("${currentSource}")`
      }
      if (previous === mutableThemeState.currentBackground) return
      this.timers.setTimeout(() => {
        backgrounds[previous]?.classList.remove('ready', 'animating')
        const upcoming = backgrounds[next]
        upcoming?.classList.add('ready')
        upcoming?.classList.remove('bgzoom')
        const nextSource =
          upcoming?.dataset.activeSrc || upcoming?.dataset.src || ''
        const nextLayer = upcoming?.firstElementChild
        if (nextLayer instanceof HTMLElement) {
          nextLayer.style.backgroundImage = `url("${nextSource}")`
        }
      }, 2_500)
    } catch (error) {
      this.dependencies.logError(error, 'failed to show next image')
    }
  }

  nextCaption(): void {
    let themeCaptions: HTMLCollectionOf<Element>
    try {
      themeCaptions = document.getElementsByClassName(
        `${mutableThemeState.theme}Caption`,
      )
    } catch (error) {
      this.dependencies.logError(error, 'failed to select caption')
      return
    }
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
