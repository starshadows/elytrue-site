declare global {
  interface Window {
    wallpaperPropertyListener?: {
      applyUserProperties(properties: {
        ui_bottom?: { value: number }
        ui_scale?: { value: number }
        ui_volume?: { value: number }
      }): void
    }
  }

  interface Navigator {
    standalone?: boolean
  }
}

export {}
