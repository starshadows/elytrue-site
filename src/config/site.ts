export type Locale = 'zh' | 'en'

export interface LocalizedText {
  readonly zh: string
  readonly en: string
}

export const SITE = {
  origin: 'https://elytrue.com',
  canonicalUrl: 'https://elytrue.com/',
  name: {
    zh: '星花札记',
    en: 'Starflower Notes',
  },
  title: '星花札记 | elytrue.com',
  author: 'elytrue.com',
  description: {
    zh: '以爱莉希雅为主题的非商业个人同人展示网站，记录角色相关图片、文字与音乐。',
    en: 'A non-commercial personal fan site inspired by Elysia, preserving character-related art, writing, and music.',
  },
  shortDescription: {
    zh: '以爱莉希雅为主题的非商业个人同人展示网站。',
    en: 'A non-commercial personal fan site inspired by Elysia.',
  },
  keywords: ['爱莉希雅', '崩坏3', '星花札记', 'elytrue'],
  themeColor: '#ffaacc',
  backgroundColor: '#f6d7ea',
  shareImage: '/social-share.jpg',
  icon: '/assets/elytrue-shell-20260805/favicon-320-c998712d.png',
  icp: {
    label: '赣ICP备2026015414号-1',
    url: 'https://beian.miit.gov.cn/',
  },
} as const

export const COPY = {
  illustrator: { zh: '画师：', en: 'Illustrator: ' },
  officialArt: { zh: '官方美术', en: 'Official art' },
  landscapeBackgrounds: {
    zh: '横屏背景',
    en: 'Landscape backgrounds',
  },
  portraitBackgrounds: {
    zh: '竖屏背景',
    en: 'Portrait backgrounds',
  },
  authorizedRepost: {
    zh: '经作者许可转载',
    en: 'Reposted with permission',
  },
  downloadOriginal: { zh: '下载原图', en: 'Download original' },
  imagePermission: {
    zh: '本站展示的二创图片均经原作者许可转载，并按作者要求标注画师与来源链接。',
    en: 'Fan artworks displayed here are reposted with their artists’ permission, with artist names and source links credited as requested.',
  },
  rights: {
    zh: '角色、官方美术与音乐版权归原权利人所有。',
    en: 'Character, official art, and music rights remain with their respective owners.',
  },
} as const satisfies Record<string, LocalizedText>

function setMeta(selector: string, value: string): void {
  document
    .querySelector<HTMLMetaElement>(selector)
    ?.setAttribute('content', value)
}

export function applyDocumentMetadata(): void {
  document.title = SITE.title
  document.documentElement.lang = 'zh'
  setMeta('meta[name="author"]', SITE.author)
  setMeta('meta[name="description"]', SITE.description.zh)
  setMeta('meta[name="keywords"]', SITE.keywords.join(', '))
  setMeta('meta[name="theme-color"]', SITE.themeColor)
  setMeta('meta[property="og:title"]', SITE.title)
  setMeta('meta[property="og:description"]', SITE.shortDescription.zh)
  setMeta('meta[property="og:url"]', SITE.canonicalUrl)
  setMeta('meta[property="og:image"]', `${SITE.origin}${SITE.shareImage}`)
  setMeta('meta[name="twitter:title"]', SITE.title)
  setMeta('meta[name="twitter:description"]', SITE.shortDescription.zh)
  setMeta('meta[name="twitter:image"]', `${SITE.origin}${SITE.shareImage}`)
}
