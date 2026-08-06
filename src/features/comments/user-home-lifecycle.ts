export function createViewLifecycle() {
  let active = true
  const controller = new AbortController()

  return {
    dispose(): void {
      active = false
      controller.abort()
    },
    isActive(): boolean {
      return active
    },
    signal: controller.signal,
  }
}
