import { computed } from 'vue'
import { requireController } from '../../app/controller'
import { selectTheme, themeState } from './theme-controller'

export function useTheme() {
  return {
    currentTheme: computed(() => themeState.theme),
    openSelector: () =>
      requireController().Popup.show('themeSelectorPopup', undefined),
    select: selectTheme,
  }
}
