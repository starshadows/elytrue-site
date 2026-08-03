<script setup lang="ts">
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue'
import { musicController } from '../features/music/music-controller'
import ProgressSlider from './controls/ProgressSlider.vue'

const audio = useTemplateRef<HTMLAudioElement>('audio')
const image = useTemplateRef<HTMLImageElement>('image')
const play = useTemplateRef<HTMLElement>('play')
const list = useTemplateRef<HTMLOListElement>('list')
const shuffle = useTemplateRef<HTMLInputElement>('shuffle')
const progress = useTemplateRef<InstanceType<typeof ProgressSlider>>('progress')
const playlistButton = useTemplateRef<HTMLElement>('playlistButton')

onMounted(() => {
  if (
    !audio.value ||
    !image.value ||
    !play.value ||
    !list.value ||
    !shuffle.value ||
    !progress.value
  ) {
    throw new Error('Music player elements are missing')
  }
  musicController.init({
    player: audio.value,
    playerImg: image.value,
    playBtn: play.value,
    playingIndicators: document.getElementsByClassName('musicPlayingIndicator'),
    titles: document.getElementsByClassName('currentSong'),
    progressSlider: progress.value,
    list: list.value,
    shuffleBtn: shuffle.value,
    ...(playlistButton.value ? { playlistButton: playlistButton.value } : {}),
  })
})

onBeforeUnmount(() => musicController.dispose())
</script>

<template>
  <div id="musicPlayer">
    <audio id="musicAudio" ref="audio" preload="auto"></audio>
    <img id="musicImg" ref="image" />
    <div>
      <div class="currentSong">No Music Playing</div>
      <ProgressSlider
        id="nowPlayingProgress"
        ref="progress"
        :on-change="musicController.seek"
      />
    </div>
    <button id="musicPlayBtn" ref="play" class="musicPlayingIndicator"></button>
    <div id="musicPlayerList">
      <button ref="playlistButton"><img src="/res/playlist_play.svg" /></button>
      <div>
        <div>
          <b
            ><span class="ui zh">播放列表</span
            ><span class="ui en">Playlist</span></b
          >
          <label class="setting-switch">
            <span
              ><span class="ui zh">随机播放</span
              ><span class="ui en">Shuffle</span></span
            >
            <input id="musicShuffleBtn" ref="shuffle" type="checkbox" checked />
          </label>
        </div>
        <ol id="songList" ref="list"></ol>
      </div>
    </div>
  </div>
</template>
