import { requireController } from '../../app/controller'

export type SupportedLanguage = '' | 'zh' | 'en'

export function useSiteSettings() {
  function setLanguage(language: SupportedLanguage): void {
    requireController().Settings.lang = language
  }

  function setZoom(percent: number): void {
    if (percent >= 50 && percent <= 500) {
      requireController().Settings.pageScale = percent / 100
    }
  }

  function setShowHidden(value: boolean): void {
    requireController().Settings.showHidden = value
  }

  return { setLanguage, setShowHidden, setZoom }
}
