export type RouteAuth = 'public'

export interface ApiRoute {
  methods: readonly string[]
  match: { kind: 'exact'; path: string }
  handler: string
  auth: RouteAuth
  csrf: false
}

export interface RequestContext {
  request: Request
  env?: Record<string, string | undefined>
}
