export function createViewLifecycle() {
  let active = true

  return {
    dispose(): void {
      active = false
    },
    isActive(): boolean {
      return active
    },
  }
}
