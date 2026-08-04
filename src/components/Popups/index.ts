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

function show(name: PopupName, props?: object): void {
  popups.push({ id: nextId++, name, props, closing: false })
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
  selected.forEach((item) => (item.closing = true))
  window.setTimeout(() => {
    selected.forEach((item) => {
      const index = popups.indexOf(item)
      if (index >= 0) popups.splice(index, 1)
    })
  }, 150)
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
  popups: readonly(popups),
  show,
}
