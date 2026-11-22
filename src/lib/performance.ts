const enabled = Boolean(
  globalThis.performance &&
  ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ||
    globalThis.navigator?.webdriver === true),
)

export function markPerformanceEvent(
  name: string,
  detail?: Record<string, unknown>,
): void {
  if (!enabled) return
  performance.mark(name, detail ? { detail } : undefined)
}
