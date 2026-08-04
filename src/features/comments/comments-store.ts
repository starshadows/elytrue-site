import { computed, reactive, readonly } from 'vue'
import {
  commentsApi,
  getComment,
  type CommentQuery,
  type CommentsApi,
} from './comments-api'
import type { CommentRecord } from './comment-types'

type LoadKind = 'initial' | 'newer' | 'older' | 'replacement'

interface CommentsState {
  items: CommentRecord[]
  loadingInitial: boolean
  loadingNewer: boolean
  loadingOlder: boolean
  reachedNewest: boolean
  reachedOldest: boolean
  jumpNumber: number | null
  jumping: boolean
  likePendingIds: Set<number>
  currentVisibleTime: number | null
  todayCount: number
  initialError: boolean
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
    jumping: false,
    likePendingIds: new Set<number>(),
    currentVisibleTime: null,
    todayCount: 0,
    initialError: false,
  })
  const pending = new Map<LoadKind, Promise<void>>()
  const likeLocks = new Map<number, Promise<void>>()
  let generation = 0
  let insertionVersion = 0
  const insertedVersions = new Map<number, number>()
  let nextOlderCursor: number | null = null

  function merge(items: CommentRecord[]): void {
    const merged = new Map(state.items.map((item) => [item.id, item]))
    items.forEach((item) => merged.set(item.id, item))
    state.items = [...merged.values()].sort(compareComments)
  }

  function setLoading(kind: LoadKind, loading: boolean): void {
    if (kind === 'initial' || kind === 'replacement')
      state.loadingInitial = loading
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
    const requestInsertionVersion = insertionVersion
    setLoading(kind, true)
    const request = api
      .list(query)
      .then((page) => {
        if (requestGeneration !== generation) return
        if (kind === 'initial' || kind === 'replacement')
          state.initialError = false
        const insertedDuringRequest = replace
          ? state.items.filter(
              (item) =>
                (insertedVersions.get(item.id) ?? 0) > requestInsertionVersion,
            )
          : []
        if (replace) state.items = []
        merge(page.items)
        merge(insertedDuringRequest)
        for (const item of page.items) insertedVersions.delete(item.id)
        if (kind === 'initial' || kind === 'newer') {
          state.reachedNewest = page.items.length === 0
        }
        if (kind === 'initial') {
          const requested = Math.abs(query.count ?? 30)
          state.reachedOldest = !page.hasMore && page.items.length < requested
        }
        if (kind === 'older') {
          const requested = Math.abs(query.count ?? 30)
          state.reachedOldest = !page.hasMore && page.items.length < requested
        }
        if (kind === 'initial' || kind === 'older') {
          nextOlderCursor = page.hasMore
            ? (page.nextCursor ?? page.items.at(-1)?.id ?? null)
            : null
        }
        if (kind === 'replacement') {
          state.reachedNewest = false
          state.reachedOldest = !page.hasMore && page.items.length === 0
        }
      })
      .catch((error: unknown) => {
        if (
          requestGeneration === generation &&
          (kind === 'initial' || kind === 'replacement')
        ) {
          state.initialError = true
        }
        throw error
      })
      .finally(() => {
        if (requestGeneration === generation) setLoading(kind, false)
        if (pending.get(kind) === request) pending.delete(kind)
      })
    pending.set(kind, request)
    return request
  }

  async function refreshTodayCount(): Promise<void> {
    const count = await api.getCount().catch(() => null)
    if (count !== null) state.todayCount = count
  }

  async function refresh(): Promise<void> {
    resetForReplacement()
    await Promise.all([load('initial', {}, true), refreshTodayCount()])
  }

  function initialize(): Promise<void> {
    if (state.items.length > 0 || state.loadingInitial) {
      return (
        pending.get('initial') ??
        pending.get('replacement') ??
        Promise.resolve()
      )
    }
    return Promise.all([load('initial', {}, true), refreshTodayCount()]).then(
      () => undefined,
    )
  }

  function loadNewer(count = 10): Promise<void> {
    if (state.jumping || state.reachedNewest) return Promise.resolve()
    const newest = state.items[0]
    return load(
      'newer',
      newest ? { cursor: newest.id, direction: 'after', count: -count } : {},
    )
  }

  function loadOlder(count = 30): Promise<void> {
    if (state.jumping || state.reachedOldest) return Promise.resolve()
    const oldest = state.items.at(-1)
    const cursor = nextOlderCursor ?? oldest?.id
    return load(
      'older',
      cursor ? { cursor, direction: 'before', count } : { count },
    )
  }

  function insertCreatedComment(comment: CommentRecord): void {
    const wasEmpty = state.items.length === 0
    insertionVersion += 1
    insertedVersions.set(comment.id, insertionVersion)
    merge([comment])
    state.reachedNewest = true
    state.initialError = false
    if (wasEmpty) state.currentVisibleTime = comment.time
    state.todayCount += 1
    void refreshTodayCount()
  }

  function resetForReplacement(): void {
    generation += 1
    pending.clear()
    state.loadingInitial = false
    state.loadingNewer = false
    state.loadingOlder = false
    state.jumpNumber = null
    state.jumping = false
    state.items = []
    state.reachedNewest = false
    state.reachedOldest = false
    state.currentVisibleTime = null
    nextOlderCursor = null
    state.initialError = false
  }

  function finishJump(): void {
    state.jumpNumber = null
    state.jumping = false
  }

  function gotoNumber(value: number | string): Promise<void> {
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1) return Promise.resolve()
    resetForReplacement()
    state.jumpNumber = number
    state.jumping = true
    const jumpGeneration = generation
    return load('replacement', { number }, true).catch((error: unknown) => {
      if (jumpGeneration === generation && state.jumpNumber === number) {
        finishJump()
      }
      throw error
    })
  }

  function loadAtTime(time: number): Promise<void> {
    if (!Number.isFinite(time)) return Promise.resolve()
    resetForReplacement()
    return load('replacement', { time }, true)
  }

  function setCurrentVisibleTime(time: number | null): void {
    state.currentVisibleTime = time
  }

  function isLikePending(id: number): boolean {
    return state.likePendingIds.has(id)
  }

  function toggleLike(id: number): Promise<void> {
    const existing = likeLocks.get(id)
    if (existing) return existing
    const item = state.items.find((comment) => comment.id === id)
    if (!item) return Promise.resolve()
    state.likePendingIds.add(id)
    const before = { liked: item.liked, likes: item.likes }
    item.liked = !item.liked
    item.likes = Math.max(0, item.likes + (item.liked ? 1 : -1))
    const request = Promise.resolve()
      .then(() => api.like(id, before.liked))
      .then(async (result) => {
        if (result) {
          const target = state.items.find((comment) => comment.id === id)
          if (target) {
            target.liked = result.liked
            target.likes = result.likes
          }
          return
        }
        const current = await getComment(api, id)
        if (!current) return
        const target = state.items.find((comment) => comment.id === id)
        if (target) Object.assign(target, current)
      })
      .catch((error: unknown) => {
        const target = state.items.find((comment) => comment.id === id)
        if (target === item) Object.assign(target, before)
        throw error
      })
      .finally(() => {
        likeLocks.delete(id)
        state.likePendingIds.delete(id)
      })
    likeLocks.set(id, request)
    return request
  }

  return {
    hasItems: computed(() => state.items.length > 0),
    finishJump,
    gotoNumber,
    initialize,
    insertCreatedComment,
    isLikePending,
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
