import { requireController } from '../../app/controller'

export function useTimeline() {
  return {
    toggle: () => requireController().toggleTimeline(),
    load: (unixSeconds: number) =>
      requireController().loadComments({ time: unixSeconds }),
  }
}
