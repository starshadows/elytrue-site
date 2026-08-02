export type FrontendController = typeof import('../index')

let activeController: FrontendController | undefined

export function registerController(controller: FrontendController): void {
  activeController = controller
}

export function requireController(): FrontendController {
  if (!activeController) {
    throw new Error('Frontend controller is not ready')
  }
  return activeController
}

export function logFrontendError(error: unknown, message: string): void {
  const controller = activeController
  if (controller) {
    controller.logErr(error, message)
  } else {
    console.error(message, error)
  }
}

export function viewImage(source: string): void {
  requireController().viewImg(source)
}

export function bindControllerEvents(): void {
  document.addEventListener('click', (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-action]')
        : null
    if (!target) return
    const controller = requireController()

    switch (target.dataset.action) {
      case 'view-image':
        if (target instanceof HTMLImageElement) controller.viewImg(target.src)
        if (target.dataset.liftPanel === 'true') {
          controller.Comments.forceLowerPanelUp()
        }
        break
      case 'click-previous':
        if (target.previousElementSibling instanceof HTMLElement) {
          target.previousElementSibling.click()
        }
        break
      case 'user-change-avatar':
        if (controller.XHR.token) controller.User.changeAvatar()
        break
      case 'user-change-name':
        if (controller.XHR.token) controller.User.changeName()
        break
      case 'show-login':
        controller.Popup.show('loginPopup', undefined)
        break
      case 'cancel-message':
        controller.cancelMessage()
        break
      case 'send-message':
        void controller.sendMessage()
        break
      case 'remove-upload':
        target.parentElement?.remove()
        break
      case 'goto-user-comment': {
        const number = target.dataset.number
        if (!number) break
        controller.clearComments(1)
        void controller.loadComments({ number })
        controller.closePopup()
        break
      }
    }
  })

  document.addEventListener('change', (event) => {
    const target =
      event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>('[data-action]')
        : null
    if (target?.dataset.action === 'preview-local-images') {
      void requireController().previewLocalImgs()
    }
  })

  document.addEventListener(
    'load',
    (event) => {
      const target = event.target
      if (
        target instanceof HTMLImageElement &&
        target.dataset.action === 'background-loaded'
      ) {
        target.style.removeProperty('min-height')
      }
    },
    true,
  )
}
