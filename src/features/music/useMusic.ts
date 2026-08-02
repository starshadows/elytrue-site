import { requireController } from '../../app/controller'

export function useMusic() {
  return {
    play: () => requireController().MusicPlayer.play(),
    pause: () => requireController().MusicPlayer.pause(),
    next: () => requireController().MusicPlayer.playNext(),
    previous: () => requireController().MusicPlayer.playPrev(),
  }
}
