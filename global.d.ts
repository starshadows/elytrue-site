declare global {
  interface Window {
    wallpaperPropertyListener?: {
      applyUserProperties(properties: {
        ui_bottom?: { value: number }
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
      readonly commentBackgrounds: readonly string[]
    }
    __ELY_EARLY_COMMENTS__?: Promise<{
      readonly ok: boolean
      readonly status: number
      readonly statusText: string
      readonly contentType: string
      readonly body: string
      readonly serverTiming?: string
      readonly cacheStatus?: string
      readonly age?: string
      readonly functionRequestId?: string
      readonly error?: unknown
    }>
  }

  interface Navigator {
    standalone?: boolean
  }
}

export {}
