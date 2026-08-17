import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DESKTOP_THEME_SELECTIONS,
  IMAGE_THEMES,
  MOBILE_THEME_SELECTIONS,
  VIDEO_THEMES,
} from '../../src/config/assets'
import {
  isShanghaiBirthday,
  resolveThemeSelection,
} from '../../src/features/theme/theme-controller'

test('November 11 is a full Asia/Shanghai birthday day', () => {
  assert.equal(isShanghaiBirthday(new Date('2026-11-10T15:59:59Z')), false)
  assert.equal(isShanghaiBirthday(new Date('2026-11-10T16:00:00Z')), true)
  assert.equal(isShanghaiBirthday(new Date('2026-11-11T15:59:59Z')), true)
  assert.equal(isShanghaiBirthday(new Date('2026-11-11T16:00:00Z')), false)

  const birthday = new Date('2026-11-11T03:00:00Z')
  assert.equal(
    resolveThemeSelection('auto', 'desktop', birthday).id,
    'birthday-desktop',
  )
  assert.equal(
    resolveThemeSelection('auto', 'mobile', birthday).id,
    'birthday-mobile',
  )
})

test('theme manifests lock desktop and mobile card order', () => {
  assert.deepEqual(DESKTOP_THEME_SELECTIONS, [
    'auto',
    'mainline',
    'summer',
    'youth',
    'birthday',
    'for-elysia',
    'story-because-of-you',
    'magical-invitation',
    'makeup-class',
  ])
  assert.deepEqual(MOBILE_THEME_SELECTIONS, [
    'auto',
    'birthday',
    'story-because-of-you',
    'magical-invitation',
    'makeup-class',
  ])
  assert.equal(VIDEO_THEMES.length, 3)
})

test('automatic pools and fixed-cover image themes remain distinct', () => {
  const desktopAuto = IMAGE_THEMES.find(
    (theme) => theme.id === 'auto-landscape',
  )
  const mobileAuto = IMAGE_THEMES.find((theme) => theme.id === 'auto-portrait')
  assert.equal(desktopAuto?.backgrounds.length, 17)
  assert.equal(mobileAuto?.backgrounds.length, 11)
  assert.match(desktopAuto?.cardPreview ?? '', /\/封面\.webp$/u)
  assert.equal(desktopAuto?.cardTitle?.zh, '爱莉希雅')
  assert.equal(desktopAuto?.cardTitle?.en, '爱莉希雅')
  assert.match(mobileAuto?.cardPreview ?? '', /\/portrait8\.webp$/u)
  assert.equal(mobileAuto?.cardTitle?.zh, '爱莉希雅')
  assert.equal(mobileAuto?.cardTitle?.en, '爱莉希雅')
  assert.equal(mobileAuto?.cardFocus, '50% 30%')
  assert.equal(desktopAuto?.showCaptions, true)
  assert.equal(mobileAuto?.showCaptions, true)

  for (const theme of IMAGE_THEMES) {
    assert.equal(
      new Set(theme.backgrounds.map((background) => background.id)).size,
      theme.backgrounds.length,
    )
  }
  const mainline = IMAGE_THEMES.find((theme) => theme.id === 'mainline')
  assert.deepEqual(
    mainline?.backgrounds.map((background) => background.id),
    ['mainline-cover', 'mainline-13', 'mainline-2', 'mainline-7'],
  )
  const automaticIds = new Set(
    IMAGE_THEMES.filter((theme) => theme.automatic).flatMap((theme) =>
      theme.backgrounds.map((background) => background.id),
    ),
  )
  for (const theme of IMAGE_THEMES.filter((item) => !item.automatic)) {
    assert.equal(
      theme.backgrounds.some((background) => automaticIds.has(background.id)),
      false,
    )
  }

  for (const theme of IMAGE_THEMES.filter((item) => !item.automatic)) {
    assert.equal(theme.showCaptions, false)
    assert.ok(theme.backgrounds[0])
  }
  assert.equal(
    IMAGE_THEMES.find((theme) => theme.id === 'birthday-desktop')?.backgrounds
      .length,
    1,
  )
  assert.equal(
    IMAGE_THEMES.find((theme) => theme.id === 'birthday-mobile')?.backgrounds
      .length,
    1,
  )
  assert.equal(
    IMAGE_THEMES.find((theme) => theme.id === 'birthday-mobile')?.cardFocus,
    '50% 35%',
  )
})

test('video selections are shared across layouts', () => {
  const date = new Date('2026-08-13T00:00:00Z')
  for (const theme of VIDEO_THEMES) {
    assert.equal(resolveThemeSelection(theme.selection, 'desktop', date), theme)
    assert.equal(resolveThemeSelection(theme.selection, 'mobile', date), theme)
  }
})
