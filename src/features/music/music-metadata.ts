export interface MusicArtwork {
  readonly type: string
  readonly data: Uint8Array
}

export interface MusicMetadata {
  readonly title?: string
  readonly artist?: string
  readonly album?: string
  readonly artwork?: MusicArtwork
}

interface MediaTagPicture {
  readonly format?: string
  readonly data?: ArrayLike<number>
}

interface MediaTagResult {
  readonly tags?: {
    readonly title?: string
    readonly artist?: string
    readonly album?: string
    readonly picture?: MediaTagPicture
  }
}

interface MediaTagsModule {
  readonly Config: {
    EXPERIMENTAL_avoidHeadRequests(): void
    setXhrTimeoutInSec(seconds: number): void
  }
  readonly Reader: new (location: string | Blob) => {
    setTagsToRead(tags: string[]): {
      read(callbacks: {
        onSuccess(result: MediaTagResult): void
        onError(error: unknown): void
      }): void
    }
  }
}

export type MusicMetadataErrorStage = 'import' | 'read' | 'normalize'

export class MusicMetadataReadError extends Error {
  readonly stage: MusicMetadataErrorStage
  readonly source: string
  readonly reader: string
  readonly requestMode: string
  readonly detail: unknown

  constructor(
    stage: MusicMetadataErrorStage,
    source: string | Blob,
    detail: unknown,
  ) {
    const reader = metadataReaderFor(source)
    super(`Music metadata ${stage} failed (${reader})`)
    this.name = 'MusicMetadataReadError'
    this.stage = stage
    this.source = sourceLabel(source)
    this.reader = reader
    this.requestMode = requestModeFor(source)
    this.detail = detail
  }
}

export interface MusicMetadataDiagnostic {
  readonly song: string
  readonly reader: string
  readonly requestMode: string
  readonly stage: string
  readonly attempt?: number
  readonly pictureFormat?: string
  readonly pictureBytes?: number
  readonly error?: unknown
}

const metadataRequests = new Map<string, Promise<MusicMetadata | null>>()
const metadataResults = new Map<string, MusicMetadata>()
let mediaTagsModule: Promise<MediaTagsModule> | undefined

function sourceLabel(source: string | Blob): string {
  if (typeof source !== 'string') return `Blob(${source.size})`
  try {
    const parsed = new URL(
      source,
      typeof document === 'undefined' ? 'file:///' : document.baseURI,
    )
    return decodeURIComponent(
      parsed.pathname.slice(parsed.pathname.lastIndexOf('/') + 1),
    )
  } catch {
    return source.slice(source.lastIndexOf('/') + 1)
  }
}

function metadataReaderFor(source: string | Blob): string {
  if (typeof source !== 'string') return 'BlobFileReader'
  return /^[a-z]+:\/\//iu.test(source) ? 'XhrFileReader' : 'NodeFileReader'
}

function requestModeFor(source: string | Blob): string {
  return metadataReaderFor(source) === 'XhrFileReader'
    ? 'range-get (avoid-head)'
    : 'local'
}

function diagnosticsEnabled(): boolean {
  const environment = (import.meta as ImportMeta & { env?: { DEV?: boolean } })
    .env
  if (environment?.DEV || globalThis.navigator?.webdriver === true) return true
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).get('musicDebug') === '1'
}

function errorSummary(error: unknown): unknown {
  if (!error || typeof error !== 'object') return String(error)
  if (error instanceof MusicMetadataReadError) {
    return {
      name: error.name,
      message: error.message,
      stage: error.stage,
      detail: errorSummary(error.detail),
    }
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  const value = error as {
    readonly type?: unknown
    readonly info?: unknown
    readonly status?: unknown
    readonly xhr?: { readonly status?: unknown }
  }
  return {
    ...(value.type !== undefined ? { type: value.type } : {}),
    ...(value.info !== undefined ? { info: String(value.info) } : {}),
    ...(value.status !== undefined ? { status: value.status } : {}),
    ...(value.xhr?.status !== undefined
      ? { responseStatus: value.xhr.status }
      : {}),
  }
}

export function reportMusicMetadataDiagnostic(
  detail: MusicMetadataDiagnostic,
): void {
  if (!diagnosticsEnabled()) return
  const payload = {
    ...detail,
    ...(detail.error !== undefined
      ? { error: errorSummary(detail.error) }
      : {}),
  }
  if (detail.error !== undefined) console.warn('[music metadata]', payload)
  else console.debug('[music metadata]', payload)
}

async function loadMediaTags(): Promise<MediaTagsModule> {
  mediaTagsModule ??= import('jsmediatags/build2/jsmediatags.js')
    .then((module) => {
      const api = (module.default ?? module) as unknown as MediaTagsModule
      api.Config.EXPERIMENTAL_avoidHeadRequests()
      api.Config.setXhrTimeoutInSec(15)
      return api
    })
    .catch((error) => {
      mediaTagsModule = undefined
      throw error
    })
  return mediaTagsModule
}

function clean(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeArtwork(
  picture: MediaTagPicture | undefined,
): MusicArtwork | undefined {
  if (!picture?.data?.length) return undefined
  const rawType = clean(picture.format)
    ?.toLowerCase()
    .replace(/^image\//u, '')
  const type =
    rawType === undefined || rawType === 'jpg' || rawType === 'jpeg'
      ? 'image/jpeg'
      : rawType === 'png'
        ? 'image/png'
        : undefined
  if (!type) return undefined
  return { type, data: Uint8Array.from(picture.data) }
}

async function parseMusicMetadata(
  source: string | Blob,
): Promise<MusicMetadata | null> {
  const readableSource =
    typeof source === 'string' && typeof document !== 'undefined'
      ? new URL(source, document.baseURI).href
      : source
  let jsmediatags: MediaTagsModule
  try {
    jsmediatags = await loadMediaTags()
  } catch (error) {
    throw new MusicMetadataReadError('import', readableSource, error)
  }
  return new Promise((resolve, reject) => {
    try {
      new jsmediatags.Reader(readableSource)
        .setTagsToRead(['title', 'artist', 'album', 'picture'])
        .read({
          onSuccess(result) {
            try {
              const tags = result.tags ?? {}
              const artwork = normalizeArtwork(tags.picture)
              const metadata: MusicMetadata = {
                ...(clean(tags.title) ? { title: clean(tags.title) } : {}),
                ...(clean(tags.artist) ? { artist: clean(tags.artist) } : {}),
                ...(clean(tags.album) ? { album: clean(tags.album) } : {}),
                ...(artwork ? { artwork } : {}),
              }
              reportMusicMetadataDiagnostic({
                song: sourceLabel(readableSource),
                reader: metadataReaderFor(readableSource),
                requestMode: requestModeFor(readableSource),
                stage: artwork || !tags.picture ? 'read' : 'normalize',
                ...(tags.picture?.format
                  ? { pictureFormat: tags.picture.format }
                  : {}),
                ...(tags.picture?.data?.length
                  ? { pictureBytes: tags.picture.data.length }
                  : {}),
              })
              resolve(Object.keys(metadata).length ? metadata : null)
            } catch (error) {
              reject(
                new MusicMetadataReadError('normalize', readableSource, error),
              )
            }
          },
          onError(error) {
            reject(new MusicMetadataReadError('read', readableSource, error))
          },
        })
    } catch (error) {
      reject(new MusicMetadataReadError('read', readableSource, error))
    }
  })
}

export function readMusicMetadata(
  source: string,
): Promise<MusicMetadata | null> {
  const cached = metadataResults.get(source)
  if (cached) return Promise.resolve(cached)
  let request = metadataRequests.get(source)
  if (!request) {
    request = parseMusicMetadata(source)
      .then((metadata) => {
        if (metadata) metadataResults.set(source, metadata)
        return metadata
      })
      .catch((error) => {
        reportMusicMetadataDiagnostic({
          song: sourceLabel(source),
          reader:
            error instanceof MusicMetadataReadError
              ? error.reader
              : metadataReaderFor(source),
          requestMode:
            error instanceof MusicMetadataReadError
              ? error.requestMode
              : requestModeFor(source),
          stage: error instanceof MusicMetadataReadError ? error.stage : 'read',
          error,
        })
        throw error
      })
      .finally(() => {
        if (metadataRequests.get(source) === request)
          metadataRequests.delete(source)
      })
    metadataRequests.set(source, request)
  }
  return request
}

export function resetMusicMetadataCacheForTest(): void {
  metadataRequests.clear()
  metadataResults.clear()
}
