export type RouteAuth = 'public' | 'optional' | 'session' | 'admin'

export interface SessionRecord {
  userId: string
  csrfToken: string
  csrfHash: string
  version: number
  expiresAt: number
  lastSeenAt: number
}

export interface AuthenticatedUser {
  id: string
  name: string
  role?: 'admin' | 'user'
  sessionVersion: number
  avatarKey?: string
  [key: string]: unknown
}

export interface AuthContext {
  session: SessionRecord
  user: AuthenticatedUser
  tokenHash: string
  cookies: Record<string, string>
  refreshCookies: string[]
}

export interface ApiRoute {
  methods: string[]
  match: { kind: 'exact' | 'prefix'; path: string }
  handler: string
  auth: RouteAuth
  csrf: boolean
}

export interface BlobStore {
  get(key: string, options?: object): Promise<unknown>
  set(key: string, value: unknown, options?: object): Promise<void>
  setJSON(key: string, value: unknown, options?: object): Promise<void>
  delete(key: string): Promise<void>
  list(options?: object): Promise<{ blobs: Array<{ key: string }>; cursor?: string }>
}

export interface Stores {
  data: BlobStore
  uploads: BlobStore
}

export interface RequestContext {
  request: Request
  env?: Record<string, string | undefined>
  clientIp?: string
  commentTiming?: ServerTiming
  requestTiming?: ServerTiming
}

export interface ServerTiming {
  measure<T>(category: string, operation: () => Promise<T>): Promise<T>
  measureSync<T>(category: string, operation: () => T): T
  header(): string
}
