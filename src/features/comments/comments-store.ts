import { computed, reactive, readonly } from 'vue'
import {
  commentsApi,
  getComment,
  type CommentQuery,
  type CommentsApi,
} from './comments-api'
import type { CommentRecord } from './comment-types'

type LoadKind = 'initial' | 'newer' | 'older' | 'jump'

interface CommentsState {
  items: CommentRecord[]
  loadingInitial: boolean
  loadingNewer: boolean
  loadingOlder: boolean
  reachedNewest: boolean
  reachedOldest: boolean
  jumpNumber: number | null
  currentVisibleTime: number | null
  todayCount: number
}

function compareComments(left: CommentRecord, right: CommentRecord): number {
  return right.time - left.time || right.id - left.id
}

export function createCommentsStore(api: CommentsApi) {
  const state = reactive<CommentsState>({
    items: [],
    loadingInitial: false,
    loadingNewer: false,
    loadingOlder: false,
    reachedNewest: false,
    reachedOldest: false,
    jumpNumber: null,
    currentVisibleTime: null,
    todayCount: 0,
  })
  const pending = new Map<LoadKind, Promise<void>>()
  const likeLocks = new Map<number, Promise<void>>()
  let generation = 0

  function merge(items: CommentRecord[]): void {
    const merged = new Map(state.items.map((item) => [item.id, item]))
    items.forEach((item) => merged.set(item.id, item))
    state.items = [...merged.values()].sort(compareComments)
  }

  function setLoading(kind: LoadKind, loading: boolean): void {
    if (kind === 'initial' || kind === 'jump') state.loadingInitial = loading
    else if (kind === 'newer') state.loadingNewer = loading
    else state.loadingOlder = loading
  }

  function load(
    kind: LoadKind,
    query: CommentQuery,
    replace = false,
  ): Promise<void> {
    const existing = pending.get(kind)
    if (existing) return existing
    const requestGeneration = generation
    setLoading(kind, true)
    const request = api
      .list(query)
      .then((page) => {
        if (requestGeneration !== generation) return
        if (replace) state.items = []
        merge(page.items)
        if (kind === 'initial' || kind === 'newer') {
          state.reachedNewest = page.items.length === 0
        }
        if (kind === 'older') {
          const requested = Math.abs(query.count ?? 30)
          state.reachedOldest = !page.hasMore && page.items.length < requested
        }
        if (kind === 'jump') {
          state.reachedNewest = false
          state.reachedOldest = !page.hasMore && page.items.length === 0
        }
      })
      .finally(() => {
        if (requestGeneration === generation) setLoading(kind, false)
        if (pending.get(kind) === request) pending.delete(kind)
      })
    pending.set(kind, request)
    return request
  }

  async function refreshTodayCount(): Promise<void> {
    state.todayCount = await api.getCount().catch(() => 0)
  }

  async function refresh(): Promise<void> {
    generation += 1
    pending.clear()
    state.items = []
    state.reachedNewest = false
    state.reachedOldest = false
    state.jumpNumber = null
    await Promise.all([load('initial', {}, true), refreshTodayCount()])
  }

  function initialize(): Promise<void> {
    if (state.items.length > 0 || state.loadingInitial) {
      return pending.get('initial') ?? Promise.resolve()
    }
    return Promise.all([load('initial', {}, true), refreshTodayCount()]).then(
      () => undefined,
    )
  }

  function loadNewer(count = 10): Promise<void> {
    if (state.reachedNewest) return Promise.resolve()
    const newest = state.items[0]
    return load('newer', newest ? { from: newest.id + 1, count: -count } : {})
  }

  function loadOlder(count = 30): Promise<void> {
    if (state.reachedOldest) return Promise.resolve()
    const oldest = state.items.at(-1)
    return load('older', oldest ? { from: oldest.id - 1, count } : { count })
  }

  function resetForJump(number: number | null): void {
    generation += 1
    pending.clear()
    state.jumpNumber = number
    state.items = []
    state.reachedNewest = false
    state.reachedOldest = false
  }

  function gotoNumber(value: number | string): Promise<void> {
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1) return Promise.resolve()
    resetForJump(number)
    return load('jump', { number }, true)
  }

  function loadAtTime(time: number): Promise<void> {
    if (!Number.isFinite(time)) return Promise.resolve()
    resetForJump(null)
    return load('jump', { time }, true)
  }

  function setCurrentVisibleTime(time: number | null): void {
    state.currentVisibleTime = time
  }

  function toggleLike(id: number): Promise<void> {
    const existing = likeLocks.get(id)
    if (existing) return existing
    const item = state.items.find((comment) => comment.id === id)
    if (!item) return Promise.resolve()
    const before = { liked: item.liked, likes: item.likes }
    item.liked = !item.liked
    item.likes = Math.max(0, item.likes + (item.liked ? 1 : -1))
    const request = api
      .like(id, before.liked)
      .then(async () => {
        const current = await getComment(api, id)
        if (!current) return
        const target = state.items.find((comment) => comment.id === id)
        if (target) Object.assign(target, current)
      })
      .catch((error: unknown) => {
        const target = state.items.find((comment) => comment.id === id)
        if (target) Object.assign(target, before)
        throw error
      })
      .finally(() => likeLocks.delete(id))
    likeLocks.set(id, request)
    return request
  }

  return {
    hasItems: computed(() => state.items.length > 0),
    gotoNumber,
    initialize,
    loadAtTime,
    loadNewer,
    loadOlder,
    refresh,
    refreshTodayCount,
    setCurrentVisibleTime,
    state: readonly(state),
    toggleLike,
  }
}

export const commentsStore = createCommentsStore(commentsApi)
