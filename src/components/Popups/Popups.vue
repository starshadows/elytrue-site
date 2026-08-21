<template>
  <!-- The theme popup stays mounted because it owns the persistent audio player. -->
  <div
    v-show="themeEntry !== undefined"
    :class="{
      popupContainer: themeEntry !== undefined,
      closing: themeEntry?.closing,
    }"
    :data-popup-id="themeEntry?.id"
    data-popup-name="themeSelectorPopup"
    :data-topmost="themeEntry && isInteractive(themeEntry) ? 'true' : undefined"
    :style="themeEntry ? popupLayer(themeEntry) : undefined"
  >
    <div class="popupBG" @click="themeEntry && dismiss(themeEntry)"></div>
    <div
      id="themeSelectorPopup"
      class="popupItem"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :inert="!themeEntry || !isInteractive(themeEntry)"
      :aria-hidden="!themeEntry || !isInteractive(themeEntry)"
    >
      <ThemeMusicPopup />
      <button
        class="closeBtn"
        aria-label="关闭"
        @click="themeEntry && close(themeEntry)"
      ></button>
    </div>
  </div>

  <div
    v-for="item in renderedPopups"
    :key="item.id"
    :class="{ popupContainer: true, closing: item.closing }"
    :data-popup-id="item.id"
    :data-popup-name="item.name"
    :data-topmost="isInteractive(item) ? 'true' : undefined"
    :style="popupLayer(item)"
  >
    <div class="popupBG" @click="dismiss(item)"></div>
    <div
      class="popupItem"
      role="dialog"
      aria-modal="true"
      tabindex="-1"
      :id="isPersistentPopup(item.name) ? item.name : undefined"
      :inert="!isInteractive(item)"
      :aria-hidden="!isInteractive(item)"
    >
      <component
        :is="components[item.name]"
        v-bind="item.props"
        @close="closeComponent(item)"
      ></component>
      <button class="closeBtn" aria-label="关闭" @click="close(item)"></button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import BackgroundGalleryPopup from './BackgroundGalleryPopup.vue'
import DisplaySettingsPopup from './DisplaySettingsPopup.vue'
import ThemeMusicPopup from './ThemeMusicPopup.vue'
import Popups, {
  SINGLETON_POPUPS,
  type PopupEntry,
  type PopupName,
} from './index'

const POPUP_Z_INDEX_BASE = 100
const persistentPopupNames = new Set<PopupName>(SINGLETON_POPUPS)
const components: Partial<Record<PopupName, object>> = {
  displaySettings: DisplaySettingsPopup,
  getImgPopup: BackgroundGalleryPopup,
  themeSelectorPopup: ThemeMusicPopup,
}

const themeEntry = computed(() =>
  Popups.popups.find((item) => item.name === 'themeSelectorPopup'),
)
const renderedPopups = computed(() =>
  Popups.popups.filter(
    (item) =>
      item.name !== 'themeSelectorPopup' && components[item.name] !== undefined,
  ),
)

let originalBodyOverflow = ''
let originalDocumentOverflow = ''
let originalFocus: HTMLElement | null = null
let scrollLocked = false
const popupFocus = new Map<number, HTMLElement>()

function isPersistentPopup(name: PopupName): boolean {
  return persistentPopupNames.has(name)
}

function stackIndex(item: PopupEntry): number {
  return Popups.popups.findIndex((entry) => entry.id === item.id)
}

function popupLayer(item: PopupEntry): {
  pointerEvents: 'auto' | undefined
  zIndex: number
} {
  return {
    pointerEvents: item.closing ? 'auto' : undefined,
    zIndex: POPUP_Z_INDEX_BASE + stackIndex(item),
  }
}

function isInteractive(item: PopupEntry): boolean {
  if (item.closing || Popups.topmost()?.id !== item.id) return false
  const index = stackIndex(item)
  return !Popups.popups.slice(index + 1).some((entry) => entry.closing)
}

function close(item: PopupEntry): void {
  if (isInteractive(item)) Popups.close(item.id)
}

function dismiss(item: PopupEntry): void {
  close(item)
}

function closeComponent(item: PopupEntry): void {
  Popups.close(item.id)
}

function popupContainer(id: number): HTMLElement | null {
  return document.querySelector(`[data-popup-id="${id}"]`)
}

function focusPopup(item: PopupEntry): void {
  const container = popupContainer(item.id)
  if (!container) return
  const previous = popupFocus.get(item.id)
  const target =
    previous && container.contains(previous)
      ? previous
      : container.querySelector<HTMLElement>('.popupItem')
  target?.focus({ preventScroll: true })
}

function lockPage(): void {
  if (scrollLocked) return
  originalFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  originalBodyOverflow = document.body.style.overflow
  originalDocumentOverflow = document.documentElement.style.overflow
  document.body.style.overflow = 'hidden'
  document.documentElement.style.overflow = 'hidden'
  scrollLocked = true
}

function unlockPage(): void {
  if (!scrollLocked) return
  document.body.style.overflow = originalBodyOverflow
  document.documentElement.style.overflow = originalDocumentOverflow
  scrollLocked = false
  const target = originalFocus
  originalFocus = null
  popupFocus.clear()
  if (target?.isConnected) target.focus({ preventScroll: true })
}

function handleFocusIn(event: FocusEvent): void {
  if (!(event.target instanceof HTMLElement)) return
  const container = event.target.closest<HTMLElement>('[data-popup-id]')
  if (!container) return
  const id = Number(container.dataset.popupId)
  if (Number.isInteger(id)) popupFocus.set(id, event.target)
}

function handleTab(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const top = Popups.topmost()
  if (!top || !isInteractive(top)) return
  const container = popupContainer(top.id)
  if (!container) return
  const focusable = Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => !element.closest('[inert]'))
  if (focusable.length === 0) {
    event.preventDefault()
    focusPopup(top)
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (
    !container.contains(document.activeElement) ||
    (event.shiftKey && document.activeElement === first) ||
    (!event.shiftKey && document.activeElement === last)
  ) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  }
}

watch(
  () =>
    Popups.popups
      .map((item) => `${item.id}:${item.name}:${item.closing}`)
      .join(','),
  async () => {
    if (Popups.popups.length > 0) lockPage()
    await nextTick()
    if (Popups.popups.length === 0) {
      unlockPage()
      return
    }
    const top = Popups.topmost()
    if (top && isInteractive(top)) focusPopup(top)
  },
  { flush: 'post' },
)

onMounted(() => {
  document.addEventListener('focusin', handleFocusIn)
  document.addEventListener('keydown', handleTab)
})

onBeforeUnmount(() => {
  document.removeEventListener('focusin', handleFocusIn)
  document.removeEventListener('keydown', handleTab)
  unlockPage()
})
</script>

<style></style>
