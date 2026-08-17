export type BackgroundLayout = 'landscape' | 'portrait'
export type ThemeAudience = 'desktop' | 'mobile'
export type ImageThemeId =
  | 'auto-landscape'
  | 'auto-portrait'
  | 'mainline'
  | 'summer'
  | 'youth'
  | 'birthday-desktop'
  | 'birthday-mobile'
  | 'for-elysia'
export type VideoThemeId =
  'story-because-of-you' | 'magical-invitation' | 'makeup-class'
export type ThemeSelectionId =
  | 'auto'
  | 'mainline'
  | 'summer'
  | 'youth'
  | 'birthday'
  | 'for-elysia'
  | VideoThemeId

export interface LocalizedText {
  readonly zh: string
  readonly en: string
}

export interface BackgroundAsset {
  readonly id: string
  readonly layout: BackgroundLayout
  readonly preview: `/assets/${string}.webp`
  readonly original: `/assets/${string}.${'jpg' | 'png'}`
  readonly focus: `${number}% ${number}%`
  readonly credit: LocalizedText
  readonly creditUrl?: `https://${string}`
}

export interface ImageTheme {
  readonly kind: 'image'
  readonly id: ImageThemeId
  readonly selection: Exclude<ThemeSelectionId, VideoThemeId>
  readonly audience: ThemeAudience
  readonly title: LocalizedText
  readonly cardTitle?: LocalizedText
  readonly cardPreview: `/assets/${string}.webp`
  readonly cardFocus?: `${number}% ${number}%`
  readonly backgrounds: readonly BackgroundAsset[]
  readonly automatic: boolean
  readonly showCaptions: boolean
}

export interface VideoTheme {
  readonly kind: 'video'
  readonly id: VideoThemeId
  readonly selection: VideoThemeId
  readonly title: LocalizedText
  readonly cardTitle?: LocalizedText
  readonly cardPreview: `/assets/${string}.webp`
  readonly cardFocus?: `${number}% ${number}%`
  readonly posterOriginal: `/assets/${string}.${'jpg' | 'png'}`
  readonly playlist: `/assets/${string}.m3u8`
}

export type MediaTheme = ImageTheme | VideoTheme

export const ASSET_ROOT = '/assets/elytrue-20260817'

const officialCredit = { zh: '官方美术', en: 'Official art' } as const
const illustratorUrls = {
  nami: 'https://www.pixiv.net/users/89748593',
  roena: 'https://www.pixiv.net/users/35132995',
  hewuyang: 'https://www.pixiv.net/users/56022318',
  miaogujun: 'https://www.pixiv.net/users/58434088',
} as const

function background(
  id: string,
  layout: BackgroundLayout,
  preview: string,
  original: string,
  focus: `${number}% ${number}%` = '50% 50%',
  artist?: string,
  creditUrl?: `https://${string}`,
): BackgroundAsset {
  return {
    id,
    layout,
    preview: `${ASSET_ROOT}/${preview}` as `/assets/${string}.webp`,
    original: `${ASSET_ROOT}/${original}` as BackgroundAsset['original'],
    focus,
    credit: artist
      ? { zh: `画师: ${artist}`, en: `Illustrator: ${artist}` }
      : officialCredit,
    ...(creditUrl ? { creditUrl } : {}),
  }
}

const landscape1 = background(
  'landscape1',
  'landscape',
  'bg/auto/landscape/landscape1.webp',
  'originals/auto/landscape/landscape1.jpg',
)
const landscape2 = background(
  'landscape2',
  'landscape',
  'bg/auto/landscape/landscape2.webp',
  'originals/auto/landscape/landscape2.jpg',
  '38% 50%',
)
const landscape3 = background(
  'landscape3',
  'landscape',
  'bg/auto/landscape/landscape3.webp',
  'originals/auto/landscape/landscape3.jpg',
  '55% 50%',
  '合悟昂',
  illustratorUrls.hewuyang,
)
const landscape4 = background(
  'landscape4',
  'landscape',
  'bg/auto/landscape/landscape4.webp',
  'originals/auto/landscape/landscape4.jpg',
  '55% 50%',
  '合悟昂',
  illustratorUrls.hewuyang,
)
const landscape5 = background(
  'landscape5',
  'landscape',
  'bg/auto/landscape/landscape5.webp',
  'originals/auto/landscape/landscape5.jpg',
  '52% 50%',
  '喵咕君QAQ(KH3)',
  illustratorUrls.miaogujun,
)
const landscape6 = background(
  'landscape6',
  'landscape',
  'bg/auto/landscape/landscape6.webp',
  'originals/auto/landscape/landscape6.jpg',
  '35% 50%',
  '喵咕君QAQ(KH3)',
  illustratorUrls.miaogujun,
)
const landscape7 = background(
  'landscape7',
  'landscape',
  'bg/auto/landscape/landscape7.webp',
  'originals/auto/landscape/landscape7.jpg',
  '43% 50%',
  '喵咕君QAQ(KH3)',
  illustratorUrls.miaogujun,
)

function officialLandscape(name: string, extension: 'jpg' | 'png') {
  return background(
    `official-landscape-${name}`,
    'landscape',
    `bg/auto/landscape/${name}.webp`,
    `originals/auto/landscape/${name}.${extension}`,
  )
}

const official1 = officialLandscape('1', 'jpg')
const official2 = officialLandscape('2', 'jpg')
const official3 = officialLandscape('3', 'jpg')
const official4 = officialLandscape('4', 'jpg')
const official7 = officialLandscape('7', 'jpg')
const official9 = officialLandscape('9', 'jpg')
const official10 = officialLandscape('10', 'jpg')
const official12 = officialLandscape('12', 'jpg')
const official14 = officialLandscape('14', 'jpg')
const automaticCover = officialLandscape('封面', 'jpg')

function portrait(
  number: number,
  extension: 'jpg' | 'png',
  artist?: string,
  creditUrl?: `https://${string}`,
) {
  return background(
    `portrait${number}`,
    'portrait',
    `bg/auto/portrait/portrait${number}.webp`,
    `originals/auto/portrait/portrait${number}.${extension}`,
    '50% 50%',
    artist,
    creditUrl,
  )
}

const portrait1 = portrait(1, 'jpg', 'nami', illustratorUrls.nami)
const portrait2 = portrait(2, 'jpg', 'nami', illustratorUrls.nami)
const portrait3 = portrait(3, 'jpg', 'roena', illustratorUrls.roena)
const portrait4 = portrait(4, 'jpg', '合悟昂', illustratorUrls.hewuyang)
const portrait5 = portrait(5, 'jpg', '合悟昂', illustratorUrls.hewuyang)
const portrait6 = portrait(
  6,
  'jpg',
  '喵咕君QAQ(KH3)',
  illustratorUrls.miaogujun,
)
const portrait7 = portrait(
  7,
  'jpg',
  '喵咕君QAQ(KH3)',
  illustratorUrls.miaogujun,
)
const portrait8 = portrait(
  8,
  'jpg',
  '喵咕君QAQ(KH3)',
  illustratorUrls.miaogujun,
)
const portrait9 = portrait(
  9,
  'jpg',
  '喵咕君QAQ(KH3)',
  illustratorUrls.miaogujun,
)
const officialPortrait8 = background(
  'official-portrait-8',
  'portrait',
  'bg/auto/portrait/8.webp',
  'originals/auto/portrait/8.jpg',
)
const officialPortrait11 = background(
  'official-portrait-11',
  'portrait',
  'bg/auto/portrait/11.webp',
  'originals/auto/portrait/11.jpg',
)

const summer16 = background(
  'summer-16',
  'landscape',
  'bg/themes/summer/16.webp',
  'originals/themes/summer/16.jpg',
)
const desktopBirthday = background(
  'birthday-desktop-6',
  'landscape',
  'bg/themes/birthday-desktop/6.webp',
  'originals/themes/birthday-desktop/6.jpg',
)
const youth17 = background(
  'youth-17',
  'landscape',
  'bg/themes/youth/17.webp',
  'originals/themes/youth/17.jpg',
)
const youth18 = background(
  'youth-18',
  'landscape',
  'bg/themes/youth/18.webp',
  'originals/themes/youth/18.jpg',
)
const youth19 = background(
  'youth-19',
  'landscape',
  'bg/themes/youth/19.webp',
  'originals/themes/youth/19.jpg',
)
const forElysia17 = background(
  'for-elysia-17',
  'landscape',
  'bg/themes/for-elysia/17.webp',
  'originals/themes/for-elysia/17.jpg',
)
const mobileBirthday = background(
  'birthday-mobile-5',
  'portrait',
  'bg/themes/birthday-mobile/5.webp',
  'originals/themes/birthday-mobile/5.jpg',
)

function themedBackground(
  id: string,
  source: BackgroundAsset,
): BackgroundAsset {
  return { ...source, id }
}

const mainlineCover = themedBackground('mainline-cover', official4)
const mainline13 = themedBackground('mainline-13', automaticCover)
const mainline2 = themedBackground('mainline-2', official2)
const mainline7 = themedBackground('mainline-7', official7)
const summerCover = themedBackground('summer-cover', landscape2)
const summer14 = themedBackground('summer-14', official14)
const youthCover = themedBackground('youth-cover', official9)
const forElysiaCover = themedBackground('for-elysia-cover', official12)
const forElysia1 = themedBackground('for-elysia-1', official1)

export const AUTO_LANDSCAPE_BACKGROUNDS = [
  landscape1,
  landscape2,
  landscape3,
  landscape4,
  landscape5,
  landscape6,
  landscape7,
  official1,
  official2,
  official3,
  official4,
  official7,
  official9,
  official10,
  official12,
  official14,
  automaticCover,
] as const

export const AUTO_PORTRAIT_BACKGROUNDS = [
  portrait1,
  portrait2,
  portrait3,
  portrait4,
  portrait5,
  portrait6,
  portrait7,
  portrait8,
  portrait9,
  officialPortrait8,
  officialPortrait11,
] as const

export const BACKGROUNDS = [
  ...AUTO_LANDSCAPE_BACKGROUNDS,
  ...AUTO_PORTRAIT_BACKGROUNDS,
] as const satisfies readonly BackgroundAsset[]

export const IMAGE_THEMES = [
  {
    kind: 'image',
    id: 'auto-landscape',
    selection: 'auto',
    audience: 'desktop',
    title: { zh: '爱莉希雅', en: '爱莉希雅' },
    cardTitle: { zh: '爱莉希雅', en: '爱莉希雅' },
    cardPreview: automaticCover.preview,
    backgrounds: AUTO_LANDSCAPE_BACKGROUNDS,
    automatic: true,
    showCaptions: true,
  },
  {
    kind: 'image',
    id: 'auto-portrait',
    selection: 'auto',
    audience: 'mobile',
    title: { zh: '爱莉希雅', en: '爱莉希雅' },
    cardTitle: { zh: '爱莉希雅', en: '爱莉希雅' },
    cardPreview: portrait8.preview,
    cardFocus: '50% 30%',
    backgrounds: AUTO_PORTRAIT_BACKGROUNDS,
    automatic: true,
    showCaptions: true,
  },
  {
    kind: 'image',
    id: 'mainline',
    selection: 'mainline',
    audience: 'desktop',
    title: { zh: '主线-活动', en: 'Story & Events' },
    cardPreview: mainlineCover.preview,
    backgrounds: [mainlineCover, mainline13, mainline2, mainline7],
    automatic: false,
    showCaptions: false,
  },
  {
    kind: 'image',
    id: 'summer',
    selection: 'summer',
    audience: 'desktop',
    title: { zh: '集合！沁夏友乐园', en: 'Summer Fun Park' },
    cardPreview: summerCover.preview,
    backgrounds: [summerCover, summer14, summer16],
    automatic: false,
    showCaptions: false,
  },
  {
    kind: 'image',
    id: 'youth',
    selection: 'youth',
    audience: 'desktop',
    title: { zh: '偕行！青春畅想', en: 'Youthful Dreams' },
    cardPreview: youthCover.preview,
    backgrounds: [youthCover, youth17, youth18, youth19],
    automatic: false,
    showCaptions: false,
  },
  {
    kind: 'image',
    id: 'birthday-desktop',
    selection: 'birthday',
    audience: 'desktop',
    title: { zh: '生日快乐！', en: 'Happy Birthday!' },
    cardPreview: desktopBirthday.preview,
    backgrounds: [desktopBirthday],
    automatic: false,
    showCaptions: false,
  },
  {
    kind: 'image',
    id: 'birthday-mobile',
    selection: 'birthday',
    audience: 'mobile',
    title: { zh: '生日快乐！', en: 'Happy Birthday!' },
    cardPreview: mobileBirthday.preview,
    cardFocus: '50% 35%',
    backgrounds: [mobileBirthday],
    automatic: false,
    showCaptions: false,
  },
  {
    kind: 'image',
    id: 'for-elysia',
    selection: 'for-elysia',
    audience: 'desktop',
    title: { zh: '致爱莉希雅', en: 'To Elysia' },
    cardPreview: forElysiaCover.preview,
    backgrounds: [forElysiaCover, forElysia1, forElysia17],
    automatic: false,
    showCaptions: false,
  },
] as const satisfies readonly ImageTheme[]

export const VIDEO_THEMES = [
  {
    kind: 'video',
    id: 'story-because-of-you',
    selection: 'story-because-of-you',
    title: { zh: '因你而在的故事', en: 'Because of You' },
    cardPreview: official10.preview,
    posterOriginal: official10.original,
    playlist: `${ASSET_ROOT}/video/story-because-of-you/index.m3u8`,
  },
  {
    kind: 'video',
    id: 'magical-invitation',
    selection: 'magical-invitation',
    title: {
      zh: '妖精小姐的魔法邀约',
      en: "Miss Elf's Magical Invitation",
    },
    cardPreview: `${ASSET_ROOT}/bg/video/magical-invitation/封面.webp`,
    posterOriginal: `${ASSET_ROOT}/originals/video/magical-invitation/封面.jpg`,
    playlist: `${ASSET_ROOT}/video/magical-invitation/index.m3u8`,
  },
  {
    kind: 'video',
    id: 'makeup-class',
    selection: 'makeup-class',
    title: { zh: '爱莉希雅的化妆小课堂', en: "Elysia's Makeup Class" },
    cardPreview: `${ASSET_ROOT}/bg/video/makeup-class/封面.webp`,
    posterOriginal: `${ASSET_ROOT}/originals/video/makeup-class/封面.jpg`,
    playlist: `${ASSET_ROOT}/video/makeup-class/index.m3u8`,
  },
] as const satisfies readonly VideoTheme[]

export const DESKTOP_THEME_SELECTIONS = [
  'auto',
  'mainline',
  'summer',
  'youth',
  'birthday',
  'for-elysia',
  'story-because-of-you',
  'magical-invitation',
  'makeup-class',
] as const satisfies readonly ThemeSelectionId[]

export const MOBILE_THEME_SELECTIONS = [
  'auto',
  'birthday',
  'story-because-of-you',
  'magical-invitation',
  'makeup-class',
] as const satisfies readonly ThemeSelectionId[]

export const ALL_MEDIA_THEMES = [
  ...IMAGE_THEMES,
  ...VIDEO_THEMES,
] as const satisfies readonly MediaTheme[]

export function imageThemeForSelection(
  selection: ThemeSelectionId,
  audience: ThemeAudience,
): ImageTheme | undefined {
  return IMAGE_THEMES.find(
    (theme) => theme.selection === selection && theme.audience === audience,
  )
}

export function videoThemeForSelection(
  selection: ThemeSelectionId,
): VideoTheme | undefined {
  return VIDEO_THEMES.find((theme) => theme.selection === selection)
}

export function mediaThemeTitle(
  id: ImageThemeId | VideoThemeId,
): LocalizedText {
  return (
    ALL_MEDIA_THEMES.find((theme) => theme.id === id)?.title ?? {
      zh: '自动',
      en: 'Auto',
    }
  )
}
