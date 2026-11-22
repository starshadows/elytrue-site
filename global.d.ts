declare global {
  interface Window {
    wallpaperPropertyListener?: {
      applyUserProperties(properties: {
        ui_scale?: { value: number }
        ui_volume?: { value: number }
      }): void
    }
    __ELY_VISIT_ASSETS__?: {
      readonly backgroundByLayout: Record<
        'landscape' | 'portrait',
        {
          readonly id: string
          readonly layout: 'landscape' | 'portrait'
          readonly preview: string
          readonly focus: string
        }
      >
    }
  }
}

export {}
