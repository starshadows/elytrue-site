<script setup lang="ts">
import { computed, ref } from 'vue'
import Settings from '../../settings'
import GraphicsMode from '../GraphicsMode.vue'

const hideBackgroundCaptions = computed({
  get: () => Settings.hideBackgroundCaptions,
  set: (value: boolean) => (Settings.hideBackgroundCaptions = value),
})
const zoom = ref(Math.round(Settings.pageScale * 100))

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
            ><span class="ui zh">隐藏文字效果</span
            ><span class="ui en">Hide background captions</span></span
          ><input
            id="hideBackgroundCaptions"
            v-model="hideBackgroundCaptions"
            type="checkbox"
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
