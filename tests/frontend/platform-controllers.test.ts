import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createTimelineController,
  getTimelineDays,
  getTimelineSelectionTime,
  getTimelineStartDate,
  getTimelineYears,
  parseTimelineDay,
} from '../../src/features/timeline/timeline-controller'
import {
  createPwaController,
  type BeforeInstallPromptEvent,
} from '../../src/features/pwa/pwa-controller'
import {
  createViewportController,
  getScrollOffset,
  getScrollProgress,
  type ViewportClassList,
  type ViewportElements,
  type WallpaperPropertyListener,
} from '../../src/features/viewport/viewport-controller'

class TrackingEventTarget extends EventTarget {
  additions: string[] = []
  removals: string[] = []

  override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    this.additions.push(type)
    super.addEventListener(type, callback, options)
  }

  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void {
    this.removals.push(type)
    super.removeEventListener(type, callback, options)
  }
}

class InstallPromptEvent extends Event implements BeforeInstallPromptEvent {
  prompts = 0

  constructor() {
    super('beforeinstallprompt', { cancelable: true })
  }

  async prompt(): Promise<void> {
    this.prompts += 1
  }
}

class KeyEvent extends Event {
  readonly key: string

  constructor(key: string) {
    super('keydown')
    this.key = key
  }
}

class UrlChangeEvent extends Event {
  readonly newURL: string
  readonly oldURL: string

  constructor(oldURL: string, newURL: string) {
    super('hashchange')
    this.oldURL = oldURL
    this.newURL = newURL
  }
}

class TestClassList implements ViewportClassList {
  readonly values = new Set<string>()

  add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token))
  }

  contains(token: string): boolean {
    return this.values.has(token)
  }

  remove(...tokens: string[]): void {
    tokens.forEach((token) => this.values.delete(token))
  }

  toggle(token: string, force?: boolean): boolean {
    const enabled = force ?? !this.values.has(token)
    if (enabled) this.values.add(token)
    else this.values.delete(token)
    return enabled
  }
}

class TimelineElement {
  readonly children: TimelineElement[] = []
  readonly classList = new TestClassList()
  readonly dataset: Record<string, string> = {}
  parentElement: TimelineElement | null = null
  textContent = ''
  private readonly listeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >()

  constructor(readonly tagName: string) {}

  get firstElementChild(): TimelineElement | null {
    return this.children[0] ?? null
  }

  addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
  ): void {
    if (!callback) return
    const callbacks = this.listeners.get(type) ?? new Set()
    callbacks.add(callback)
    this.listeners.set(type, callbacks)
  }

  appendChild(child: TimelineElement): TimelineElement {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  emit(type: string, target: TimelineElement): void {
    const event = { target } as unknown as Event
    for (const callback of this.listeners.get(type) ?? []) {
      if (typeof callback === 'function') callback(event)
      else callback.handleEvent(event)
    }
  }

  querySelector(selector: string): TimelineElement | null {
    for (const child of this.children) {
      if (selector === 'strong' && child.tagName === 'STRONG') return child
      const nested = child.querySelector(selector)
      if (nested) return nested
    }
    return null
  }

  removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
  ): void {
    if (callback) this.listeners.get(type)?.delete(callback)
  }

  replaceChildren(...children: TimelineElement[]): void {
    this.children.splice(0)
    children.forEach((child) => this.appendChild(child))
  }
}

class TimelineDocument {
  readonly calendar = new TimelineElement('DIV')
  readonly container = new TimelineElement('DIV')
  readonly timeline = new TimelineElement('DIV')

  createElement(tagName: string): TimelineElement {
    return new TimelineElement(tagName.toUpperCase())
  }

  getElementById(id: string): TimelineElement | null {
    if (id === 'timelineContainer') return this.container
    if (id === 'timeline') return this.timeline
    if (id === 'hoverCalendar') return this.calendar
    return null
  }
}

describe('timeline date calculations', () => {
  test('uses the local August 1, 2026 start and builds descending months', () => {
    const start = getTimelineStartDate()
    assert.deepEqual(
      [
        start.getFullYear(),
        start.getMonth() + 1,
        start.getDate(),
        start.getHours(),
      ],
      [2026, 8, 1, 0],
    )
    assert.deepEqual(getTimelineYears(start.getTime() / 1_000 - 1), [
      { year: 2026, months: [8] },
    ])
    assert.deepEqual(
      getTimelineYears(new Date(2027, 0, 15).getTime() / 1_000),
      [
        { year: 2027, months: [1] },
        { year: 2026, months: [12, 11, 10, 9, 8] },
      ],
    )
  })

  test('keeps the strict latest-day and legacy selection boundaries', () => {
    const augustFirst = new Date(2026, 7, 1).getTime() / 1_000
    assert.deepEqual(getTimelineDays(2026, 8, augustFirst), [])
    assert.deepEqual(getTimelineDays(2026, 8, augustFirst + 1), [
      { day: 1, unixSeconds: augustFirst },
    ])

    const unlimited = Number.POSITIVE_INFINITY
    assert.equal(
      getTimelineSelectionTime({ type: 'year', year: 2026 }, unlimited),
      new Date(2027, 0, 0).getTime() / 1_000,
    )
    assert.equal(
      getTimelineSelectionTime(
        { type: 'month', year: 2026, month: 8 },
        unlimited,
      ),
      new Date(2026, 8, 0, 23, 59, 59, 999).getTime() / 1_000,
    )
    assert.equal(
      getTimelineSelectionTime(
        { type: 'day', year: 2026, month: 8, day: 3 },
        augustFirst,
      ),
      augustFirst,
    )
  })

  test('accepts generated Unix timestamps and the legacy E2E date value', () => {
    const date = new Date(2026, 7, 3)
    assert.equal(
      parseTimelineDay(String(date.getTime() / 1_000))?.getTime(),
      date.getTime(),
    )
    assert.equal(
      parseTimelineDay(date.toDateString())?.getTime(),
      date.getTime(),
    )
    assert.equal(parseTimelineDay('not-a-date'), undefined)
  })

  test('routes latest, year, month, and day clicks through explicit callbacks', () => {
    const originalHTMLElement = globalThis.HTMLElement
    Object.defineProperty(globalThis, 'HTMLElement', {
      configurable: true,
      value: TimelineElement,
      writable: true,
    })
    try {
      const documentObject = new TimelineDocument()
      const loadedTimes: number[] = []
      let refreshes = 0
      const maxTime = new Date(2027, 0, 15).getTime() / 1_000
      const controller = createTimelineController(
        {
          getCurrentCommentTime: () => undefined,
          getMaxTimelineTime: () => maxTime,
          isFullscreen: () => false,
          loadCommentsAtTime: (time) => {
            loadedTimes.push(time)
          },
          logError() {},
          persistVisibility() {},
          refreshComments: () => {
            refreshes += 1
          },
          setCommentsScrollbarHidden() {},
        },
        { document: documentObject as unknown as Document },
      )
      controller.init()

      const latest = documentObject.timeline.children[0]?.firstElementChild
      const previousYear =
        documentObject.timeline.children[1]?.firstElementChild
      const month = documentObject.timeline.children[1]?.children[1]
      assert.ok(latest)
      assert.ok(previousYear)
      assert.ok(month)
      documentObject.container.emit('click', latest)
      documentObject.container.emit('click', previousYear)
      documentObject.container.emit('click', month)

      const day = new TimelineElement('DIV')
      const dayStart = new Date(2026, 7, 3).getTime() / 1_000
      day.dataset.time = String(dayStart)
      documentObject.container.emit('click', day)

      assert.equal(refreshes, 1)
      assert.deepEqual(loadedTimes, [
        getTimelineSelectionTime(
          { type: 'year', year: Number(previousYear.textContent) },
          maxTime,
        ),
        getTimelineSelectionTime(
          {
            type: 'month',
            year: Number(previousYear.textContent),
            month: Number(month.textContent),
          },
          maxTime,
        ),
        getTimelineSelectionTime(
          { type: 'day', year: 2026, month: 8, day: 3 },
          maxTime,
        ),
      ])
      controller.dispose()
    } finally {
      Object.defineProperty(globalThis, 'HTMLElement', {
        configurable: true,
        value: originalHTMLElement,
        writable: true,
      })
    }
  })
})

describe('PWA controller', () => {
  test('captures one install prompt and removes listeners on dispose', async () => {
    const events = new TrackingEventTarget()
    const states: Array<{ canInstall: boolean; isStandalone: boolean }> = []
    const controller = createPwaController({
      eventTarget: events,
      getDocumentReferrer: () => '',
      isNavigatorStandalone: () => false,
      matchesStandaloneDisplayMode: () => false,
      onStateChange: (state) => states.push(state),
    })

    controller.init()
    controller.init()
    assert.deepEqual(events.additions, ['beforeinstallprompt', 'appinstalled'])
    assert.equal(controller.isStandalone, false)

    const installEvent = new InstallPromptEvent()
    events.dispatchEvent(installEvent)
    assert.equal(installEvent.defaultPrevented, true)
    assert.equal(controller.canInstall, true)
    assert.equal(await controller.prompt(), true)
    assert.equal(await controller.prompt(), false)
    assert.equal(installEvent.prompts, 1)

    events.dispatchEvent(new Event('appinstalled'))
    assert.equal(controller.isStandalone, true)
    assert.equal(states.at(-1)?.isStandalone, true)

    controller.dispose()
    controller.dispose()
    assert.deepEqual(events.removals, ['beforeinstallprompt', 'appinstalled'])
    events.dispatchEvent(new InstallPromptEvent())
    assert.equal(controller.canInstall, false)
  })
})

describe('viewport controller', () => {
  test('converts scroll position and owns injected platform listeners', () => {
    const windowEvents = new TrackingEventTarget()
    const documentEvents = new TrackingEventTarget()
    const classes = new TestClassList()
    const messageInput = new EventTarget()
    let activeElement: EventTarget | null = null
    const elements: ViewportElements = {
      body: { classList: classes },
      comments: {
        clientHeight: 500,
        clientWidth: 200,
        scrollHeight: 2_000,
        scrollLeft: 400,
        scrollTop: 0,
        scrollWidth: 1_000,
      },
      fullscreenButton: { innerHTML: '' },
      getActiveElement: () => activeElement,
      messageInput: Object.assign(messageInput, { blur() {} }),
      newCommentBox: { offsetHeight: 300 },
      wallpaperStyle: { textContent: '' },
    }
    let scheduled: (() => void) | undefined
    let cancelled = 0
    let wallpaperListener: WallpaperPropertyListener | undefined
    let wallpaperUnregistered = 0
    let lowerPanelDown = 0
    let imageCloses = 0
    let popupCloses = 0
    let timelineUpdates = 0
    let pauses = 0
    let pageScale = 1
    let volume = 0

    const controller = createViewportController(
      {
        closeImageViewer: () => {
          imageCloses += 1
        },
        closePopup: () => {
          popupCloses += 1
        },
        forceLowerPanelDown: () => {
          lowerPanelDown += 1
        },
        getPageScale: () => pageScale,
        isImageViewerOpen: () => false,
        isPopupOpen: () => false,
        pauseCommentsScroll: () => {
          pauses += 1
        },
        setMusicVolume: (value) => {
          volume = value
        },
        setPageScale: (value) => {
          pageScale = value
        },
        updateTimelineActiveMonth: () => {
          timelineUpdates += 1
        },
      },
      {
        cancelScheduled: () => {
          cancelled += 1
        },
        documentTarget: documentEvents,
        getHash: () => '',
        registerWallpaperListener: (listener) => {
          wallpaperListener = listener
          return () => {
            wallpaperUnregistered += 1
          }
        },
        resolveElements: () => elements,
        schedule: (callback) => {
          scheduled = callback
          return 1
        },
        setHash: () => {},
        windowTarget: windowEvents,
      },
    )

    controller.init()
    controller.init()
    assert.deepEqual(windowEvents.additions, ['resize', 'hashchange'])
    assert.deepEqual(documentEvents.additions, ['keydown'])

    controller.toggleFullscreen()
    assert.equal(controller.isFullscreen, true)
    assert.equal(classes.contains('fullscreen'), true)
    assert.equal(pauses, 1)
    scheduled?.()
    assert.equal(elements.comments.scrollTop, 750)
    assert.equal(timelineUpdates, 1)

    activeElement = messageInput
    windowEvents.dispatchEvent(new Event('resize'))
    assert.equal(classes.contains('touchKeyboardShowing'), true)

    wallpaperListener?.applyUserProperties({
      ui_bottom: { value: 48 },
      ui_scale: { value: 125 },
      ui_volume: { value: 40 },
    })
    assert.equal(pageScale, 1.25)
    assert.equal(volume, 0.4)
    assert.match(elements.wallpaperStyle?.textContent ?? '', /3rem/)

    documentEvents.dispatchEvent(new KeyEvent('Escape'))
    assert.equal(controller.isFullscreen, false)
    assert.equal(lowerPanelDown, 0)
    windowEvents.dispatchEvent(
      new UrlChangeEvent(
        'https://elytrue.com/#view-img',
        'https://elytrue.com/',
      ),
    )
    windowEvents.dispatchEvent(
      new UrlChangeEvent('https://elytrue.com/#popup', 'https://elytrue.com/'),
    )
    assert.equal(imageCloses, 1)
    assert.equal(popupCloses, 1)

    controller.dispose()
    controller.dispose()
    assert.deepEqual(windowEvents.removals, ['resize', 'hashchange'])
    assert.deepEqual(documentEvents.removals, ['keydown'])
    assert.equal(wallpaperUnregistered, 1)
    assert.equal(cancelled, 1)
    documentEvents.dispatchEvent(new KeyEvent('Escape'))
    assert.equal(lowerPanelDown, 0)
  })

  test('scroll helpers clamp empty ranges and out-of-range progress', () => {
    assert.equal(getScrollProgress(50, 100, 100), 0)
    assert.equal(getScrollProgress(900, 1_000, 200), 1)
    assert.equal(getScrollOffset(0.5, 2_000, 500), 750)
    assert.equal(getScrollOffset(-1, 2_000, 500), 0)
  })
})
