import type { LocalizedText } from './site'

export type BackgroundLayout = 'landscape' | 'portrait'

export interface BackgroundAsset {
  readonly id: `${BackgroundLayout}${number}`
  readonly layout: BackgroundLayout
  readonly preview: `/assets/${string}.webp`
  readonly original: `/assets/${string}.${'jpg' | 'png'}`
  readonly focus: `${number}% ${number}%`
  readonly credit: LocalizedText
  readonly creditUrl?: `https://${string}`
}

const ASSET_ROOT = '/assets/elytrue-20260724'

function background(
  layout: BackgroundLayout,
  number: number,
  extension: 'jpg' | 'png',
  focus: `${number}% ${number}%`,
  artist?: string,
  creditUrl?: `https://${string}`,
): BackgroundAsset {
  return {
    id: `${layout}${number}`,
    layout,
    preview: `${ASSET_ROOT}/bg/${layout}${number}.webp`,
    original: `${ASSET_ROOT}/originals/${layout}${number}.${extension}`,
    focus,
    credit: artist
      ? { zh: `画师：${artist}`, en: `Illustrator: ${artist}` }
      : { zh: '官方美术', en: 'Official art' },
    ...(creditUrl ? { creditUrl } : {}),
  }
}

const illustratorUrls = {
  nami: 'https://www.pixiv.net/users/89748593',
  roena: 'https://www.pixiv.net/users/35132995',
  hewuyang: 'https://www.pixiv.net/users/56022318',
  miaogujun: 'https://www.pixiv.net/users/58434088',
} as const

export const BACKGROUNDS = [
  background('landscape', 1, 'jpg', '50% 50%'),
  background('landscape', 2, 'png', '38% 50%'),
  background(
    'landscape',
    3,
    'png',
    '55% 50%',
    '合悟昂',
    illustratorUrls.hewuyang,
  ),
  background(
    'landscape',
    4,
    'png',
    '55% 50%',
    '合悟昂',
    illustratorUrls.hewuyang,
  ),
  background(
    'landscape',
    5,
    'png',
    '52% 50%',
    '喵咕君QAQ(KH3)',
    illustratorUrls.miaogujun,
  ),
  background(
    'landscape',
    6,
    'jpg',
    '35% 50%',
    '喵咕君QAQ(KH3)',
    illustratorUrls.miaogujun,
  ),
  background(
    'landscape',
    7,
    'jpg',
    '43% 50%',
    '喵咕君QAQ(KH3)',
    illustratorUrls.miaogujun,
  ),
  background('portrait', 1, 'jpg', '50% 50%', 'nami', illustratorUrls.nami),
  background('portrait', 2, 'png', '50% 50%', 'nami', illustratorUrls.nami),
  background('portrait', 3, 'png', '50% 50%', 'roena', illustratorUrls.roena),
  background(
    'portrait',
    4,
    'png',
    '50% 50%',
    '合悟昂',
    illustratorUrls.hewuyang,
  ),
  background(
    'portrait',
    5,
    'png',
    '50% 50%',
    '合悟昂',
    illustratorUrls.hewuyang,
  ),
  background(
    'portrait',
    6,
    'jpg',
    '50% 50%',
    '喵咕君QAQ(KH3)',
    illustratorUrls.miaogujun,
  ),
  background(
    'portrait',
    7,
    'jpg',
    '50% 50%',
    '喵咕君QAQ(KH3)',
    illustratorUrls.miaogujun,
  ),
  background(
    'portrait',
    8,
    'jpg',
    '50% 50%',
    '喵咕君QAQ(KH3)',
    illustratorUrls.miaogujun,
  ),
  background(
    'portrait',
    9,
    'jpg',
    '50% 50%',
    '喵咕君QAQ(KH3)',
    illustratorUrls.miaogujun,
  ),
] as const satisfies readonly BackgroundAsset[]

export const BACKGROUND_GROUPS = [
  {
    layout: 'landscape',
    title: { zh: '横屏背景', en: 'Landscape backgrounds' },
  },
  {
    layout: 'portrait',
    title: { zh: '竖屏背景', en: 'Portrait backgrounds' },
  },
] as const

export const OFFICIAL_MUSIC = [
  '黄龄 HOYO-MiX - TruE.mp3',
  'HOYO-MiX - Conflict.mp3',
  'HOYO-MiX - Elysia.mp3',
  'HOYO-MiX - Elysian Realm.mp3',
  'HOYO-MiX - Erupt.mp3',
  'HOYO-MiX - ForEly.mp3',
  'HOYO-MiX - Last Waltz.mp3',
  'HOYO-MiX - Subtle.mp3',
  'HOYO-MiX - Sweet Trap.mp3',
  'HOYO-MiX - The Flawless Human.mp3',
] as const

export const DEFAULT_MUSIC = 'HOYO-MiX - Elysian Realm.mp3'
export const MUSIC_ROOT = `${ASSET_ROOT}/bgm/`

export function applyBackgroundMetadata(): void {
  const elements = document.querySelectorAll<HTMLElement>(
    '.mainbg[data-layout]',
  )
  if (elements.length !== BACKGROUNDS.length) {
    throw new Error(
      `Background DOM/config mismatch: ${elements.length}/${BACKGROUNDS.length}`,
    )
  }

  elements.forEach((element, index) => {
    const asset = BACKGROUNDS[index]
    if (!asset) return
    element.dataset.backgroundId = asset.id
    element.dataset.layout = asset.layout
    element.dataset.src = asset.preview.slice(1)
    element.dataset.original = asset.original.slice(1)
    if (asset.creditUrl) element.dataset.creditUrl = asset.creditUrl
    else delete element.dataset.creditUrl
    const artwork = element.firstElementChild
    if (artwork instanceof HTMLElement) {
      artwork.style.backgroundPosition = asset.focus
    }
    const caption = element.children.item(1)
    if (caption instanceof HTMLElement) {
      const zh = document.createElement('span')
      zh.className = 'ui zh'
      zh.textContent = asset.credit.zh
      const en = document.createElement('span')
      en.className = 'ui en'
      en.textContent = asset.credit.en
      caption.replaceChildren(zh, en)
    }
  })
}
