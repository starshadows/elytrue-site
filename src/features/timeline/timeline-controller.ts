export const TIMELINE_START_YEAR = 2026
export const TIMELINE_START_MONTH = 8
export const TIMELINE_START_DAY = 1

export interface TimelineYear {
  readonly year: number
  readonly months: readonly number[]
}

export interface TimelineDay {
  readonly day: number
  readonly unixSeconds: number
}

export type TimelineSelection =
  | { readonly type: 'year'; readonly year: number }
  | { readonly type: 'month'; readonly year: number; readonly month: number }
  | {
      readonly type: 'day'
      readonly year: number
      readonly month: number
      readonly day: number
    }

export function getTimelineStartDate(): Date {
  return new Date(
    TIMELINE_START_YEAR,
    TIMELINE_START_MONTH - 1,
    TIMELINE_START_DAY,
  )
}

export function getTimelineYears(maxUnixSeconds: number): TimelineYear[] {
  const startTime = getTimelineStartDate().getTime()
  const maxTime = Number.isFinite(maxUnixSeconds)
    ? maxUnixSeconds * 1_000
    : startTime
  const date = new Date(Math.max(maxTime, startTime))
  date.setDate(1)
  date.setHours(0, 0, 0, 0)

  const years: TimelineYear[] = []
  while (date.getTime() >= startTime) {
    const year = date.getFullYear()
    const months: number[] = []
    while (date.getFullYear() === year && date.getTime() >= startTime) {
      months.push(date.getMonth() + 1)
      date.setMonth(date.getMonth() - 1)
    }
    years.push({ year, months })
  }
  return years
}

export function getTimelineDays(
  year: number,
  month: number,
  maxUnixSeconds: number,
): TimelineDay[] {
  const startTime = getTimelineStartDate().getTime()
  const lastDay = new Date(year, month, 0).getDate()
  const days: TimelineDay[] = []

  for (let day = 1; day <= lastDay; day += 1) {
    const time = new Date(year, month - 1, day).getTime()
    if (time >= startTime && time / 1_000 < maxUnixSeconds) {
      days.push({ day, unixSeconds: time / 1_000 })
    }
  }
  return days
}

export function getTimelineSelectionTime(
  selection: TimelineSelection,
  maxUnixSeconds: number,
): number {
  let selectedTime: number
  if (selection.type === 'year') {
    // Keep the legacy year boundary at midnight at the start of December 31.
    selectedTime = new Date(selection.year + 1, 0, 0).getTime()
  } else if (selection.type === 'month') {
    selectedTime = new Date(
      selection.year,
      selection.month,
      0,
      23,
      59,
      59,
      999,
    ).getTime()
  } else {
    selectedTime = new Date(
      selection.year,
      selection.month - 1,
      selection.day,
      23,
      59,
      59,
      999,
    ).getTime()
  }
  return Math.min(selectedTime / 1_000, maxUnixSeconds)
}

export function parseTimelineDay(value: string): Date | undefined {
  const numericTime = Number(value)
  const time =
    Number.isFinite(numericTime) && value.trim() !== ''
      ? numericTime * 1_000
      : Date.parse(value)
  if (!Number.isFinite(time)) return undefined
  const date = new Date(time)
  return Number.isNaN(date.getTime()) ? undefined : date
}

export interface TimelineControllerCallbacks {
  getCurrentCommentTime(): number | undefined
  getMaxTimelineTime(): number
  isFullscreen(): boolean
  loadCommentsAtTime(time: number): void | Promise<unknown>
  logError(error: unknown, message: string): void
  returnToLatest(): void | Promise<unknown>
}

export interface TimelineControllerOptions {
  readonly document?: Document
}

export interface TimelineController {
  dispose(): void
  init(): void
  load(unixSeconds: number): void
  render(maxUnixSeconds?: number): void
  setActiveDate(scroll?: boolean): void
}

class TimelineControllerImpl implements TimelineController {
  private readonly callbacks: TimelineControllerCallbacks
  private readonly options: TimelineControllerOptions
  private calendar?: HTMLElement
  private container?: HTMLElement
  private document?: Document
  private initialized = false
  private timeline?: HTMLElement

  constructor(
    callbacks: TimelineControllerCallbacks,
    options: TimelineControllerOptions,
  ) {
    this.callbacks = callbacks
    this.options = options
  }

  init(): void {
    if (this.initialized) return
    const documentObject = this.options.document ?? document
    const container = documentObject.getElementById('timelineContainer')
    const timeline = documentObject.getElementById('timeline')
    const calendar = documentObject.getElementById('hoverCalendar')
    if (!container || !timeline || !calendar) {
      throw new Error('Timeline elements are missing')
    }

    this.document = documentObject
    this.container = container
    this.timeline = timeline
    this.calendar = calendar
    container.addEventListener('click', this.handleClick)
    container.addEventListener('wheel', this.handleWheel)
    container.addEventListener('mouseover', this.handleMouseOver)
    container.addEventListener('mouseleave', this.hideCalendar)
    this.initialized = true
    this.render()
  }

  dispose(): void {
    if (!this.initialized || !this.container) return
    this.container.removeEventListener('click', this.handleClick)
    this.container.removeEventListener('wheel', this.handleWheel)
    this.container.removeEventListener('mouseover', this.handleMouseOver)
    this.container.removeEventListener('mouseleave', this.hideCalendar)
    this.document = undefined
    this.container = undefined
    this.timeline = undefined
    this.calendar = undefined
    this.initialized = false
  }

  load(unixSeconds: number): void {
    void this.callbacks.loadCommentsAtTime(unixSeconds)
  }

  render(maxUnixSeconds = this.callbacks.getMaxTimelineTime()): void {
    const timeline = this.requireTimeline()
    timeline.replaceChildren()
    for (const item of getTimelineYears(maxUnixSeconds)) {
      const year = this.requireDocument().createElement('p')
      const heading = this.requireDocument().createElement('strong')
      heading.textContent = String(item.year)
      year.appendChild(heading)
      for (const month of item.months) {
        const monthElement = this.requireDocument().createElement('span')
        monthElement.textContent = String(month)
        year.appendChild(monthElement)
      }
      timeline.appendChild(year)
    }
  }

  setActiveDate(scroll = false): void {
    try {
      const unixSeconds = this.callbacks.getCurrentCommentTime()
      if (unixSeconds === undefined) return
      const date = new Date(unixSeconds * 1_000)
      const activeYear = date.getFullYear()
      const activeMonth = date.getMonth() + 1

      for (const yearElement of Array.from(this.requireTimeline().children)) {
        const heading = yearElement.firstElementChild
        const year = Number.parseInt(heading?.textContent ?? '', 10)
        heading?.classList.toggle('month-active', year === activeYear)
        if (scroll && year === activeYear) {
          heading?.scrollIntoView({
            behavior: 'smooth',
            block: 'center',
            inline: 'center',
          })
        }
        for (const monthElement of Array.from(yearElement.children)) {
          if (monthElement.tagName !== 'SPAN') continue
          const month = Number.parseInt(monthElement.textContent ?? '', 10)
          monthElement.classList.toggle(
            'month-active',
            year === activeYear && month === activeMonth,
          )
        }
      }
      this.setCalendarActiveDay(date)
    } catch (error) {
      this.callbacks.logError(error, 'failed to update active timeline month')
    }
  }

  private readonly handleClick = (event: Event): void => {
    const target = event.target
    if (!(target instanceof HTMLElement)) return
    const maxTime = this.callbacks.getMaxTimelineTime()
    let selection: TimelineSelection | undefined

    if (target.tagName === 'STRONG') {
      if (target === this.requireTimeline().querySelector('strong')) {
        void this.callbacks.returnToLatest()
        return
      }
      const year = Number.parseInt(target.textContent ?? '', 10)
      if (Number.isFinite(year)) selection = { type: 'year', year }
    } else if (target.tagName === 'SPAN') {
      if (target.classList.contains('month-active')) return
      const year = Number.parseInt(
        target.parentElement?.firstElementChild?.textContent ?? '',
        10,
      )
      const month = Number.parseInt(target.textContent ?? '', 10)
      if (Number.isFinite(year) && Number.isFinite(month)) {
        selection = { type: 'month', year, month }
      }
    } else if (target.dataset.time) {
      const date = parseTimelineDay(target.dataset.time)
      if (date) {
        selection = {
          type: 'day',
          year: date.getFullYear(),
          month: date.getMonth() + 1,
          day: date.getDate(),
        }
      }
    }

    if (!selection) return
    const time = getTimelineSelectionTime(selection, maxTime)
    void this.callbacks.loadCommentsAtTime(time)
  }

  private readonly handleWheel = (event: WheelEvent): void => {
    if (!this.callbacks.isFullscreen()) {
      this.requireTimeline().scrollLeft += event.deltaY / 2
    }
  }

  private readonly handleMouseOver = (event: MouseEvent): void => {
    const target = event.target
    if (!(target instanceof HTMLElement) || target.tagName !== 'SPAN') return
    const year = Number.parseInt(
      target.parentElement?.firstElementChild?.textContent ?? '',
      10,
    )
    const month = Number.parseInt(target.textContent ?? '', 10)
    if (!Number.isFinite(year) || !Number.isFinite(month)) return

    const calendar = this.requireCalendar()
    const container = this.requireContainer()
    const targetBounds = target.getBoundingClientRect()
    if (this.callbacks.isFullscreen()) {
      calendar.style.top = `${targetBounds.top + targetBounds.height / 2}px`
      calendar.style.right = `${container.getBoundingClientRect().width}px`
      calendar.style.removeProperty('left')
      calendar.style.removeProperty('bottom')
    } else {
      const viewportWidth = this.requireDocument().documentElement.clientWidth
      const calendarWidth = 113
      const center = targetBounds.left + targetBounds.width / 2
      const left = Math.max(
        calendarWidth,
        Math.min(center, viewportWidth - calendarWidth),
      )
      calendar.style.left = `${left}px`
      calendar.style.bottom = `${container.getBoundingClientRect().height}px`
      calendar.style.removeProperty('top')
      calendar.style.removeProperty('right')
    }

    calendar.replaceChildren()
    const heading = this.requireDocument().createElement('div')
    heading.textContent = `${year}-${String(month).padStart(2, '0')}`
    calendar.appendChild(heading)
    for (const item of getTimelineDays(
      year,
      month,
      this.callbacks.getMaxTimelineTime(),
    )) {
      const day = this.requireDocument().createElement('div')
      day.dataset.time = String(item.unixSeconds)
      day.textContent = String(item.day)
      calendar.appendChild(day)
    }
    calendar.style.removeProperty('display')

    const currentTime = this.callbacks.getCurrentCommentTime()
    if (currentTime !== undefined) {
      this.setCalendarActiveDay(new Date(currentTime * 1_000))
    }
  }

  private readonly hideCalendar = (): void => {
    if (this.calendar) this.calendar.style.display = 'none'
  }

  private setCalendarActiveDay(activeDate: Date): void {
    const calendar = this.requireCalendar()
    for (const day of calendar.querySelectorAll<HTMLElement>('[data-time]')) {
      const time = Number(day.dataset.time)
      const date = new Date(time * 1_000)
      day.classList.toggle(
        'day-active',
        date.getFullYear() === activeDate.getFullYear() &&
          date.getMonth() === activeDate.getMonth() &&
          date.getDate() === activeDate.getDate(),
      )
    }
  }

  private requireDocument(): Document {
    if (!this.document)
      throw new Error('Timeline controller is not initialized')
    return this.document
  }

  private requireContainer(): HTMLElement {
    if (!this.container)
      throw new Error('Timeline controller is not initialized')
    return this.container
  }

  private requireTimeline(): HTMLElement {
    if (!this.timeline)
      throw new Error('Timeline controller is not initialized')
    return this.timeline
  }

  private requireCalendar(): HTMLElement {
    if (!this.calendar)
      throw new Error('Timeline controller is not initialized')
    return this.calendar
  }
}

export function createTimelineController(
  callbacks: TimelineControllerCallbacks,
  options: TimelineControllerOptions = {},
): TimelineController {
  return new TimelineControllerImpl(callbacks, options)
}
