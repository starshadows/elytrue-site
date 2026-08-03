<script setup lang="ts">
import { ref } from 'vue'
import { getConfig, setConfig } from '../../settings/config'
import Settings from '../../settings'
import GraphicsMode from '../GraphicsMode.vue'

const showTimeline = ref(getConfig('showTimeline') !== 'false')
const hideTopComment = ref(getConfig('hideTopComment') === 'true')
const showHidden = ref(Settings.showHidden)
const zoom = ref(Math.round(Settings.pageScale * 100))

function toggleTimeline(): void {
  setConfig('showTimeline', showTimeline.value)
  document
    .getElementById('timelineContainer')
    ?.style.setProperty('display', showTimeline.value ? 'block' : 'none')
  document
    .getElementById('comments')
    ?.classList.toggle('noscrollbar', showTimeline.value)
}

function togglePinned(): void {
  setConfig('hideTopComment', hideTopComment.value)
  document
    .getElementById('topComment')
    ?.style.setProperty('display', hideTopComment.value ? 'none' : '')
}

function toggleHidden(): void {
  Settings.showHidden = showHidden.value
}

function updateZoom(delta = 0): void {
  zoom.value = Math.min(500, Math.max(50, zoom.value + delta))
  Settings.pageScale = zoom.value / 100
}
</script>

<template>
  <div>
    <h2>
      <span class="ui zh">显示设置</span
      ><span class="ui en">Display settings</span>
    </h2>
    <ul>
      <li>
        <label class="setting-switch"
          ><span
            ><span class="ui zh">显示时间轴</span
            ><span class="ui en">Show timeline</span></span
          ><input
            id="showTimeline"
            v-model="showTimeline"
            type="checkbox"
            @change="toggleTimeline"
        /></label>
      </li>
      <li>
        <label class="setting-switch"
          ><span
            ><span class="ui zh">隐藏置顶说明</span
            ><span class="ui en">Hide pinned notice</span></span
          ><input
            id="hideTopComment"
            v-model="hideTopComment"
            type="checkbox"
            @change="togglePinned"
        /></label>
      </li>
      <li>
        <label class="setting-switch"
          ><span
            ><span class="ui zh">显示被隐藏留言</span
            ><span class="ui en">Show hidden messages</span></span
          ><input
            id="showHidden"
            v-model="showHidden"
            type="checkbox"
            @change="toggleHidden"
        /></label>
      </li>
      <li>
        <span
          ><span class="ui zh">画面效果</span
          ><span class="ui en">Graphics</span></span
        ><GraphicsMode id="graphicsMode" />
      </li>
      <li>
        <span
          ><span class="ui zh">界面缩放</span
          ><span class="ui en">UI scale</span></span
        >
        <div style="white-space: nowrap">
          <button @click="updateZoom(-10)">-</button>
          <input
            id="pageZoomController"
            v-model.number="zoom"
            style="width: 3em"
            @change="updateZoom()"
          />
          <button @click="updateZoom(10)">+</button>
        </div>
      </li>
    </ul>
  </div>
</template>
