import { reactive, readonly } from 'vue'

export type PopupName =
  | 'adminPanel'
  | 'displaySettings'
  | 'getImgPopup'
  | 'loginPopup'
  | 'promptInputPopup'
  | 'recoveryKeyPopup'
  | 'recoveryKeySetupPopup'
  | 'setAvatarPopup'
  | 'setPasswordPopup'
  | 'themeSelectorPopup'
  | 'userHome'

export interface PopupEntry {
  id: number
  name: PopupName
  props?: object
  closing: boolean
}

export const SINGLETON_POPUPS = [
  'displaySettings',
  'getImgPopup',
  'themeSelectorPopup',
] as const satisfies readonly PopupName[]

const singletonNames = new Set<PopupName>(SINGLETON_POPUPS)

interface PopupStoreOptions {
  cancelRemoval?: (handle: unknown) => void
  scheduleRemoval?: (callback: () => void, delay: number) => unknown
  setHash?: (hash: string) => void
}

export interface PopupStore {
  readonly popups: readonly PopupEntry[]
  bringToFront(id: number): void
  close(id?: number): void
  closeInstant(id?: number): void
  complete(id: number): void
  isOpen(): boolean
  isOpenName(name: PopupName): boolean
  replace(id: number, name: PopupName, props?: object): void
  show(name: PopupName, props?: object): number
  topmost(): PopupEntry | undefined
}

export function createPopupStore(options: PopupStoreOptions = {}): PopupStore {
  const popups = reactive<PopupEntry[]>([])
  const removalTimers = new Map<number, unknown>()
  let nextId = 0

  const cancelRemoval =
    options.cancelRemoval ??
    ((handle) => {
      if (typeof window !== 'undefined') window.clearTimeout(handle as number)
    })
  const scheduleRemoval =
    options.scheduleRemoval ??
    ((callback, delay) => window.setTimeout(callback, delay))
  const setHash =
    options.setHash ??
    ((hash) => {
      if (typeof location !== 'undefined') location.hash = hash
    })

  function clearRemovalTimer(id: number): void {
    const timer = removalTimers.get(id)
    if (timer === undefined) return
    cancelRemoval(timer)
    removalTimers.delete(id)
  }

  function topmost(): PopupEntry | undefined {
    return [...popups].reverse().find((item) => !item.closing)
  }

  function bringToFront(id: number): void {
    const index = popups.findIndex((item) => item.id === id)
    if (index < 0 || index === popups.length - 1) return
    const [entry] = popups.splice(index, 1)
    if (entry) popups.push(entry)
  }

  function show(name: PopupName, props?: object): number {
    if (singletonNames.has(name)) {
      const existing = popups.find((item) => item.name === name)
      if (existing) {
        clearRemovalTimer(existing.id)
        existing.props = props
        existing.closing = false
        bringToFront(existing.id)
        setHash('popup')
        return existing.id
      }
    }

    const id = nextId++
    popups.push({ id, name, props, closing: false })
    setHash('popup')
    return id
  }

  function replace(id: number, name: PopupName, props?: object): void {
    const entry = popups.find((item) => item.id === id)
    if (!entry) return
    clearRemovalTimer(id)
    entry.name = name
    entry.props = props
    entry.closing = false
    setHash('popup')
  }

  function closeEntry(entry: PopupEntry): void {
    if (entry.closing) return
    entry.closing = true
    clearRemovalTimer(entry.id)
    const timer = scheduleRemoval(() => {
      removalTimers.delete(entry.id)
      const index = popups.indexOf(entry)
      if (index >= 0) popups.splice(index, 1)
    }, 150)
    removalTimers.set(entry.id, timer)
  }

  function close(id?: number): void {
    const entry =
      id === undefined
        ? topmost()
        : popups.find((item) => item.id === id && !item.closing)
    if (!entry || entry.name === 'recoveryKeyPopup') return
    closeEntry(entry)
  }

  function complete(id: number): void {
    const entry = popups.find((item) => item.id === id)
    if (entry) closeEntry(entry)
  }

  /** Immediately removes one popup when its content is replaced in-place. */
  function closeInstant(id?: number): void {
    const entry =
      id === undefined
        ? topmost()
        : popups.find((item) => item.id === id && !item.closing)
    if (!entry || entry.name === 'recoveryKeyPopup') return
    clearRemovalTimer(entry.id)
    entry.closing = true
    const index = popups.indexOf(entry)
    if (index >= 0) popups.splice(index, 1)
  }

  return {
    bringToFront,
    close,
    closeInstant,
    complete,
    isOpen: () => popups.some((item) => !item.closing),
    isOpenName: (name) =>
      popups.some((item) => item.name === name && !item.closing),
    popups: readonly(popups),
    replace,
    show,
    topmost,
  }
}

export default createPopupStore()
