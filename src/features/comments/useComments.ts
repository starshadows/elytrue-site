import { commentsStore } from './comments-store'

export function useComments() {
  function refresh(): void {
    void commentsStore.refresh()
  }

  function seek(direction: -1 | 1): void {
    document.dispatchEvent(
      new CustomEvent('elytrue:seek-comment', { detail: direction }),
    )
  }

  function openEditor(): void {
    document.dispatchEvent(new Event('elytrue:open-comment-editor'))
  }

  function gotoNumber(number: string | number): void {
    void commentsStore.gotoNumber(number)
  }

  return { gotoNumber, openEditor, refresh, seek, state: commentsStore.state }
}
