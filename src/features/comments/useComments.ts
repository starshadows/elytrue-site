import { requireController } from '../../app/controller'

export function useComments() {
  function refresh(): void {
    const controller = requireController()
    controller.clearComments()
    void controller.loadComments()
  }

  function seek(direction: -1 | 1): void {
    requireController().seekComment(direction)
  }

  function openEditor(): void {
    void requireController().newComment()
  }

  function gotoNumber(number: string | number): void {
    const controller = requireController()
    controller.clearComments(1)
    void controller.loadComments({ number })
  }

  return { gotoNumber, openEditor, refresh, seek }
}
