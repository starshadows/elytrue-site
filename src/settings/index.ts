import { ref } from 'vue'
import { getConfig, setConfig } from './config'
import { lang, changeLang } from './lang'
import { elementFromHtml } from '../lib/dom'

const pinnedHidden = ref(false)
const timelineVisible = ref(true)

const Settings = {
  init() {
    this.load()
  },

  load() {
    changeLang(getConfig('lang'))
    pinnedHidden.value = getConfig('hideTopComment') === 'true'
    timelineVisible.value = getConfig('showTimeline') !== 'false'

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

  get pinnedHidden() {
    return pinnedHidden.value
  },
  set pinnedHidden(value) {
    pinnedHidden.value = value
    setConfig('hideTopComment', value)
  },

  get showTimeline() {
    return timelineVisible.value
  },
  set showTimeline(value) {
    timelineVisible.value = value
    setConfig('showTimeline', value)
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

export default Settings
