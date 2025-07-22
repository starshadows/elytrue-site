
export let lang: string

export function changeLang(targetLang?: string | null) {
    if (!targetLang) {
        if (navigator.language.slice(0, 2) == 'zh' || navigator.language.slice(0, 3) == 'yue') {
            targetLang = 'zh'
        } else {
            targetLang = 'en'
        }
    }

    if (!['zh', 'en'].includes(targetLang)) {
        console.log(`invalid lang "${targetLang}"`)
        return
    }

    document.getElementById('langCSS')!.innerHTML = /*css*/`
        .ui {
            display: none !important;
        }
        .ui.${targetLang} {
            display: inline !important;
        }
    `

    console.log(`changed lang to ${targetLang}`)
    lang = targetLang
}
