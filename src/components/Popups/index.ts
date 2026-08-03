import { reactive, readonly } from 'vue'

export type PopupName =
  | 'adminPanel'
  | 'displaySettings'
  | 'getImgPopup'
  | 'loginPopup'
  | 'promptInputPopup'
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
  if (!location.hash.startsWith('#resetpassword=')) location.hash = 'popup'
}

function close(id?: number): void {
  const selected =
    id == null ? [...popups] : popups.filter((item) => item.id === id)
  selected.forEach((item) => (item.closing = true))
  window.setTimeout(() => {
    selected.forEach((item) => {
      const index = popups.indexOf(item)
      if (index >= 0) popups.splice(index, 1)
    })
  }, 150)
}

export default {
  close,
  isOpen: () => popups.some((item) => !item.closing),
  popups: readonly(popups),
  show,
}
