import { getConfig, setConfig } from './config'
import { lang, changeLang } from './lang'
import { logFrontendError } from '../app/controller'
import { elementFromHtml } from '../lib/dom'

const Settings = {
  elements: {},

  init() {
    this.load()
  },

  load() {
    changeLang(getConfig('lang'))

    if (Settings.graphicsMode != 'high') {
      Settings.graphicsMode = Settings.graphicsMode
    }
  },

  get pageScale() {
    let x = parseFloat(document.documentElement.style.fontSize) / 16
    return x ? x : 1
  },
  set pageScale(scale) {
    document.documentElement.style.fontSize = `${16 * scale}px`
  },

  get showKami() {
    return false
  },
  set showKami(_value) {
    setConfig('showKami', false)
  },

  get showHidden() {
    let el = document.getElementById('showHiddenCSS')
    return el ? Boolean(el.innerHTML) : false
  },
  set showHidden(value) {
    let el = document.getElementById('showHiddenCSS') as HTMLStyleElement
    if (!el) {
      document.head.appendChild(
        elementFromHtml('<style id="showHiddenCSS"></style>'),
      )
      el = document.getElementById('showHiddenCSS') as HTMLStyleElement
    }
    el.innerHTML = value
      ? `
            #comments .commentBox.hidden {
                display: block;
            }
        `
      : ''
  },

  get lang() {
    return lang
  },
  set lang(value) {
    changeLang(value)
    setConfig('lang', value)
  },

  get graphicsMode() {
    return (
      (getConfig('graphicsMode') as 'high' | 'mid' | 'low' | null) || 'high'
    )
  },
  set graphicsMode(mode) {
    if (mode == 'high') {
      document.body.classList.remove('lowend')
      document.body.classList.remove('midend')
    } else if (mode == 'mid') {
      document.body.classList.remove('lowend')
      document.body.classList.add('midend')
    } else if (mode == 'low') {
      document.body.classList.add('lowend')
      document.body.classList.remove('midend')
    } else return
    setConfig('graphicsMode', mode)
  },
}

try {
  Settings.init()
} catch (error) {
  logFrontendError(error, 'failed to init settings')
}

export default Settings
