import type { UserProfile } from './auth/auth-store'
import XHR from '../net/xhr'

interface BootstrapResponse {
  profile: UserProfile | null
  comments: unknown
  commentsError?: boolean
  csrfToken?: string
  todayCount?: unknown
}

export interface BootstrapData {
  profile: UserProfile | null
  comments: unknown
  commentsError: boolean
  todayCount?: number
}

let bootstrapRequest: Promise<BootstrapData> | null = null

export function loadBootstrap(): Promise<BootstrapData> {
  bootstrapRequest ??= XHR.get<BootstrapResponse>('bootstrap')
    .then((data) => ({
      profile: data.profile,
      comments: data.comments,
      commentsError: data.commentsError === true,
      ...(typeof data.todayCount === 'number'
        ? { todayCount: data.todayCount }
        : {}),
    }))
    .catch((error: unknown) => {
      bootstrapRequest = null
      throw error
    })
  return bootstrapRequest
}
