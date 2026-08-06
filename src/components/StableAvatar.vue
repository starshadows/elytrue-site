<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { preloadAvatar } from '../features/auth/avatar-loader'

const DEFAULT_AVATAR =
  '/assets/elytrue-shell-20260805/default-avatar-320-dd2f4539.png'

const props = withDefaults(
  defineProps<{
    src: string
    fallbackSrc?: string
    alt?: string
    loading?: 'eager' | 'lazy'
    fetchpriority?: 'high' | 'low' | 'auto'
  }>(),
  {
    fallbackSrc: DEFAULT_AVATAR,
    alt: '',
    loading: 'lazy',
    fetchpriority: 'auto',
  },
)

const fallback = computed(() => props.fallbackSrc.trim() || DEFAULT_AVATAR)
const targetSource = computed(() => props.src.trim() || fallback.value)
const isDynamicAvatar = (source: string): boolean =>
  source.includes('/api/data/images/avatars/')
const displayedSrc = ref(targetSource.value)
let loadVersion = 0
let pendingSource = ''
let unmounted = false

function clearPendingImage(): void {
  pendingSource = ''
}

async function commitLoadedAvatar(
  image: HTMLImageElement,
  source: string,
  version: number,
): Promise<void> {
  try {
    await image.decode()
  } catch {
    if (!image.complete || image.naturalWidth <= 0) {
      if (version === loadVersion) clearPendingImage()
      return
    }
  }
  if (unmounted || version !== loadVersion || targetSource.value !== source)
    return
  clearPendingImage()
  displayedSrc.value = source
}

function loadSource(source: string): void {
  if (source === displayedSrc.value) {
    if (pendingSource && pendingSource !== source) {
      loadVersion += 1
      clearPendingImage()
    }
    return
  }
  if (source === pendingSource) return

  const version = ++loadVersion
  clearPendingImage()
  pendingSource = source
  void preloadAvatar(source)
    .then((image) => commitLoadedAvatar(image, source, version))
    .catch(() => {
      if (version === loadVersion) clearPendingImage()
    })
}

function handleDisplayedError(): void {
  if (!isDynamicAvatar(targetSource.value)) return
  if (displayedSrc.value !== targetSource.value) return
  loadVersion += 1
  clearPendingImage()
  displayedSrc.value = fallback.value
}

watch(targetSource, loadSource, { immediate: true })

onBeforeUnmount(() => {
  unmounted = true
  loadVersion += 1
  clearPendingImage()
})
</script>

<template>
  <img
    class="stableAvatar"
    :src="displayedSrc"
    :alt="alt"
    :loading="loading"
    :fetchpriority="fetchpriority"
    @error="handleDisplayedError"
  />
</template>
