import { ref } from 'vue'
import { getConfig, setConfig } from './config'
import { lang, changeLang } from './lang'

const backgroundCaptionsHidden = ref(true)

export function backgroundCaptionsHiddenFromConfig(
  value: string | null,
): boolean {
  return value !== 'false'
}

const Settings = {
  init() {
    this.load()
  },

  load() {
    changeLang(getConfig('lang'))
    backgroundCaptionsHidden.value = backgroundCaptionsHiddenFromConfig(
      getConfig('hideBackgroundCaptions'),
    )

    if (Settings.graphicsMode != 'high') {
      Settings.graphicsMode = Settings.graphicsMode
    }
  },

  get pageScale() {
    const x = parseFloat(document.documentElement.style.fontSize) / 16
    return x ? x : 1
  },
  set pageScale(scale) {
    document.documentElement.style.fontSize = `${16 * scale}px`
  },

  get lang() {
    return lang
  },
  set lang(value) {
    changeLang(value)
    setConfig('lang', value)
  },

  get hideBackgroundCaptions() {
    return backgroundCaptionsHidden.value
  },
  set hideBackgroundCaptions(value) {
    backgroundCaptionsHidden.value = value
    setConfig('hideBackgroundCaptions', value)
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
