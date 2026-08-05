import { computed, ref } from 'vue'

export type PageEntrancePhase = 'pending' | 'playing' | 'finished'

export const pageEntrancePhase = ref<PageEntrancePhase>('pending')
export const pageEntrancePlaying = computed(
  () => pageEntrancePhase.value === 'playing',
)

export function startPageEntrance(): void {
  if (pageEntrancePhase.value === 'finished') return
  pageEntrancePhase.value = 'playing'
  if (typeof document !== 'undefined')
    document.documentElement.dataset.entrance = 'playing'
}

export function finishPageEntrance(): void {
  if (pageEntrancePhase.value === 'finished') return
  pageEntrancePhase.value = 'finished'
  if (typeof document !== 'undefined')
    document.documentElement.dataset.entrance = 'finished'
}
