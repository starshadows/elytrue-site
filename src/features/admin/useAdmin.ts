import { requireController } from '../../app/controller'

export function useAdmin() {
  return {
    open: () => requireController().Popup.show('adminPanel', undefined),
  }
}
