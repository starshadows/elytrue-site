import { computed, reactive, readonly } from 'vue'
import {
  commentsApi,
  getComment,
  loadCanonicalInitialComments,
  loadInitialComments,
  type CommentQuery,
  type CommentsApi,
} from './comments-api'
import type { CommentPage, CommentRecord } from './comment-types'
import { markPerformanceEvent } from '../../lib/performance'
import {
  HOME_COMMENTS_CACHE_TTL,
  readCommentsConsistency,
  readHomeCommentsCache,
  readLocalCommentJournal,
  type LocalCommentJournalEntry,
  writeCommentsConsistency,
  writeHomeCommentsCache,
  writeLocalCommentJournal,
} from './comments-cache'
import { reconcileComments } from './comments-reconcile'

type LoadKind = 'initial' | 'background' | 'newer' | 'older' | 'replacement'
const MAX_REFRESH_PAGES = 10
const MAX_REFRESH_ADDITIONS = 500
const VERIFICATION_BACKOFF_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
] as const

export function commentVerificationBackoff(attempt: number): number {
  return VERIFICATION_BACKOFF_MS[
    Math.min(
      Math.max(0, Math.floor(attempt)),
      VERIFICATION_BACKOFF_MS.length - 1,
    )
  ]!
}
export type CommentRenderOrigin =
  'cache' | 'initial-network' | 'revalidated' | 'new' | 'created' | 'pagination'

export type SnapshotAcceptance = 'ACCEPTED' | 'REGRESSED' | 'FAILED'
export type CommitDurability = 'DURABLE' | 'EPHEMERAL'

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
  snapshotAcceptance: SnapshotAcceptance | null
  commitDurability: CommitDurability | null
  persistenceDegraded: boolean
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
    snapshotAcceptance: null,
    commitDurability: null,
    persistenceDegraded: false,
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
  const localJournal = new Map<number, LocalCommentJournalEntry>()
  let lastAcceptedSnapshotRevision =
    readCommentsConsistency().lastAcceptedSnapshotRevision
  let consistencyDurable = lastAcceptedSnapshotRevision !== undefined
  let homeSnapshotRevision: number | undefined
  let homeSnapshotDurable = false
  let hasAcceptedBaseline = false
  let sessionHydrated = false
  let verificationTimer: ReturnType<typeof setTimeout> | undefined
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

  function persistJournal(): boolean {
    const durable = writeLocalCommentJournal(localJournal.values())
    if (!durable) state.persistenceDegraded = true
    return durable
  }

  function hydrateHomeCache(): boolean {
    if (sessionHydrated) return hasAcceptedBaseline
    sessionHydrated = true
    const consistency = readCommentsConsistency()
    lastAcceptedSnapshotRevision = consistency.lastAcceptedSnapshotRevision
    const cached = readHomeCommentsCache(Date.now(), consistency)
    for (const entry of readLocalCommentJournal()) {
      localJournal.set(entry.id, entry)
    }
    if (cached) {
      if (
        lastAcceptedSnapshotRevision === undefined &&
        cached.snapshotRevision !== undefined
      ) {
        lastAcceptedSnapshotRevision = cached.snapshotRevision
        consistencyDurable = writeCommentsConsistency(cached.snapshotRevision)
        if (!consistencyDurable) state.persistenceDegraded = true
      }
      state.items = cached.items.sort(compareComments)
      homeCacheHasMore = cached.hasMore
      homeCacheNextCursor = cached.nextCursor ?? null
      homeSnapshotRevision = cached.snapshotRevision
      homeSnapshotDurable = true
      nextOlderCursor = homeCacheNextCursor
      state.reachedNewest = true
      state.reachedOldest = !cached.hasMore
      hasAcceptedBaseline = true
      if (
        cached.date === todayCountDate &&
        Number.isSafeInteger(cached.todayCount)
      ) {
        state.todayCount = Number(cached.todayCount)
        todayCountFresh = true
      }
      for (const item of cached.items) queueAnimation(item.id, 'cache')
      let migrated = false
      for (const confirmation of cached.localConfirmations ?? []) {
        if (localJournal.has(confirmation.id)) continue
        const item = cached.items.find(
          (comment) => comment.id === confirmation.id,
        )
        if (!item) continue
        localJournal.set(confirmation.id, {
          id: confirmation.id,
          comment: item,
          confirmedAt: confirmation.confirmedAt,
          state:
            Date.now() - confirmation.confirmedAt >= HOME_COMMENTS_CACHE_TTL
              ? 'VERIFY_REQUIRED'
              : 'PENDING_LOCAL',
          verificationAttempts: 0,
          nextVerifyAt:
            Date.now() - confirmation.confirmedAt >= HOME_COMMENTS_CACHE_TTL
              ? Date.now()
              : confirmation.confirmedAt + HOME_COMMENTS_CACHE_TTL,
          ...(confirmation.visibleSinceRevision === undefined
            ? {}
            : { visibleSinceRevision: confirmation.visibleSinceRevision }),
        })
        migrated = true
      }
      if (migrated) persistJournal()
      markPerformanceEvent('comments-cache-hydrated', {
        count: cached.items.length,
        age: Math.max(0, Date.now() - cached.savedAt),
        snapshotRevision: cached.snapshotRevision ?? '',
      })
    }
    merge(
      [...localJournal.values()].map((entry) => entry.comment),
      'cache',
    )
    if (cached || localJournal.size > 0) {
      markPerformanceEvent('comments-state-committed', {
        count: state.items.length,
        source: cached ? 'cache' : 'journal',
      })
    }
    scheduleVerification()
    return Boolean(cached)
  }

  function persistHomeCache(): void {
    if (
      !homeSnapshotDurable ||
      (lastAcceptedSnapshotRevision !== undefined &&
        (!consistencyDurable ||
          homeSnapshotRevision !== lastAcceptedSnapshotRevision))
    ) {
      state.persistenceDegraded = true
      return
    }
    const durable = writeHomeCommentsCache(
      state.items.filter((item) => !localJournal.has(item.id)),
      homeCacheHasMore,
      homeCacheNextCursor,
      {
        date: todayCountDate,
        ...(todayCountFresh ? { todayCount: state.todayCount } : {}),
        ...(homeSnapshotRevision === undefined
          ? {}
          : { snapshotRevision: homeSnapshotRevision }),
      },
    )
    if (!durable) state.persistenceDegraded = true
  }

  function canPreserveLocallyConfirmed(item: CommentRecord): boolean {
    return localJournal.has(item.id)
  }

  function assessSnapshot(page: CommentPage): SnapshotAcceptance {
    const revision = page.snapshotRevision
    if (lastAcceptedSnapshotRevision === undefined) return 'ACCEPTED'
    if (revision === undefined || revision < lastAcceptedSnapshotRevision) {
      return 'REGRESSED'
    }
    return 'ACCEPTED'
  }

  function membershipAck(page: CommentPage): CommitDurability {
    const incomingIds = new Set(page.items.map((item) => item.id))
    const ackedIds = [...localJournal.keys()].filter((id) =>
      incomingIds.has(id),
    )
    if (ackedIds.length === 0) return 'DURABLE'
    if (lastAcceptedSnapshotRevision !== undefined && !consistencyDurable) {
      consistencyDurable = writeCommentsConsistency(
        lastAcceptedSnapshotRevision,
      )
      if (!consistencyDurable) {
        state.persistenceDegraded = true
        return 'EPHEMERAL'
      }
    }
    const retained = [...localJournal.values()].filter(
      (entry) => !incomingIds.has(entry.id),
    )
    const durable = writeLocalCommentJournal(retained)
    if (durable) {
      for (const id of ackedIds) localJournal.delete(id)
    } else state.persistenceDegraded = true
    scheduleVerification()
    return durable ? 'DURABLE' : 'EPHEMERAL'
  }

  function prepareAcceptedSnapshot(
    page: CommentPage,
    cacheItems: CommentRecord[],
    cacheHasMore: boolean,
    cacheNextCursor: number | null,
  ): CommitDurability {
    let durable = true
    const revision = page.snapshotRevision
    if (
      revision !== undefined &&
      (revision !== lastAcceptedSnapshotRevision || !consistencyDurable)
    ) {
      durable = writeCommentsConsistency(revision)
      consistencyDurable = durable
      lastAcceptedSnapshotRevision = revision
    }
    if (membershipAck(page) === 'EPHEMERAL') durable = false
    if (durable) {
      durable = writeHomeCommentsCache(
        cacheItems,
        cacheHasMore,
        cacheNextCursor,
        {
          date: todayCountDate,
          ...(page.todayCount === undefined
            ? todayCountFresh
              ? { todayCount: state.todayCount }
              : {}
            : { todayCount: page.todayCount }),
          ...(revision === undefined ? {} : { snapshotRevision: revision }),
        },
      )
    }
    homeSnapshotDurable = durable
    if (!durable) state.persistenceDegraded = true
    return durable ? 'DURABLE' : 'EPHEMERAL'
  }

  function setLoading(kind: LoadKind, loading: boolean): void {
    if (kind === 'background') return
    if (kind === 'initial' || kind === 'replacement')
      state.loadingInitial = loading
    else if (kind === 'newer') state.loadingNewer = loading
    else state.loadingOlder = loading
  }

  function load(
    kind: LoadKind,
    query: CommentQuery,
    replace = false,
    suppliedRequest?: Promise<CommentPage | null>,
    preserveExistingOlder = false,
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
        if (page === null) {
          if (kind === 'initial' || kind === 'background') {
            state.initialError = false
          }
          return
        }
        const homeSnapshot = kind === 'initial' || kind === 'background'
        const acceptance = homeSnapshot ? assessSnapshot(page) : 'ACCEPTED'
        if (homeSnapshot) {
          state.snapshotAcceptance = acceptance
          if (acceptance === 'REGRESSED') {
            state.commitDurability = membershipAck(page)
            state.initialError = kind === 'initial' && !hasAcceptedBaseline
            markPerformanceEvent('comments-snapshot-regressed', {
              snapshotRevision: page.snapshotRevision ?? '',
              highWatermark: lastAcceptedSnapshotRevision ?? '',
              hasBaseline: hasAcceptedBaseline,
            })
            return
          }
        }
        if (kind === 'initial' || kind === 'replacement')
          state.initialError = false
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
        const oldestIncoming = visiblePageItems.at(-1)
        const retainedOlderItems =
          replace && preserveExistingOlder && page.hasMore && oldestIncoming
            ? state.items.filter(
                (item) =>
                  compareComments(item, oldestIncoming) > 0 &&
                  !visiblePageItems.some((incoming) => incoming.id === item.id),
              )
            : []
        const preserveHomePagination = retainedOlderItems.length > 0
        const prospectiveCacheItems = [
          ...visiblePageItems,
          ...retainedOlderItems.filter((item) => !localJournal.has(item.id)),
        ].sort(compareComments)
        const durability = homeSnapshot
          ? prepareAcceptedSnapshot(
              page,
              prospectiveCacheItems,
              preserveHomePagination ? homeCacheHasMore : page.hasMore,
              preserveHomePagination
                ? homeCacheNextCursor
                : (page.nextCursor ?? null),
            )
          : 'DURABLE'
        if (homeSnapshot) {
          state.commitDurability = durability
          hasAcceptedBaseline = true
          homeSnapshotRevision = page.snapshotRevision
          if (page.todayCount !== undefined) {
            todayCountDate = shanghaiDate()
            state.todayCount = page.todayCount
            todayCountFresh = true
          }
        }
        if (replace) {
          if (homeSnapshot && durability === 'EPHEMERAL') {
            merge(visiblePageItems, origin)
          } else {
            const result = reconcileComments(state.items, visiblePageItems, {
              preserveMissing:
                homeSnapshot && homeView
                  ? canPreserveLocallyConfirmed
                  : undefined,
            })
            state.items = [...result.items, ...retainedOlderItems].sort(
              compareComments,
            )
            for (const id of result.newIds) queueAnimation(id, origin)
          }
        } else merge(visiblePageItems, origin)
        merge(insertedDuringRequest, 'created')
        for (const [id, like] of protectedLikes) {
          const current = state.items.find((item) => item.id === id)
          if (current) Object.assign(current, like)
        }
        if (kind === 'initial' || kind === 'background') {
          markPerformanceEvent('comments-state-committed', {
            count: state.items.length,
            source: origin,
            acceptance,
            durability,
          })
        }
        for (const item of visiblePageItems) insertedVersions.delete(item.id)
        if (kind === 'initial' || kind === 'background') {
          // 首次加载请求的就是最新一页:已到最新端,避免无谓的 loadNewer
          state.reachedNewest = true
          if (!preserveHomePagination) {
            homeCacheHasMore = page.hasMore
            homeCacheNextCursor = page.nextCursor ?? null
          }
          state.reachedOldest = !homeCacheHasMore
          nextOlderCursor = homeCacheNextCursor
        }
        if (kind === 'newer') {
          state.reachedNewest = !page.hasMore
          nextNewerCursor = page.hasMore
            ? (page.nextCursor ?? page.items[0]?.id ?? null)
            : null
        }
        if (kind === 'older') {
          state.reachedOldest = !page.hasMore
          nextOlderCursor = page.hasMore
            ? (page.nextCursor ?? page.items.at(-1)?.id ?? null)
            : null
          if (homeView) {
            homeCacheHasMore = page.hasMore
            homeCacheNextCursor = nextOlderCursor
            persistHomeCache()
          }
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
        if (
          requestGeneration === generation &&
          (kind === 'initial' || kind === 'background')
        ) {
          state.snapshotAcceptance = 'FAILED'
          state.commitDurability = null
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
    todayCountFresh = true
    if (homeView) persistHomeCache()
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
      if (homeView) persistHomeCache()
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
      persistHomeCache()
    }
    void refreshTodayCount()
  }

  function initialize(): Promise<void> {
    homeView = true
    const cacheUsed = hydrateHomeCache()
    if (hasAcceptedBaseline && !state.initialError) {
      return (
        pending.get('initial') ??
        pending.get('replacement') ??
        (cacheUsed ? loadInitialAfterCache() : Promise.resolve())
      )
    }
    if (state.loadingInitial) return pending.get('initial') ?? Promise.resolve()
    return load('initial', { count: 10 }, true, resolveInitialPage()).then(
      () => {
        if (!todayCountFresh) void refreshTodayCount()
      },
    )
  }

  function loadInitialAfterCache(): Promise<void> {
    return load(
      'initial',
      { count: 10 },
      true,
      resolveInitialPage(),
      true,
    ).then(() => {
      if (!todayCountFresh) void refreshTodayCount()
    })
  }

  async function resolveInitialPage(): Promise<CommentPage | null> {
    const supportsSplitRequests = Boolean(
      api.requestFastInitial && api.requestCanonicalInitial,
    )
    if (!supportsSplitRequests) return loadInitialComments(api)
    let fallbackUsed = false
    const canonical = (): Promise<CommentPage> => {
      if (fallbackUsed) throw new Error('canonical fallback already used')
      fallbackUsed = true
      return loadCanonicalInitialComments(api)
    }
    let fast: CommentPage
    try {
      fast = await loadInitialComments(api)
    } catch (error) {
      state.snapshotAcceptance = 'FAILED'
      state.commitDurability = null
      markPerformanceEvent('comments-fast-failed', {})
      return canonical().catch((canonicalError: unknown) => {
        state.snapshotAcceptance = 'FAILED'
        state.commitDurability = null
        throw canonicalError ?? error
      })
    }
    if (assessSnapshot(fast) === 'ACCEPTED') return fast

    state.snapshotAcceptance = 'REGRESSED'
    state.commitDurability = membershipAck(fast)
    if (!hasAcceptedBaseline) return canonical()

    const background = canonical()
    void load('background', { count: 10 }, true, background, true).catch(() => {
      state.snapshotAcceptance = 'FAILED'
      state.commitDurability = null
    })
    return null
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

  async function refreshAfterAuthentication(): Promise<void> {
    if (!homeView) {
      await hydrateViewerLikes()
      return
    }
    try {
      await refreshIncrementally()
    } catch (error) {
      await hydrateViewerLikes()
      throw error
    }
    await hydrateViewerLikes()
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
    const confirmedAt = Date.now()
    localJournal.set(comment.id, {
      id: comment.id,
      comment: { ...comment, liked: false },
      confirmedAt,
      state: 'PENDING_LOCAL',
      verificationAttempts: 0,
      nextVerifyAt: confirmedAt + HOME_COMMENTS_CACHE_TTL,
      ...(Number.isSafeInteger(comment.visibleSinceRevision)
        ? { visibleSinceRevision: comment.visibleSinceRevision }
        : {}),
    })
    persistJournal()
    insertedVersions.set(comment.id, insertionVersion)
    merge([comment], 'created')
    state.reachedNewest = true
    state.initialError = false
    if (wasEmpty) state.currentVisibleTime = comment.time
    state.todayCount += 1
    scheduleVerification()
    void refreshTodayCount()
  }

  function scheduleVerification(): void {
    if (verificationTimer !== undefined) {
      clearTimeout(verificationTimer)
      verificationTimer = undefined
    }
    if (!api.verifyVisibility || localJournal.size === 0) return
    const now = Date.now()
    const nextAt = Math.min(
      ...[...localJournal.values()].map((entry) =>
        entry.state === 'PENDING_LOCAL'
          ? entry.confirmedAt + HOME_COMMENTS_CACHE_TTL
          : entry.nextVerifyAt,
      ),
    )
    verificationTimer = setTimeout(
      () => {
        verificationTimer = undefined
        void runVisibilityVerification()
      },
      Math.max(0, nextAt - now),
    )
  }

  function deferVerification(
    entry: LocalCommentJournalEntry,
    now: number,
  ): void {
    const delay = commentVerificationBackoff(entry.verificationAttempts)
    entry.verificationAttempts += 1
    entry.nextVerifyAt = now + delay
  }

  async function runVisibilityVerification(): Promise<void> {
    if (!api.verifyVisibility) return
    const now = Date.now()
    let transitioned = false
    for (const entry of localJournal.values()) {
      if (
        entry.state === 'PENDING_LOCAL' &&
        now - entry.confirmedAt >= HOME_COMMENTS_CACHE_TTL
      ) {
        entry.state = 'VERIFY_REQUIRED'
        entry.nextVerifyAt = now
        transitioned = true
      }
    }
    if (transitioned) persistJournal()
    const due = [...localJournal.values()]
      .filter(
        (entry) =>
          entry.state === 'VERIFY_REQUIRED' && entry.nextVerifyAt <= now,
      )
      .slice(0, 10)
    if (due.length === 0) {
      scheduleVerification()
      return
    }
    let results = new Map<number, 'visible' | 'not_visible' | 'indeterminate'>()
    try {
      results = new Map(
        (await api.verifyVisibility(due.map((entry) => entry.id))).map(
          (result) => [result.id, result.state],
        ),
      )
    } catch {
      // A failed verification is indeterminate by design.
    }
    const terminal: LocalCommentJournalEntry[] = []
    const completedAt = Date.now()
    for (const entry of due) {
      if (results.get(entry.id) === 'not_visible') {
        terminal.push(entry)
        localJournal.delete(entry.id)
      } else {
        deferVerification(entry, completedAt)
      }
    }
    const durable = persistJournal()
    if (durable) {
      const terminalIds = new Set(terminal.map((entry) => entry.id))
      if (terminalIds.size > 0) {
        state.items = state.items.filter((item) => !terminalIds.has(item.id))
      }
    } else {
      for (const entry of terminal) localJournal.set(entry.id, entry)
    }
    scheduleVerification()
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

  function returnToLatest(): Promise<void> {
    resetForReplacement()
    homeView = true
    return load('initial', { count: 10 }, true).then(() => {
      if (!todayCountFresh) void refreshTodayCount()
    })
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
    refreshAfterAuthentication,
    refreshIncrementally,
    refreshTodayCount,
    returnToLatest,
    setCurrentVisibleTime,
    state: readonly(state),
    toggleLike,
  }
}

export const commentsStore = createCommentsStore(commentsApi)
