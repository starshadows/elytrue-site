import { computed, reactive, readonly } from 'vue'
import {
  commentsApi,
  getComment,
  loadInitialComments,
  type CommentQuery,
  type CommentsApi,
} from './comments-api'
import type { CommentPage, CommentRecord } from './comment-types'
import { markPerformanceEvent } from '../../lib/performance'
import { readHomeCommentsCache, writeHomeCommentsCache } from './comments-cache'
import { reconcileComments } from './comments-reconcile'

type LoadKind = 'initial' | 'newer' | 'older' | 'replacement'
const MAX_REFRESH_PAGES = 10
const MAX_REFRESH_ADDITIONS = 500
export type CommentRenderOrigin =
  'cache' | 'initial-network' | 'revalidated' | 'new' | 'created' | 'pagination'

export interface BootstrapCommentHydration {
  page: CommentPage
  todayCountRequest?: Promise<number | null>
  todayCountResolved: boolean
  viewerLikesComplete: boolean
}

export type BootstrapCommentHydrationSource =
  | Promise<BootstrapCommentHydration>
  | ((isCurrent: () => boolean) => Promise<BootstrapCommentHydration>)

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

function shanghaiDate(now = Date.now()): string {
  return new Date(now + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10)
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
  let refreshRequest: Promise<void> | undefined
  let generation = 0
  let insertionVersion = 0
  const insertedVersions = new Map<number, number>()
  let nextNewerCursor: number | null = null
  let nextOlderCursor: number | null = null
  let todayCountFresh = false
  let todayCountDate = shanghaiDate()
  let countRequestVersion = 0
  let viewerLikeVersion = 0
  const likeMutationVersions = new Map<number, number>()
  const animatedCommentIds = new Set<number>()
  const enteringCommentIds = new Set<number>()
  let homeCacheHasMore = false
  let homeCacheNextCursor: number | null = null
  let homeView = true

  function merge(items: CommentRecord[], origin: CommentRenderOrigin): void {
    const merged = new Map(state.items.map((item) => [item.id, item]))
    let added = false
    for (const item of items) {
      const current = merged.get(item.id)
      if (current) {
        reconcileComments([current], [item])
      } else {
        merged.set(item.id, item)
        queueAnimation(item.id, origin)
        added = true
      }
    }
    if (added) state.items = [...merged.values()].sort(compareComments)
  }

  function queueAnimation(id: number, origin: CommentRenderOrigin): void {
    if (origin === 'cache' || origin === 'initial-network') {
      animatedCommentIds.add(id)
      return
    }
    if (animatedCommentIds.has(id)) return
    animatedCommentIds.add(id)
    enteringCommentIds.add(id)
  }

  function hydrateHomeCache(): boolean {
    if (state.items.length > 0) return false
    const cached = readHomeCommentsCache()
    if (!cached) return false
    state.items = cached.items.sort(compareComments)
    homeCacheHasMore = cached.hasMore
    homeCacheNextCursor = cached.nextCursor ?? null
    nextOlderCursor = homeCacheNextCursor
    state.reachedNewest = true
    state.reachedOldest = !cached.hasMore
    for (const item of cached.items) queueAnimation(item.id, 'cache')
    return true
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
    suppliedRequest?: Promise<CommentPage>,
  ): Promise<void> {
    const existing = pending.get(kind)
    if (existing) return existing
    const requestGeneration = generation
    const requestInsertionVersion = insertionVersion
    const requestLikeVersions = new Map(likeMutationVersions)
    const pendingLikeAtStart = new Set(state.likePendingIds)
    setLoading(kind, true)
    const request = (suppliedRequest ?? api.list(query))
      .then((page) => {
        if (requestGeneration !== generation) return
        if (kind === 'initial' || kind === 'replacement')
          state.initialError = false
        if (kind === 'initial' && page.todayCount !== undefined) {
          state.todayCount = page.todayCount
          todayCountFresh = true
        }
        const insertedDuringRequest = replace
          ? state.items.filter(
              (item) =>
                (insertedVersions.get(item.id) ?? 0) > requestInsertionVersion,
            )
          : []
        const visiblePageItems = page.items.filter((item) => !item.hidden)
        const protectedLikes = new Map(
          state.items
            .filter(
              (item) =>
                pendingLikeAtStart.has(item.id) ||
                (likeMutationVersions.get(item.id) ?? 0) !==
                  (requestLikeVersions.get(item.id) ?? 0),
            )
            .map((item) => [item.id, { liked: item.liked, likes: item.likes }]),
        )
        const origin: CommentRenderOrigin =
          kind === 'initial'
            ? state.items.length > 0
              ? 'revalidated'
              : 'initial-network'
            : kind === 'newer'
              ? 'new'
              : kind === 'older'
                ? 'pagination'
                : 'revalidated'
        if (replace) {
          const result = reconcileComments(state.items, visiblePageItems)
          state.items = result.items.sort(compareComments)
          for (const id of result.newIds) queueAnimation(id, origin)
        } else merge(visiblePageItems, origin)
        merge(insertedDuringRequest, 'created')
        for (const [id, like] of protectedLikes) {
          const current = state.items.find((item) => item.id === id)
          if (current) Object.assign(current, like)
        }
        if (kind === 'initial') {
          markPerformanceEvent('comments-state-committed', {
            count: state.items.length,
          })
        }
        for (const item of visiblePageItems) insertedVersions.delete(item.id)
        if (kind === 'initial') {
          // 首次加载请求的就是最新一页:已到最新端,避免无谓的 loadNewer
          state.reachedNewest = true
          state.reachedOldest = !page.hasMore
          homeCacheHasMore = page.hasMore
          homeCacheNextCursor = page.nextCursor ?? null
          writeHomeCommentsCache(state.items, page.hasMore, page.nextCursor)
        }
        if (kind === 'newer') {
          state.reachedNewest = !page.hasMore
          nextNewerCursor = page.hasMore
            ? (page.nextCursor ?? page.items[0]?.id ?? null)
            : null
        }
        if (kind === 'older') {
          state.reachedOldest = !page.hasMore
        }
        if (kind === 'initial' || kind === 'older') {
          nextOlderCursor = page.hasMore
            ? (page.nextCursor ?? page.items.at(-1)?.id ?? null)
            : null
        }
        if (kind === 'replacement') {
          state.reachedNewest = false
          // 编号查询只返回目标留言本身,不能据此判定旧端已到底。
          state.reachedOldest = query.number ? false : !page.hasMore
        }
      })
      .catch((error: unknown) => {
        const todayCount =
          typeof error === 'object' && error !== null
            ? Reflect.get(error, 'todayCount')
            : undefined
        if (
          requestGeneration === generation &&
          kind === 'initial' &&
          typeof todayCount === 'number'
        ) {
          state.todayCount = todayCount
          todayCountFresh = true
        }
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
    const requestVersion = ++countRequestVersion
    const requestDate = shanghaiDate()
    const count = await api.getCount().catch(() => null)
    if (
      count === null ||
      requestVersion !== countRequestVersion ||
      requestDate !== shanghaiDate()
    )
      return
    if (requestDate !== todayCountDate) {
      todayCountDate = requestDate
      state.todayCount = count
    } else state.todayCount = Math.max(state.todayCount, count)
  }

  function hydrateBootstrapTodayCount(
    request: Promise<number | null>,
    requestGeneration: number,
  ): void {
    const requestVersion = ++countRequestVersion
    const requestDate = shanghaiDate()
    void request.then((count) => {
      if (
        count === null ||
        requestGeneration !== generation ||
        requestVersion !== countRequestVersion ||
        requestDate !== shanghaiDate()
      )
        return
      todayCountDate = requestDate
      state.todayCount = Math.max(state.todayCount, count)
      todayCountFresh = true
    })
  }

  function refreshIncrementally(): Promise<void> {
    if (refreshRequest) return refreshRequest
    const request = performIncrementalRefresh().finally(() => {
      if (refreshRequest === request) refreshRequest = undefined
    })
    refreshRequest = request
    return request
  }

  function refresh(): Promise<void> {
    return refreshIncrementally()
  }

  async function performIncrementalRefresh(): Promise<void> {
    const initialRequest = pending.get('initial') ?? pending.get('replacement')
    if (initialRequest) {
      await initialRequest
      return
    }
    if (!state.items.length) {
      await initialize()
      return
    }

    const refreshGeneration = generation
    const seenCursors = new Set<number>()
    let pages = 0
    let additions = 0
    state.reachedNewest = false
    nextNewerCursor = null
    do {
      const cursorBefore = nextNewerCursor ?? state.items[0]?.id ?? null
      if (cursorBefore !== null) {
        if (seenCursors.has(cursorBefore)) {
          state.reachedNewest = true
          break
        }
        seenCursors.add(cursorBefore)
      }
      const idsBefore = new Set(state.items.map((item) => item.id))
      await loadNewer(100)
      pages += 1
      const pageAdditions = state.items.reduce(
        (count, item) => count + (idsBefore.has(item.id) ? 0 : 1),
        0,
      )
      additions += pageAdditions
      const cursorAfter = nextNewerCursor
      if (
        !state.reachedNewest &&
        (pageAdditions === 0 ||
          cursorAfter === cursorBefore ||
          (cursorAfter !== null && seenCursors.has(cursorAfter)) ||
          pages >= MAX_REFRESH_PAGES ||
          additions >= MAX_REFRESH_ADDITIONS)
      ) {
        state.reachedNewest = true
      }
    } while (
      refreshGeneration === generation &&
      !state.jumping &&
      !state.reachedNewest
    )
    if (refreshGeneration !== generation || state.jumping) return

    state.initialError = false
    if (homeView) {
      writeHomeCommentsCache(state.items, homeCacheHasMore, homeCacheNextCursor)
    }
    void refreshTodayCount()
  }

  function initialize(): Promise<void> {
    homeView = true
    const cacheUsed = hydrateHomeCache()
    if (state.items.length > 0 && !state.initialError) {
      return (
        pending.get('initial') ??
        pending.get('replacement') ??
        (cacheUsed ? loadInitialAfterCache() : Promise.resolve())
      )
    }
    if (state.loadingInitial) return pending.get('initial') ?? Promise.resolve()
    return load('initial', { count: 10 }, true, loadInitialComments(api)).then(
      () => {
        if (!todayCountFresh) void refreshTodayCount()
      },
    )
  }

  function loadInitialAfterCache(): Promise<void> {
    return load('initial', { count: 10 }, true, loadInitialComments(api)).then(
      () => {
        if (!todayCountFresh) void refreshTodayCount()
      },
    )
  }

  function hydrateBootstrap(
    hydration: BootstrapCommentHydrationSource,
  ): Promise<boolean> {
    homeView = true
    hydrateHomeCache()
    const hydrationGeneration = generation
    let metadata: BootstrapCommentHydration | undefined
    const source =
      typeof hydration === 'function'
        ? hydration(() => hydrationGeneration === generation)
        : hydration
    const pageRequest = source.then((result) => {
      metadata = result
      if (result.todayCountRequest) {
        hydrateBootstrapTodayCount(
          result.todayCountRequest,
          hydrationGeneration,
        )
      }
      return result.page
    })
    return load('initial', { count: 10 }, true, pageRequest).then(async () => {
      if (
        hydrationGeneration === generation &&
        !todayCountFresh &&
        !metadata?.todayCountResolved
      ) {
        await refreshTodayCount()
      }
      return (
        hydrationGeneration === generation &&
        metadata?.viewerLikesComplete === true
      )
    })
  }

  async function hydrateViewerLikes(): Promise<void> {
    const generationAtStart = generation
    const hydrationVersion = ++viewerLikeVersion
    const snapshots = state.items.map((item) => ({
      id: item.id,
      item,
      mutationVersion: likeMutationVersions.get(item.id) ?? 0,
      pending: state.likePendingIds.has(item.id),
    }))
    const batches = []
    for (let index = 0; index < snapshots.length; index += 20) {
      batches.push(
        api.getViewerLikes(
          snapshots.slice(index, index + 20).map((item) => item.id),
        ),
      )
    }
    const states = (await Promise.all(batches)).flat()
    if (
      generationAtStart !== generation ||
      hydrationVersion !== viewerLikeVersion
    )
      return
    const byId = new Map(states.map((item) => [item.id, item.liked]))
    for (const snapshot of snapshots) {
      const item = state.items.find((current) => current.id === snapshot.id)
      if (
        item !== snapshot.item ||
        snapshot.pending ||
        (likeMutationVersions.get(item.id) ?? 0) !== snapshot.mutationVersion
      )
        continue
      item.liked = byId.get(item.id) ?? false
    }
  }

  function clearViewerLikes(): void {
    viewerLikeVersion += 1
    for (const item of state.items) item.liked = false
  }

  function loadNewer(count = 10): Promise<void> {
    if (
      state.jumping ||
      state.reachedNewest ||
      state.loadingInitial ||
      state.loadingNewer
    )
      return pending.get('newer') ?? Promise.resolve()
    const newest = state.items[0]
    const cursor = nextNewerCursor ?? newest?.id
    return load(
      'newer',
      cursor ? { cursor, direction: 'after', count: -count } : {},
    )
  }

  function loadOlder(count = 30): Promise<void> {
    if (
      state.jumping ||
      state.reachedOldest ||
      state.loadingInitial ||
      state.loadingOlder
    )
      return pending.get('older') ?? Promise.resolve()
    const oldest = state.items.at(-1)
    const cursor = nextOlderCursor ?? oldest?.id
    return load(
      'older',
      cursor ? { cursor, direction: 'before', count } : { count },
    )
  }

  function insertCreatedComment(comment: CommentRecord): void {
    const currentDate = shanghaiDate()
    if (currentDate !== todayCountDate) {
      todayCountDate = currentDate
      state.todayCount = 0
    }
    const wasEmpty = state.items.length === 0
    insertionVersion += 1
    insertedVersions.set(comment.id, insertionVersion)
    merge([comment], 'created')
    state.reachedNewest = true
    state.initialError = false
    if (wasEmpty) state.currentVisibleTime = comment.time
    state.todayCount += 1
    if (homeView) {
      writeHomeCommentsCache(state.items, homeCacheHasMore, homeCacheNextCursor)
    }
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
    nextNewerCursor = null
    nextOlderCursor = null
    likeMutationVersions.clear()
    todayCountFresh = false
    state.initialError = false
    homeView = false
  }

  function finishJump(): void {
    state.jumpNumber = null
    state.jumping = false
  }

  function beginJump(displayId: number, query: CommentQuery): Promise<void> {
    resetForReplacement()
    state.jumpNumber = displayId
    state.jumping = true
    const jumpGeneration = generation
    return load('replacement', query, true).catch((error: unknown) => {
      if (jumpGeneration === generation && state.jumpNumber === displayId) {
        finishJump()
      }
      throw error
    })
  }

  function gotoNumber(value: number | string): Promise<void> {
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1) return Promise.resolve()
    return beginJump(number, { number })
  }

  function gotoId(value: number): Promise<void> {
    if (!Number.isSafeInteger(value) || value < 1) return Promise.resolve()
    return beginJump(value, { from: value, count: 1 })
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
    const viewerVersionAtStart = viewerLikeVersion
    likeMutationVersions.set(id, (likeMutationVersions.get(id) ?? 0) + 1)
    state.likePendingIds.add(id)
    const before = { liked: item.liked, likes: item.likes }
    item.liked = !item.liked
    item.likes = Math.max(0, item.likes + (item.liked ? 1 : -1))
    const request = Promise.resolve()
      .then(() => api.like(id, before.liked))
      .then(async (result) => {
        if (viewerVersionAtStart !== viewerLikeVersion) return
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
        if (viewerVersionAtStart !== viewerLikeVersion) throw error
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

  function consumeAnimationIds(): Set<number> {
    const ids = new Set(enteringCommentIds)
    enteringCommentIds.clear()
    return ids
  }

  return {
    hasItems: computed(() => state.items.length > 0),
    finishJump,
    gotoId,
    gotoNumber,
    hydrateBootstrap,
    hydrateViewerLikes,
    initialize,
    insertCreatedComment,
    isLikePending,
    loadAtTime,
    loadNewer,
    loadOlder,
    clearViewerLikes,
    consumeAnimationIds,
    refresh,
    refreshIncrementally,
    refreshTodayCount,
    setCurrentVisibleTime,
    state: readonly(state),
    toggleLike,
  }
}

export const commentsStore = createCommentsStore(commentsApi)
