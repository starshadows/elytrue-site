<script setup lang="ts">
import { onMounted } from 'vue'
import { applyBackgroundMetadata } from '../config/assets'
import { useAuth, type ProfileAction } from '../features/auth/useAuth'
import { useComments } from '../features/comments/useComments'
import {
  useSiteSettings,
  type SupportedLanguage,
} from '../features/settings/useSiteSettings'
import {
  bindControllerEvents,
  registerController,
  requireController,
} from './controller'

const auth = useAuth()
const comments = useComments()
const siteSettings = useSiteSettings()

onMounted(async () => {
  const controller = await import('../index')
  registerController(controller)
  bindControllerEvents()
  applyBackgroundMetadata()
  await import('../components')
  document.documentElement.dataset.appReady = 'true'
})

function showPopup(id: string): void {
  requireController().showPopup(id, undefined)
}

function userAction(
  action: Extract<
    ProfileAction,
    'changeName' | 'changeAvatar' | 'changeEmail' | 'showMe' | 'logout'
  >,
): void {
  auth.runProfileAction(action)
}

function hidePinnedNotice(): void {
  const controller = requireController()
  controller.hideTopCommentElmnt?.click()
  controller.FloatMsgs.show({
    type: 'success',
    persist: true,
    msg: `
      <span class="ui zh">隐藏成功。可在【工具】→【显示设置】中重新打开</span>
      <span class="ui en">Hidden. Can be displayed again via [Tools] → [Display settings]</span>
    `,
  })
}

function refreshComments(): void {
  comments.refresh()
}

function seekComment(direction: -1 | 1): void {
  comments.seek(direction)
}

function newComment(): void {
  comments.openEditor()
}

function installPwa(): void {
  const controller = requireController()
  const prompt = controller.installPrompt as {
    prompt: () => Promise<void>
  } | null
  if (prompt) {
    void prompt.prompt()
  } else if (controller.isInStandaloneMode) {
    controller.FloatMsgs.show({
      type: 'info',
      msg: '<span class="ui zh">你已安装过App</span><span class="ui en">App already installed</span>',
    })
  } else {
    window.alert(
      '你的浏览器不支持安装PWA App\n\n建议使用谷歌Chrome/微软Edge浏览器\n\n你也可以从浏览器菜单手动添加到桌面\n\nYour browser does not seem to support PWA Apps.\nWe recommend using Google Chrome or Microsoft Edge to do this.',
    )
  }
}

function setLanguage(language: SupportedLanguage): void {
  siteSettings.setLanguage(language)
}

function gotoComment(): void {
  const value = document.querySelector<HTMLInputElement>('#goto')?.value
  if (!value) return
  comments.gotoNumber(value)
}

function toggleFullscreen(): void {
  requireController().toggleFullscreen()
}

function toggleTimeline(): void {
  requireController().toggleTimeline()
}

function toggleTopComment(): void {
  requireController().toggleTopComment()
}

function toggleHidden(event: Event): void {
  siteSettings.setShowHidden((event.currentTarget as HTMLInputElement).checked)
}

function updateZoom(value: number): void {
  if (value >= 50 && value <= 500) {
    siteSettings.setZoom(value)
  }
}

function changeZoom(event: Event): void {
  updateZoom(
    Number.parseInt((event.currentTarget as HTMLInputElement).value, 10),
  )
}

function adjustZoom(delta: number): void {
  const input = document.querySelector<HTMLInputElement>('#pageZoomController')
  if (!input) return
  const value = Math.min(
    500,
    Math.max(50, Number.parseInt(input.value, 10) + delta),
  )
  input.value = String(value)
  updateZoom(value)
}

defineExpose({
  adjustZoom,
  changeZoom,
  gotoComment,
  hidePinnedNotice,
  installPwa,
  newComment,
  refreshComments,
  seekComment,
  setLanguage,
  showPopup,
  toggleFullscreen,
  toggleHidden,
  toggleTimeline,
  toggleTopComment,
  userAction,
})
</script>

<template src="./shell.html"></template>
