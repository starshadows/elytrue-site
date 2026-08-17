import { hydrateAuth, loadAuthFallback } from '../auth/auth-actions'
import type {
  AuthHydration,
  AuthHydrationSource,
  UserProfile,
} from '../auth/auth-store'
import { commentsApi } from '../comments/comments-api'
import {
  commentsStore,
  type BootstrapCommentHydrationSource,
} from '../comments/comments-store'
import type { CommentPage } from '../comments/comment-types'
import { markPerformanceEvent } from '../../lib/performance'
import { loadBootstrap, type ParsedBootstrapResponse } from './bootstrap-api'

interface BootstrapControllerDependencies {
  loadBootstrap(): Promise<ParsedBootstrapResponse>
  loadProfile(): Promise<UserProfile | null | AuthHydration>
  loadComments(): Promise<CommentPage>
  loadTodayCount(): Promise<number>
  hydrateAuth(hydration: AuthHydrationSource): Promise<UserProfile | null>
  hydrateComments(hydration: BootstrapCommentHydrationSource): Promise<boolean>
  hydrateViewerLikes(): Promise<void>
  onProtocolError?(error: Error): void
}

export interface BootstrapController {
  start(): Promise<void>
}

export function createBootstrapController(
  dependencies: BootstrapControllerDependencies,
): BootstrapController {
  let startup: Promise<void> | null = null

  async function loadProfileFallback(): Promise<AuthHydration> {
    const fallback = await dependencies.loadProfile()
    return fallback && typeof fallback === 'object' && 'profile' in fallback
      ? fallback
      : { profile: fallback }
  }

  function start(): Promise<void> {
    if (startup) return startup

    const bootstrapRequest = dependencies.loadBootstrap()
    const profileHydration = async (
      isCurrent: () => boolean,
    ): Promise<AuthHydration> => {
      let parsed: ParsedBootstrapResponse
      try {
        parsed = await bootstrapRequest
      } catch (error) {
        if (!isCurrent()) throw error
        return loadProfileFallback()
      }
      if (parsed.protocolError) {
        dependencies.onProtocolError?.(parsed.protocolError)
      }
      if (
        parsed.protocolError?.sections.has('profile') ||
        parsed.protocolError?.sections.has('csrfToken')
      ) {
        if (!isCurrent()) throw new Error('初始化认证响应已过期')
        return loadProfileFallback()
      }
      return {
        profile: parsed.response.profile,
        ...(parsed.response.csrfToken === undefined
          ? {}
          : { csrfToken: parsed.response.csrfToken }),
      }
    }

    async function finishCommentsHydration(
      pageRequest: Promise<CommentPage>,
      todayCount: number | null,
      viewerLikesComplete: boolean,
      todayCountRequest?: Promise<number | null>,
    ) {
      const page = await pageRequest
      return {
        page: todayCount === null ? page : { ...page, todayCount },
        ...(todayCountRequest ? { todayCountRequest } : {}),
        todayCountResolved: true,
        viewerLikesComplete,
      }
    }

    const commentsHydration = async (isCurrent: () => boolean) => {
      let parsed: ParsedBootstrapResponse
      try {
        parsed = await bootstrapRequest
      } catch (error) {
        if (!isCurrent()) throw error
        return finishCommentsHydration(
          dependencies.loadComments(),
          null,
          false,
          dependencies.loadTodayCount().catch(() => null),
        )
      }
      const commentsNeedFallback =
        parsed.response.commentsError === true ||
        parsed.response.comments === null ||
        parsed.protocolError?.sections.has('comments') === true
      const countNeedsFallback =
        parsed.response.todayCount === null ||
        parsed.protocolError?.sections.has('todayCount') === true
      if ((commentsNeedFallback || countNeedsFallback) && !isCurrent()) {
        throw new Error('初始化留言响应已过期')
      }
      return finishCommentsHydration(
        commentsNeedFallback
          ? dependencies.loadComments()
          : Promise.resolve(parsed.response.comments!),
        parsed.response.todayCount,
        !commentsNeedFallback && parsed.viewerLikesComplete,
        countNeedsFallback
          ? dependencies.loadTodayCount().catch(() => null)
          : undefined,
      )
    }

    const profileRequest = dependencies
      .hydrateAuth(profileHydration)
      .then((profile) => {
        markPerformanceEvent('auth-hydrated', {
          authenticated: Boolean(profile),
        })
        return profile
      })
    const commentsRequest = dependencies
      .hydrateComments(commentsHydration)
      .then((viewerLikesComplete) => {
        markPerformanceEvent('comments-hydrated', { viewerLikesComplete })
        return viewerLikesComplete
      })
    startup = Promise.allSettled([profileRequest, commentsRequest]).then(
      async ([profileResult, commentsResult]) => {
        if (
          profileResult.status === 'fulfilled' &&
          profileResult.value &&
          commentsResult.status === 'fulfilled' &&
          !commentsResult.value
        ) {
          await dependencies.hydrateViewerLikes().catch(() => undefined)
        }
      },
    )
    return startup
  }

  return { start }
}

const appBootstrapController = createBootstrapController({
  loadBootstrap,
  loadProfile: loadAuthFallback,
  loadComments: () =>
    commentsApi.listInitial?.() ?? commentsApi.list({ count: 10 }),
  loadTodayCount: () => commentsApi.getCount(),
  hydrateAuth,
  hydrateComments: (hydration) => commentsStore.hydrateBootstrap(hydration),
  hydrateViewerLikes: () => commentsStore.hydrateViewerLikes(),
  onProtocolError: (error) => console.error('应用初始化响应协议错误', error),
})

export function startAppBootstrap(): Promise<void> {
  return appBootstrapController.start()
}
