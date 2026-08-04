const enabled = Boolean(import.meta.env?.DEV && globalThis.performance)

export function startPerformanceMark(name: string): void {
  if (!enabled) return
  performance.mark(`${name}:start`)
}

export function finishPerformanceMark(name: string): void {
  if (!enabled) return
  const start = `${name}:start`
  const end = `${name}:end`
  performance.mark(end)
  try {
    performance.measure(name, start, end)
  } catch {
    return
  } finally {
    performance.clearMarks(start)
    performance.clearMarks(end)
  }
}
