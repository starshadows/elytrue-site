import { reactive, readonly } from 'vue'

const mutableState = reactive({
  pendingClose: false,
  showing: false,
  source: '',
})

function view(source: string): void {
  mutableState.source = source
  mutableState.pendingClose = false
  mutableState.showing = true
  location.hash = 'view-img'
}

function close(): void {
  if (location.hash === '#view-img') {
    history.back()
    return
  }
  mutableState.pendingClose = true
  window.setTimeout(() => {
    if (mutableState.pendingClose) mutableState.showing = false
  }, 200)
}

export default {
  close,
  isOpen: () => mutableState.showing && !mutableState.pendingClose,
  state: readonly(mutableState),
  view,
}
