import { getConfig, setConfig } from "./config"
import { lang, changeLang } from "./lang"
import { html2elmnt, logErr, loadComments, clearComments } from ".."

declare const Comments: typeof import('..').Comments


const Settings = {
    elements: {
        showKami: document.getElementById('showKami') as HTMLInputElement,
    },

    init() {
        this.load()

        this.elements.showKami.onchange = () => this.showKami = this.elements.showKami.checked
    },

    load() {
        if (getConfig('showKami') == 'true') this.showKami = true

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
        return this.elements.showKami.checked
    },
    set showKami(value) {
        this.elements.showKami.checked = value
        setConfig('showKami', value)
        setTimeout(() => {
            if (Comments.hasItem()) {
                clearComments()
                loadComments()
            }
        }, 0);
    },

    get showHidden() {
        let el = document.getElementById('showHiddenCSS')
        return el ? Boolean(el.innerHTML) : false
    },
    set showHidden(value) {
        let el = document.getElementById('showHiddenCSS') as HTMLStyleElement
        if (!el) {
            document.head.appendChild(html2elmnt('<style id="showHiddenCSS"></style>'))
            el = document.getElementById('showHiddenCSS') as HTMLStyleElement
        }
        el.innerHTML = value ? `
            #comments .commentBox.hidden {
                display: block;
            }
        ` : ''
    },

    get lang() {
        return lang
    },
    set lang(value) {
        changeLang(value)
        setConfig('lang', value)
    },

    get graphicsMode() {
        return (getConfig('graphicsMode') as 'high' | 'mid' | 'low' | null) || 'high'
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
    }
}

try {
    Settings.init()
} catch (error) {
    logErr(error, 'failed to init settings')
}

export default Settings
