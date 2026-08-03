<template>
  <div
    v-for="name in staticNames"
    v-show="staticEntry(name)"
    :key="name"
    :class="{
      popupContainer: Boolean(staticEntry(name)),
      closing: staticEntry(name)?.closing,
    }"
  >
    <div class="popupBG" @click="closeStatic(name)"></div>
    <div :id="name" class="popupItem">
      <component :is="components[name]"></component>
      <button class="closeBtn" @click="closeStatic(name)"></button>
    </div>
  </div>
  <div
    v-for="item in dynamicPopups"
    :key="item.id"
    :class="{ popupContainer: true, closing: item.closing }"
  >
    <div class="popupBG" @click="close(item.id)"></div>
    <div class="popupItem">
      <component
        :id="item.name"
        :is="components[item.name]"
        v-bind="item.props"
        @close="close(item.id)"
      ></component>
      <button class="closeBtn" @click="close(item.id)"></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import AdminPanel from './AdminPanel.vue'
import BackgroundGalleryPopup from './BackgroundGalleryPopup.vue'
import DisplaySettingsPopup from './DisplaySettingsPopup.vue'
import InputPopup from './InputPopup.vue'
import LoginPopup from './LoginPopup.vue'
import SetAvatarPopup from './SetAvatarPopup.vue'
import SetPasswordPopup from './SetPasswordPopup.vue'
import ThemeMusicPopup from './ThemeMusicPopup.vue'
import UserHome from './UserHome.vue'
import Popups, { type PopupName } from './index'

const components: Record<PopupName, object> = {
  adminPanel: AdminPanel,
  displaySettings: DisplaySettingsPopup,
  getImgPopup: BackgroundGalleryPopup,
  loginPopup: LoginPopup,
  promptInputPopup: InputPopup,
  setAvatarPopup: SetAvatarPopup,
  setPasswordPopup: SetPasswordPopup,
  themeSelectorPopup: ThemeMusicPopup,
  userHome: UserHome,
}

const staticNames = [
  'getImgPopup',
  'themeSelectorPopup',
  'displaySettings',
] as const satisfies readonly PopupName[]
const dynamicPopups = computed(() =>
  Popups.popups.filter(
    (item) => !staticNames.some((name) => name === item.name),
  ),
)

function staticEntry(name: PopupName) {
  return Popups.popups.find((item) => item.name === name)
}

function closeStatic(name: PopupName): void {
  const entry = staticEntry(name)
  if (entry) Popups.close(entry.id)
}

function close(id: number): void {
  Popups.close(id)
}
</script>

<style></style>
