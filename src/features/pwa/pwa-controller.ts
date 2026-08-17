export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
}

export interface PwaState {
  readonly canInstall: boolean
  readonly isStandalone: boolean
}

export interface PwaControllerOptions {
  readonly eventTarget?: EventTarget
  readonly getDocumentReferrer?: () => string
  readonly isNavigatorStandalone?: () => boolean
  readonly matchesStandaloneDisplayMode?: () => boolean
  readonly onStateChange?: (state: PwaState) => void
}

export interface PwaController {
  readonly canInstall: boolean
  readonly isStandalone: boolean
  dispose(): void
  init(): void
  prompt(): Promise<boolean>
}

function isBeforeInstallPromptEvent(
  event: Event,
): event is BeforeInstallPromptEvent {
  return 'prompt' in event && typeof event.prompt === 'function'
}

class PwaControllerImpl implements PwaController {
  private deferredPrompt?: BeforeInstallPromptEvent
  private eventTarget?: EventTarget
  private initialized = false
  private readonly options: PwaControllerOptions
  private standalone = false

  constructor(options: PwaControllerOptions) {
    this.options = options
  }

  get canInstall(): boolean {
    return this.deferredPrompt !== undefined
  }

  get isStandalone(): boolean {
    return this.standalone
  }

  init(): void {
    if (this.initialized) return
    this.eventTarget = this.options.eventTarget ?? window
    this.standalone =
      (this.options.matchesStandaloneDisplayMode?.() ??
        window.matchMedia('(display-mode: standalone)').matches) ||
      (this.options.isNavigatorStandalone?.() ??
        ('standalone' in navigator && navigator.standalone === true)) ||
      (this.options.getDocumentReferrer?.() ?? document.referrer).includes(
        'android-app://',
      )
    this.eventTarget.addEventListener(
      'beforeinstallprompt',
      this.handleBeforeInstallPrompt,
    )
    this.eventTarget.addEventListener('appinstalled', this.handleInstalled)
    this.initialized = true
    this.notify()
  }

  dispose(): void {
    if (!this.initialized || !this.eventTarget) return
    this.eventTarget.removeEventListener(
      'beforeinstallprompt',
      this.handleBeforeInstallPrompt,
    )
    this.eventTarget.removeEventListener('appinstalled', this.handleInstalled)
    this.deferredPrompt = undefined
    this.eventTarget = undefined
    this.initialized = false
  }

  async prompt(): Promise<boolean> {
    const prompt = this.deferredPrompt
    if (!prompt) return false
    this.deferredPrompt = undefined
    this.notify()
    await prompt.prompt()
    return true
  }

  private readonly handleBeforeInstallPrompt = (event: Event): void => {
    if (!isBeforeInstallPromptEvent(event)) return
    event.preventDefault()
    this.deferredPrompt = event
    this.notify()
  }

  private readonly handleInstalled = (): void => {
    this.deferredPrompt = undefined
    this.standalone = true
    this.notify()
  }

  private notify(): void {
    this.options.onStateChange?.({
      canInstall: this.canInstall,
      isStandalone: this.isStandalone,
    })
  }
}

export function createPwaController(
  options: PwaControllerOptions = {},
): PwaController {
  return new PwaControllerImpl(options)
}
