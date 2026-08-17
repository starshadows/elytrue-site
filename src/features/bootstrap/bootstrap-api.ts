import type { UserProfile } from '../auth/auth-store'
import { parseCommentPage, type CommentPage } from '../comments/comment-types'
import { markPerformanceEvent } from '../../lib/performance'
import XHR from '../../net/xhr'

export interface BootstrapResponse {
  profile: UserProfile | null
  csrfToken?: string
  comments: CommentPage | null
  commentsError?: boolean
  todayCount: number | null
}

export type BootstrapSection =
  'profile' | 'csrfToken' | 'comments' | 'todayCount'

export class BootstrapProtocolError extends Error {
  readonly sections: ReadonlySet<BootstrapSection>

  constructor(sections: Iterable<BootstrapSection>) {
    super('应用初始化响应协议错误')
    this.name = 'BootstrapProtocolError'
    this.sections = new Set(sections)
  }
}

export interface ParsedBootstrapResponse {
  response: BootstrapResponse
  protocolError: BootstrapProtocolError | null
  viewerLikesComplete: boolean
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function parseProfile(value: unknown): UserProfile | null {
  if (value === null) return null
  if (!isObject(value)) throw new Error('用户资料无效')
  const id = Reflect.get(value, 'id')
  const uid = Reflect.get(value, 'uid')
  const name = Reflect.get(value, 'name')
  const avatar = Reflect.get(value, 'avatar')
  if (
    typeof id !== 'string' ||
    !id ||
    typeof uid !== 'number' ||
    !Number.isSafeInteger(uid) ||
    uid < 1 ||
    typeof name !== 'string' ||
    typeof avatar !== 'string'
  ) {
    throw new Error('用户资料字段无效')
  }
  const email = Reflect.get(value, 'email')
  const hasEmail = Reflect.get(value, 'hasEmail')
  const hasRecoveryKey = Reflect.get(value, 'hasRecoveryKey')
  const role = Reflect.get(value, 'role')
  const createTime = Reflect.get(value, 'create_time')
  if (
    (email !== undefined && typeof email !== 'string') ||
    (hasEmail !== undefined && typeof hasEmail !== 'boolean') ||
    (hasRecoveryKey !== undefined && typeof hasRecoveryKey !== 'boolean') ||
    (role !== undefined && role !== 'admin' && role !== 'user') ||
    (createTime !== undefined &&
      (typeof createTime !== 'number' || !Number.isFinite(createTime)))
  ) {
    throw new Error('用户资料可选字段无效')
  }
  return {
    id,
    uid,
    name,
    avatar,
    ...(email === undefined ? {} : { email }),
    ...(hasEmail === undefined ? {} : { hasEmail }),
    ...(hasRecoveryKey === undefined ? {} : { hasRecoveryKey }),
    ...(role === undefined ? {} : { role }),
    ...(createTime === undefined ? {} : { create_time: createTime }),
  }
}

function normalizeMissingLiked(value: unknown): {
  value: unknown
  viewerLikesComplete: boolean
} {
  const page = isObject(value) ? value : null
  const records = Array.isArray(value)
    ? value
    : page && Array.isArray(Reflect.get(page, 'items'))
      ? (Reflect.get(page, 'items') as unknown[])
      : null
  if (!records) return { value, viewerLikesComplete: true }
  let viewerLikesComplete = true
  const normalized = records.map((record) => {
    if (!isObject(record) || Reflect.get(record, 'liked') !== undefined)
      return record
    viewerLikesComplete = false
    return { ...record, liked: false }
  })
  if (Array.isArray(value)) return { value: normalized, viewerLikesComplete }
  return {
    value: { ...page, items: normalized },
    viewerLikesComplete,
  }
}

export function inspectBootstrapResponse(
  value: unknown,
): ParsedBootstrapResponse {
  if (!isObject(value)) {
    throw new BootstrapProtocolError([
      'profile',
      'csrfToken',
      'comments',
      'todayCount',
    ])
  }

  const errors = new Set<BootstrapSection>()
  let profile: UserProfile | null = null
  try {
    if (!Reflect.has(value, 'profile')) throw new Error('缺少用户资料')
    profile = parseProfile(Reflect.get(value, 'profile'))
  } catch {
    errors.add('profile')
  }

  const csrfValue = Reflect.get(value, 'csrfToken')
  const csrfToken = typeof csrfValue === 'string' ? csrfValue : undefined
  if (csrfValue !== undefined && typeof csrfValue !== 'string') {
    errors.add('csrfToken')
  }

  let comments: CommentPage | null = null
  let viewerLikesComplete = true
  const commentsErrorValue = Reflect.get(value, 'commentsError')
  const commentsError = commentsErrorValue === true
  if (
    commentsErrorValue !== undefined &&
    typeof commentsErrorValue !== 'boolean'
  ) {
    errors.add('comments')
  }
  try {
    if (!Reflect.has(value, 'comments')) throw new Error('缺少留言')
    const commentsValue = Reflect.get(value, 'comments')
    if (commentsValue !== null) {
      const normalized = normalizeMissingLiked(commentsValue)
      comments = parseCommentPage(normalized.value)
      viewerLikesComplete = normalized.viewerLikesComplete
    }
    if (comments === null && !commentsError) throw new Error('留言错误标记缺失')
  } catch {
    comments = null
    errors.add('comments')
  }

  let todayCount: number | null = null
  const todayCountValue = Reflect.get(value, 'todayCount')
  if (
    todayCountValue === null ||
    (Number.isSafeInteger(todayCountValue) && Number(todayCountValue) >= 0)
  ) {
    todayCount = todayCountValue as number | null
  } else errors.add('todayCount')

  return {
    response: {
      profile,
      ...(csrfToken === undefined ? {} : { csrfToken }),
      comments,
      ...(commentsError ? { commentsError: true } : {}),
      todayCount,
    },
    protocolError: errors.size ? new BootstrapProtocolError(errors) : null,
    viewerLikesComplete,
  }
}

export function parseBootstrapResponse(value: unknown): BootstrapResponse {
  const parsed = inspectBootstrapResponse(value)
  if (parsed.protocolError) throw parsed.protocolError
  return parsed.response
}

export async function loadBootstrap(): Promise<ParsedBootstrapResponse> {
  markPerformanceEvent('bootstrap-request-start')
  const parsed = inspectBootstrapResponse(
    await XHR.get<unknown>('bootstrap', undefined, { updateCsrfToken: false }),
  )
  markPerformanceEvent('bootstrap-response', {
    authenticated: Boolean(parsed.response.profile),
    comments: parsed.response.comments?.items.length ?? 0,
  })
  return parsed
}
