declare global {
  interface Window {
    wallpaperPropertyListener?: {
      applyUserProperties(
        properties: Record<string, { value: number } | undefined>,
      ): void
    }
  }

  interface Navigator {
    standalone?: boolean
  }
}

export {}
