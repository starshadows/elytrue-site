import { requireController } from '../../app/controller'

export function useTheme() {
  return {
    openSelector: () =>
      requireController().Popup.show('themeSelectorPopup', undefined),
    select: (theme: string) => requireController().Theme.set(theme),
  }
}
