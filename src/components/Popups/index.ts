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

const popups = reactive<PopupEntry[]>([])
let nextId = 0
const removalTimers = new Map<number, number>()

function show(name: PopupName, props?: object): number {
  const id = nextId++
  popups.push({ id, name, props, closing: false })
  location.hash = 'popup'
  return id
}

function replace(id: number, name: PopupName, props?: object): void {
  const entry = popups.find((item) => item.id === id)
  if (!entry) return
  const timer = removalTimers.get(id)
  if (timer !== undefined) {
    window.clearTimeout(timer)
    removalTimers.delete(id)
  }
  entry.name = name
  entry.props = props
  entry.closing = false
  location.hash = 'popup'
}

function close(id?: number): void {
  const selected = (
    id == null ? [...popups] : popups.filter((item) => item.id === id)
  ).filter((item) => item.name !== 'recoveryKeyPopup')
  closeEntries(selected)
}

function complete(id: number): void {
  closeEntries(popups.filter((item) => item.id === id))
}

function closeEntries(selected: PopupEntry[]): void {
  selected.forEach((item) => {
    item.closing = true
    const previousTimer = removalTimers.get(item.id)
    if (previousTimer !== undefined) window.clearTimeout(previousTimer)
    const timer = window.setTimeout(() => {
      removalTimers.delete(item.id)
      const index = popups.indexOf(item)
      if (index >= 0) popups.splice(index, 1)
    }, 150)
    removalTimers.set(item.id, timer)
  })
}

/**
 * 立即移除弹窗(不播放入场/离场动画),用于在同一个容器内
 * 直接切换弹窗内容,避免「关一个再开一个」产生两次完整动画。
 */
function closeInstant(id?: number): void {
  const selected = (
    id == null ? [...popups] : popups.filter((item) => item.id === id)
  ).filter((item) => item.name !== 'recoveryKeyPopup')
  selected.forEach((item) => {
    const timer = removalTimers.get(item.id)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      removalTimers.delete(item.id)
    }
    item.closing = true
    const index = popups.indexOf(item)
    if (index >= 0) popups.splice(index, 1)
  })
}

export default {
  close,
  closeInstant,
  complete,
  isOpen: () => popups.some((item) => !item.closing),
  isOpenName: (name: PopupName) =>
    popups.some((item) => item.name === name && !item.closing),
  popups: readonly(popups),
  replace,
  show,
}
