import {
  ASSET_ROOT,
  BACKGROUNDS,
  IMAGE_THEMES,
  VIDEO_THEMES,
  type BackgroundAsset,
} from './background-manifest'

export * from './background-manifest'

export interface DownloadableImage {
  readonly id: string
  readonly layout: 'landscape' | 'portrait'
  readonly preview: `/assets/${string}.webp`
  readonly original: `/assets/${string}.${'jpg' | 'png'}`
  readonly credit: BackgroundAsset['credit']
  readonly creditUrl?: BackgroundAsset['creditUrl']
}

export interface DownloadImageGroup {
  readonly id: string
  readonly title: { readonly zh: string; readonly en: string }
  readonly images: readonly DownloadableImage[]
}

const seenOriginals = new Set<string>()

function uniqueBackgrounds(
  items: readonly BackgroundAsset[],
): BackgroundAsset[] {
  return items.filter((item) => {
    if (seenOriginals.has(item.original)) return false
    seenOriginals.add(item.original)
    return true
  })
}

export const DOWNLOAD_IMAGE_GROUPS: readonly DownloadImageGroup[] = [
  {
    id: 'landscape',
    title: { zh: '横屏背景', en: 'Landscape backgrounds' },
    images: [
      ...uniqueBackgrounds(
        IMAGE_THEMES.flatMap((theme) => theme.backgrounds).filter(
          (background) => background.layout === 'landscape',
        ),
      ),
      ...VIDEO_THEMES.map((theme) => ({
        id: `${theme.id}-poster`,
        layout: 'landscape' as const,
        preview: theme.cardPreview,
        original: theme.posterOriginal,
        credit: { zh: '官方美术', en: 'Official art' },
      })).filter((item) => {
        if (seenOriginals.has(item.original)) return false
        seenOriginals.add(item.original)
        return true
      }),
    ],
  },
  {
    id: 'portrait',
    title: { zh: '竖屏背景', en: 'Portrait backgrounds' },
    images: uniqueBackgrounds(
      IMAGE_THEMES.flatMap((theme) => theme.backgrounds).filter(
        (background) => background.layout === 'portrait',
      ),
    ),
  },
]

export interface MusicTrack {
  readonly file: `${string}.mp3`
  readonly title: string
}

export const MUSIC_TRACKS = [
  { file: '黄龄 HOYO-MiX - TruE.mp3', title: 'TruE' },
  { file: 'HOYO-MiX - Conflict.mp3', title: 'Conflict' },
  { file: 'HOYO-MiX - Elysia.mp3', title: 'Elysia' },
  { file: 'HOYO-MiX - Elysian Realm.mp3', title: 'Elysian Realm' },
  { file: 'HOYO-MiX - Erupt.mp3', title: 'Erupt' },
  { file: 'HOYO-MiX - ForEly.mp3', title: 'ForEly' },
  { file: 'HOYO-MiX - Last Waltz.mp3', title: 'Last Waltz' },
  { file: 'HOYO-MiX - Subtle.mp3', title: 'Subtle' },
  { file: 'HOYO-MiX - Sweet Trap.mp3', title: 'Sweet Trap' },
  {
    file: 'HOYO-MiX - The Flawless Human.mp3',
    title: 'The Flawless Human',
  },
  {
    file: 'miss-elf-magical-invitation.mp3',
    title: "妖精小姐的魔法邀约 Miss Elf's Magical Invitation",
  },
] as const

export const OFFICIAL_MUSIC = MUSIC_TRACKS.map((track) => track.file)
export const MUSIC_DISPLAY_TITLES: Readonly<Record<string, string>> =
  Object.fromEntries(MUSIC_TRACKS.map((track) => [track.file, track.title]))

export const DEFAULT_MUSIC = 'HOYO-MiX - Elysian Realm.mp3'
export const MUSIC_ROOT = `${ASSET_ROOT}/bgm/`

export { BACKGROUNDS }
