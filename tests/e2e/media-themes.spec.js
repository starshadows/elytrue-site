import { expect, test } from '@playwright/test'

const DESKTOP_THEMES = [
  'auto',
  'mainline',
  'summer',
  'youth',
  'birthday',
  'for-elysia',
  'story-because-of-you',
  'magical-invitation',
  'makeup-class',
]

const MOBILE_THEMES = [
  'auto',
  'birthday',
  'story-because-of-you',
  'magical-invitation',
  'makeup-class',
]

test.beforeEach(async ({ page, context }) => {
  await page.request.post('/__test/reset')
  await context.clearCookies()
  await page.addInitScript(() => {
    Math.random = () => 0
    localStorage.setItem('mutebgm', 'true')
  })
})

async function openThemeSelector(page) {
  await page.locator('.mainTitleUnder').click()
  await expect(page.locator('#themeSelectorPopup')).toBeVisible()
}

test('desktop theme selector is a nine-card grid with birthday centered', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await openThemeSelector(page)

  const cards = page.locator('#themeList > [data-theme]')
  await expect(cards).toHaveCount(9)
  expect(
    await cards.evaluateAll((items) => items.map((item) => item.dataset.theme)),
  ).toEqual(DESKTOP_THEMES)
  await expect(cards.nth(0)).toContainText('爱莉希雅')
  await expect(cards.nth(0)).not.toContainText('自动')
  await expect(cards.nth(0)).not.toContainText('Elysia')
  await expect(cards.nth(4)).toContainText('生日快乐！')
  const measurements = await page
    .locator('#themeSelectorPopup')
    .evaluate((dialog) => {
      const list = dialog.querySelector('#themeList')
      const image = list?.querySelector('img')
      if (!(list instanceof HTMLElement) || !(image instanceof HTMLElement))
        throw new Error('Theme grid is incomplete')
      const dialogBox = dialog.getBoundingClientRect()
      const listBox = list.getBoundingClientRect()
      const imageBox = image.getBoundingClientRect()
      return {
        dialogWidth: dialogBox.width,
        listWidth: listBox.width,
        imageWidth: imageBox.width,
        imageHeight: imageBox.height,
        borderWidth: getComputedStyle(image).borderWidth,
      }
    })
  expect(measurements.dialogWidth).toBeCloseTo(714, 0)
  expect(measurements.listWidth).toBeCloseTo(650, 0)
  expect(measurements.imageWidth).toBeCloseTo(180, 0)
  expect(measurements.imageHeight).toBeCloseTo(120, 0)
  expect(measurements.borderWidth).toBe('0px')
})

test('mobile theme selector is the required five-card vertical list', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await openThemeSelector(page)

  const cards = page.locator('#themeList > [data-theme]')
  await expect(cards).toHaveCount(5)
  expect(
    await cards.evaluateAll((items) => items.map((item) => item.dataset.theme)),
  ).toEqual(MOBILE_THEMES)
  await expect(cards.nth(0)).toContainText('爱莉希雅')
  await expect(cards.nth(0)).not.toContainText('自动')
  await expect(cards.nth(0).locator('img')).toHaveAttribute(
    'src',
    /\/portrait8\.webp$/u,
  )
  await expect(cards.nth(1)).toContainText('生日快乐！')
  await expect(cards.nth(1).locator('img')).toHaveCSS(
    'object-position',
    '50% 35%',
  )
  expect(
    await page
      .locator('#themeList')
      .evaluate(
        (element) =>
          getComputedStyle(element).gridTemplateColumns.split(' ').length,
      ),
  ).toBe(1)
})

test('automatic mode resolves to the desktop birthday still on November 11 in Shanghai', async ({
  page,
}) => {
  await page.addInitScript((fixedTime) => {
    const NativeDate = Date
    class FixedDate extends NativeDate {
      constructor(...args) {
        super(...(args.length === 0 ? [fixedTime] : args))
      }

      static now() {
        return fixedTime
      }
    }
    globalThis.Date = FixedDate
  }, Date.parse('2026-11-10T16:00:00.000Z'))

  await page.goto('/')
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-theme-id',
    'birthday-desktop',
  )
  await expect(
    page.locator('.mainbg[data-theme-id="birthday-desktop"]'),
  ).toHaveCount(1)
  await expect(page.locator('#themeTxt-birthday-desktop')).toBeVisible()
  await expect(page.locator('#mainCaptions')).toHaveCSS('opacity', '0')
})

test('the bootstrap auto image is retired after the first managed background is ready', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  await expect(page.locator('.mainbg.visible')).toHaveCount(1)

  const bootstrap = await page.evaluate(() => {
    const preload = document.querySelector('link[data-ely-initial-background]')
    return {
      id: document.documentElement.dataset.initialBackgroundId ?? '',
      source: preload instanceof HTMLLinkElement ? preload.href : '',
    }
  })
  expect(bootstrap.id).not.toBe('')
  expect(bootstrap.source).not.toBe('')

  await openThemeSelector(page)
  await page.locator('#themeList > [data-theme="mainline"]').click()
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-theme-id',
    'mainline',
  )
  await expect(page.locator('#initialBackground')).toHaveCount(0)

  const settled = await page.locator('#bgContainer').evaluate((element) => ({
    backgroundImage: getComputedStyle(element).backgroundImage,
    bootstrapProperty: document.documentElement.style.getPropertyValue(
      '--ely-initial-background',
    ),
  }))
  expect(settled.backgroundImage).not.toContain(bootstrap.source)
  expect(settled.bootstrapProperty).toBe('')
})

test('theme changes retain the visible image until decode and cancel stale work', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeDecode = Image.prototype.decode
    window.__holdBirthdayDecode = false
    window.__releaseBirthdayDecode = undefined
    Image.prototype.decode = function () {
      if (
        window.__holdBirthdayDecode &&
        this.src.includes('/bg/themes/birthday-desktop/6.webp')
      ) {
        return new Promise((resolve, reject) => {
          window.__releaseBirthdayDecode = () => {
            nativeDecode.call(this).then(resolve, reject)
          }
        })
      }
      return nativeDecode.call(this)
    }
  })
  await page.goto('/')
  await expect(page.locator('.mainbg.visible')).toHaveCount(1)
  const originalTheme = await page
    .locator('.mainbg.visible')
    .getAttribute('data-theme-id')

  await openThemeSelector(page)
  await page.evaluate(() => {
    window.__holdBirthdayDecode = true
  })
  await page.locator('#themeList > [data-theme="birthday"]').click()
  await page.waitForTimeout(500)
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-theme-id',
    originalTheme,
  )
  await expect(
    page.locator('.mainbg[data-theme-id="birthday-desktop"].visible'),
  ).toHaveCount(0)

  await openThemeSelector(page)
  await page.locator('#themeList > [data-theme="for-elysia"]').click()
  await expect(
    page.locator('.mainbg[data-theme-id="for-elysia"].visible'),
  ).toHaveCount(1)
  await page.evaluate(() => {
    window.__releaseBirthdayDecode?.()
  })
  await page.waitForTimeout(300)
  await expect(
    page.locator('.mainbg[data-theme-id="birthday-desktop"].visible'),
  ).toHaveCount(0)
})

test('accelerated carousel cycles cannot leave stale theme state behind', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window)
    const nativeSetInterval = window.setInterval.bind(window)
    window.setTimeout = (callback, timeout = 0, ...args) =>
      nativeSetTimeout(
        callback,
        timeout === 8_000 ? 120 : timeout === 2_500 ? 40 : timeout,
        ...args,
      )
    window.setInterval = (callback, timeout = 0, ...args) =>
      nativeSetInterval(callback, timeout === 8_000 ? 120 : timeout, ...args)
  })
  await page.goto('/')

  const sequence = [
    ['mainline', 'mainline'],
    ['summer', 'summer'],
    ['youth', 'youth'],
    ['for-elysia', 'for-elysia'],
    ['mainline', 'mainline'],
  ]
  for (let round = 0; round < 2; round += 1) {
    for (const [selection, themeId] of sequence) {
      await openThemeSelector(page)
      await page.locator(`#themeList [data-theme="${selection}"]`).click()
      await expect(page.locator('.mainbg.visible')).toHaveAttribute(
        'data-theme-id',
        themeId,
      )
      await page.waitForTimeout(420)
      await expect
        .poll(() =>
          page.locator('.mainbg').evaluateAll((backgrounds, expectedTheme) => {
            const visible = backgrounds.filter((background) =>
              background.classList.contains('visible'),
            )
            const stale = backgrounds.filter(
              (background) =>
                background.getAttribute('data-theme-id') !== expectedTheme &&
                (background.classList.contains('visible') ||
                  background.classList.contains('animating') ||
                  background.classList.contains('ready') ||
                  background.classList.contains('bgzoom')),
            )
            return {
              visible: visible.length,
              visibleTheme: visible[0]?.getAttribute('data-theme-id'),
              stale: stale.length,
            }
          }, themeId),
        )
        .toEqual({ visible: 1, visibleTheme: themeId, stale: 0 })
    }
  }
})

test('all nine theme selections survive refresh and image themes reshuffle', async ({
  page,
}) => {
  const resolvedIds = {
    auto: 'auto-landscape',
    mainline: 'mainline',
    summer: 'summer',
    youth: 'youth',
    birthday: 'birthday-desktop',
    'for-elysia': 'for-elysia',
    'story-because-of-you': 'story-because-of-you',
    'magical-invitation': 'magical-invitation',
    'makeup-class': 'makeup-class',
  }
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')

  let firstMainlineBackground = ''
  for (const selection of DESKTOP_THEMES) {
    const focusToggle = page.locator('.videoFocusToggle input')
    if (await focusToggle.count()) await focusToggle.uncheck()
    await openThemeSelector(page)
    await page.locator(`#themeList [data-theme="${selection}"]`).click()
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem('elytrue.theme-selection:v1')),
      )
      .toBe(selection)

    if (selection === 'mainline') {
      firstMainlineBackground =
        (await page
          .locator('.mainbg.visible')
          .getAttribute('data-background-id')) ?? ''
    }

    await page.reload()
    const videoSelection =
      selection.startsWith('story-') ||
      selection === 'magical-invitation' ||
      selection === 'makeup-class'
    if (videoSelection) {
      await expect(
        page.locator(`#themeTxt-${resolvedIds[selection]}`),
      ).toHaveCount(1)
      await expect(page.locator('#videoPlayerLayer')).toBeVisible()
    } else {
      await expect(
        page.locator(`#themeTxt-${resolvedIds[selection]}`),
      ).toBeVisible()
      await expect(page.locator('.mainbg.visible')).toHaveAttribute(
        'data-theme-id',
        resolvedIds[selection],
      )
    }

    if (selection === 'mainline') {
      await expect(page.locator('.mainbg.visible')).not.toHaveAttribute(
        'data-background-id',
        firstMainlineBackground,
      )
    }
  }
})

test('video progress survives a page refresh', async ({ page }) => {
  await page.goto('/')
  await openThemeSelector(page)
  await page.locator('#themeList [data-theme="story-because-of-you"]').click()
  const player = page.locator('#videoPlayerLayer video')
  await expect
    .poll(() => player.evaluate((element) => element.duration || 0))
    .toBeGreaterThan(30)
  await player.evaluate((element) => {
    element.currentTime = 37
    element.dispatchEvent(new Event('timeupdate'))
  })
  await expect
    .poll(() =>
      page.evaluate(() => {
        const progress = JSON.parse(
          localStorage.getItem('elytrue.video-progress:v1') || '{}',
        )
        return progress['story-because-of-you'] ?? 0
      }),
    )
    .toBeGreaterThanOrEqual(37)

  await page.reload()
  await expect(page.locator('#videoPlayerLayer')).toBeVisible()
  await expect
    .poll(() => player.evaluate((element) => element.currentTime))
    .toBeGreaterThanOrEqual(36)
})

test('the first theme image uses entry zoom while carousel successors do not', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window)
    window.setTimeout = (callback, timeout = 0, ...args) =>
      nativeSetTimeout(callback, timeout === 8_000 ? 500 : timeout, ...args)
  })
  await page.goto('/')
  await openThemeSelector(page)
  await page.locator('#themeList [data-theme="mainline"]').click()
  const visible = page.locator('.mainbg.visible')
  await expect(visible).toHaveAttribute('data-theme-id', 'mainline')
  await expect(visible).toHaveClass(/\bbgzoom\b/u)
  const firstId = await visible.getAttribute('data-background-id')
  await expect
    .poll(() => visible.getAttribute('data-background-id'))
    .not.toBe(firstId)
  await expect(visible).not.toHaveClass(/\bbgzoom\b/u)
})

test('every image manifest entry renders credit and shared sources stay theme-owned', async ({
  page,
}) => {
  await page.goto('/')
  const creditContract = await page.evaluate(() => {
    const backgrounds = Array.from(document.querySelectorAll('.mainbg'))
    const credits = Array.from(
      document.querySelectorAll('.backgroundCredit[data-theme-id]'),
    )
    const creditKeys = new Set(
      credits.map(
        (credit) =>
          `${credit.getAttribute('data-theme-id')}:${credit.getAttribute('data-background-id')}`,
      ),
    )
    return {
      backgroundCount: backgrounds.length,
      creditCount: credits.length,
      everyBackgroundCredited: backgrounds.every((background) =>
        creditKeys.has(
          `${background.getAttribute('data-theme-id')}:${background.getAttribute('data-background-id')}`,
        ),
      ),
      linksSafe: credits
        .filter((credit) => credit.hasAttribute('data-credit-url'))
        .every(
          (credit) =>
            credit instanceof HTMLAnchorElement &&
            credit.href.startsWith('https://') &&
            credit.target === '_blank' &&
            credit.rel.split(/\s+/u).includes('noopener') &&
            credit.rel.split(/\s+/u).includes('noreferrer'),
        ),
    }
  })
  expect(creditContract.creditCount).toBe(creditContract.backgroundCount)
  expect(creditContract.everyBackgroundCredited).toBe(true)
  expect(creditContract.linksSafe).toBe(true)

  await openThemeSelector(page)
  await page.locator('#themeList [data-theme="summer"]').click()
  const summer = page.locator('.mainbg.visible')
  await expect(summer).toHaveAttribute('data-theme-id', 'summer')
  await expect(summer).toHaveAttribute('data-background-id', 'summer-cover')
  await expect(summer.locator(':scope > div')).toHaveCSS(
    'background-image',
    /\/bg\/auto\/landscape\/landscape2\.webp/u,
  )
  await expect(
    page.locator('.mainbg[data-theme-id="auto-landscape"].visible'),
  ).toHaveCount(0)
  await expect(page.locator('.backgroundCredit.visible')).toHaveAttribute(
    'data-theme-id',
    'summer',
  )
})

test('a decode failure keeps the current background visible', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const nativeDecode = Image.prototype.decode
    Image.prototype.decode = function () {
      if (this.src.includes('/bg/themes/birthday-desktop/6.webp')) {
        return Promise.reject(new DOMException('decode failed'))
      }
      return nativeDecode.call(this)
    }
  })
  await page.goto('/')
  await expect(page.locator('.mainbg.visible')).toHaveCount(1)
  const visibleBackground = await page
    .locator('.mainbg.visible')
    .getAttribute('data-background-id')
  await openThemeSelector(page)
  await page.locator('#themeList > [data-theme="birthday"]').click()
  await page.waitForTimeout(500)
  await expect(page.locator('.mainbg.visible')).toHaveCount(1)
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-background-id',
    visibleBackground,
  )
})

test('opening selectors and the download gallery only requests WebP previews until download', async ({
  page,
}) => {
  const requestedOriginals = []
  page.on('request', (request) => {
    if (request.url().includes('/originals/'))
      requestedOriginals.push(request.url())
  })

  await page.goto('/')
  await openThemeSelector(page)
  await expect
    .poll(() =>
      page.locator('#themeList img').evaluateAll((images) =>
        images
          .map((image) => image.currentSrc)
          .filter(Boolean)
          .every((source) => source.endsWith('.webp')),
      ),
    )
    .toBe(true)
  expect(requestedOriginals).toEqual([])

  await page.locator('.themePopupLinks .underlinedIconLink').last().click()
  await expect(page.locator('#getImgPopup')).toBeVisible()
  await expect(
    page.locator('#getImgPopup .backgroundGroupTitle .ui.zh'),
  ).toHaveText(['横屏背景', '竖屏背景'])
  await expect(page.locator('#getImgPopup')).not.toContainText(
    '新增素材均为官方美术',
  )
  await expect(page.locator('#getImgPopup img').first()).toHaveAttribute(
    'src',
    /\.webp$/u,
  )
  const downloadGroups = page.locator('#getImgPopup .backgroundDownloadGroup')
  await expect(downloadGroups).toHaveCount(2)
  await expect(downloadGroups.nth(0)).toHaveAttribute(
    'data-layout',
    'landscape',
  )
  await expect(downloadGroups.nth(1)).toHaveAttribute('data-layout', 'portrait')
  expect(
    await downloadGroups
      .nth(0)
      .locator('img')
      .evaluateAll((images) =>
        images.every((image) => image.dataset.layout === 'landscape'),
      ),
  ).toBe(true)
  expect(
    await downloadGroups
      .nth(1)
      .locator('img')
      .evaluateAll((images) =>
        images.every((image) => image.dataset.layout === 'portrait'),
      ),
  ).toBe(true)
  expect(requestedOriginals).toEqual([])

  const downloadEvent = page.waitForEvent('download')
  await page.locator('#getImgPopup .downloadOriginal').first().click()
  const download = await downloadEvent
  expect(download.suggestedFilename()).toMatch(/\.(?:jpe?g|png)$/iu)
  expect(await download.failure()).toBeNull()
  expect(await download.path()).not.toBeNull()
})

test('video themes use blur and prompt-free fullscreen, then restore image UI and music', async ({
  page,
}) => {
  const sourceVideos = []
  page.on('request', (request) => {
    if (
      /\.(?:mp4|webm)(?:$|\?)/iu.test(request.url()) &&
      !/\/init\.mp4(?:$|\?)/iu.test(request.url())
    ) {
      sourceVideos.push(request.url())
    }
  })

  await page.goto('/?musicDebug=1')
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await expect
    .poll(() => page.locator('#musicAudio').evaluate((audio) => audio.paused))
    .toBe(false)

  await openThemeSelector(page)
  await page.locator('#themeList [data-theme="mainline"]').click()
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-theme-id',
    'mainline',
  )
  const credit = page.locator('.backgroundCredit.visible')
  const blur = page.locator('.videoBackgroundBlur')
  await expect(credit).toBeVisible()
  await expect(blur).toHaveCSS('visibility', 'hidden')

  await openThemeSelector(page)
  const playlistRequest = page.waitForRequest(
    /\/video\/story-because-of-you\/index\.m3u8$/u,
  )
  await page.locator('#themeList [data-theme="story-because-of-you"]').click()
  await playlistRequest

  await expect(page.locator('#videoPlayerLayer')).toBeVisible()
  await expect(page.locator('body > #videoPlayerLayer')).toHaveCount(1)
  await expect(page.locator('#videoPlayerLayer h2')).toHaveCount(0)
  await expect(page.locator('body')).toHaveClass(/\bvideo-focus\b/u)
  await expect(page.locator('body')).toHaveClass(/\bvideo-theme-active\b/u)
  await expect(blur).toHaveCSS('visibility', 'visible')
  await expect(blur).toHaveCSS('opacity', '1')
  expect(
    await blur.evaluate((element) => getComputedStyle(element).backdropFilter),
  ).toMatch(/blur\(/u)
  await expect(page.locator('#header')).toHaveCSS('visibility', 'hidden')
  await expect(credit).toHaveCSS('visibility', 'hidden')
  await expect(page.locator('.videoFocusToggle input')).toBeChecked()
  await expect(
    page.locator('#videoPlayerLayer > .videoFocusToggle'),
  ).toHaveCount(1)
  await expect
    .poll(() => page.locator('#musicAudio').evaluate((audio) => audio.paused))
    .toBe(true)
  expect(sourceVideos).toEqual([])

  await page.locator('.videoFocusToggle input').uncheck()
  await expect(page.locator('body')).not.toHaveClass(/\bvideo-focus\b/u)
  await expect(page.locator('#header')).toHaveCSS('visibility', 'visible')
  await expect(credit).toBeVisible()
  await expect(blur).toHaveCSS('visibility', 'visible')

  await openThemeSelector(page)
  await page.locator('#themeList [data-theme="magical-invitation"]').click()
  await expect(page.locator('#videoPlayerLayer')).toBeVisible()
  await expect(page.locator('.videoFocusToggle input')).toBeChecked()

  await expect(page.getByText('宽屏', { exact: true })).toHaveCount(0)
  await expect(page.locator('#videoPlayerLayer')).not.toHaveClass(/\bwide\b/u)

  await page.locator('#videoPlayerLayer').hover()
  await page.getByRole('button', { name: /全屏/u }).click()
  await expect(page.locator('#videoPlayerLayer')).toHaveClass(
    /\bplayer-fullscreen\b/u,
  )
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement))
    .toBeNull()
  await page.keyboard.press('Escape')
  await expect(page.locator('#videoPlayerLayer')).not.toHaveClass(
    /\bplayer-fullscreen\b/u,
  )
  await expect(page.getByRole('button', { name: /全屏/u })).toHaveCount(1)

  await page.getByRole('button', { name: /全屏/u }).click()
  await expect(page.locator('#videoPlayerLayer')).toHaveClass(
    /\bplayer-fullscreen\b/u,
  )
  await page.evaluate(() => {
    const selector = document.querySelector('.mainTitleUnder')
    if (selector instanceof HTMLElement) selector.click()
  })
  await expect(page.locator('#themeSelectorPopup')).toHaveAttribute(
    'aria-hidden',
    'false',
  )
  await page.evaluate(() => {
    const card = document.querySelector(
      '#themeList [data-theme="story-because-of-you"]',
    )
    if (card instanceof HTMLElement) card.click()
  })
  await expect(page.locator('#videoPlayerLayer')).not.toHaveClass(
    /\bplayer-fullscreen\b/u,
  )
  await expect(page.locator('#videoPlayerLayer')).toBeVisible()

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement)
      document.activeElement.blur()
  })
  await page.mouse.move(0, 0)
  await expect(page.locator('#videoPlayerLayer')).toHaveClass(
    /\bcontrols-hidden\b/u,
    { timeout: 2500 },
  )
  await expect(page.locator('#videoPlayerLayer')).toHaveCSS('cursor', 'none')
  await page.locator('#videoPlayerLayer').hover({ position: { x: 40, y: 40 } })
  await expect(page.locator('#videoPlayerLayer')).not.toHaveClass(
    /\bcontrols-hidden\b/u,
  )

  await page.locator('.videoFocusToggle input').uncheck()
  await page.evaluate(() => document.body.classList.add('lowend'))
  expect(
    await blur.evaluate((element) => getComputedStyle(element).backdropFilter),
  ).toMatch(/blur\(10px\)/u)
  await expect(blur).toHaveCSS('transition-duration', '0s')
  await page.getByRole('button', { name: '返回', exact: true }).click()
  await expect(page.locator('#videoPlayerLayer')).toHaveCount(0)
  await expect(page.locator('body')).not.toHaveClass(/\bvideo-theme-active\b/u)
  await expect(blur).toHaveCSS('visibility', 'hidden')
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-theme-id',
    'mainline',
  )
  await expect
    .poll(() => page.locator('#musicAudio').evaluate((audio) => audio.paused))
    .toBe(false)
})

for (const viewport of [
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]) {
  test(`mobile video blur overscans every viewport edge at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await openThemeSelector(page)
    await page.locator('#themeList [data-theme="story-because-of-you"]').click()

    const blur = page.locator('.videoBackgroundBlur')
    await expect(blur).toHaveCSS('visibility', 'visible')
    await expect(blur).toHaveCSS('opacity', '1')
    expect(
      await blur.evaluate(
        (element) => getComputedStyle(element).backdropFilter,
      ),
    ).toMatch(/blur\(/u)

    const measureCoverage = () =>
      blur.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return {
          left: -box.left,
          top: -box.top,
          right: box.right - window.innerWidth,
          bottom: box.bottom - window.innerHeight,
        }
      })
    const expectOverscan = (coverage) => {
      expect(coverage.left).toBeGreaterThanOrEqual(80)
      expect(coverage.top).toBeGreaterThanOrEqual(80)
      expect(coverage.right).toBeGreaterThanOrEqual(80)
      expect(coverage.bottom).toBeGreaterThanOrEqual(80)
    }

    expectOverscan(await measureCoverage())
    const playerBox = await page.locator('#videoPlayerLayer').boundingBox()
    expect(playerBox?.width).toBeLessThanOrEqual(viewport.width)
    expect((playerBox?.width ?? 0) / (playerBox?.height ?? 1)).toBeCloseTo(
      16 / 9,
      2,
    )

    await page.setViewportSize({
      width: viewport.height,
      height: viewport.width,
    })
    await page.evaluate(() =>
      window.dispatchEvent(new Event('orientationchange')),
    )
    await expect
      .poll(async () => Math.min(...Object.values(await measureCoverage())))
      .toBeGreaterThanOrEqual(80)
  })
}

test('desktop video player keeps 16:9 windowed dimensions and fills CSS fullscreen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 2100, height: 1300 })
  await page.goto('/')
  await openThemeSelector(page)
  await page.locator('#themeList [data-theme="story-because-of-you"]').click()

  const player = page.locator('#videoPlayerLayer')
  await expect(player).toBeVisible()
  let box = await player.boundingBox()
  expect(box?.width).toBeCloseTo(1600, 0)
  expect(box?.height).toBeCloseTo(900, 0)

  await player.hover()
  await page.getByRole('button', { name: /全屏/u }).click()
  await expect(player).toHaveClass(/\bplayer-fullscreen\b/u)
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement))
    .toBeNull()
  box = await player.boundingBox()
  expect(box?.width).toBeCloseTo(2100, 0)
  expect(box?.height).toBeCloseTo(1300, 0)
  await expect(player.locator('.videoPlayerControls')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(player).not.toHaveClass(/\bplayer-fullscreen\b/u)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  box = await player.boundingBox()
  expect(box?.width).toBeLessThanOrEqual(389)
  expect((box?.width ?? 0) / (box?.height ?? 1)).toBeCloseTo(16 / 9, 2)
})

test('mobile video fullscreen targets the video element with the standard API', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get: () => window.__elytrueFullscreenElement ?? null,
    })
    HTMLElement.prototype.requestFullscreen = async function () {
      window.__elytrueFullscreenRequests ??= []
      window.__elytrueFullscreenRequests.push({
        video: this instanceof HTMLVideoElement,
        player: this.id === 'videoPlayerLayer',
      })
      window.__elytrueFullscreenElement = this
      document.dispatchEvent(new Event('fullscreenchange'))
    }
    document.exitFullscreen = async () => {
      window.__elytrueFullscreenElement = null
      document.dispatchEvent(new Event('fullscreenchange'))
    }
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', {
      configurable: true,
      value: undefined,
    })
  })
  await page.goto('/')
  await openThemeSelector(page)
  await page.locator('#themeList [data-theme="story-because-of-you"]').click()

  const player = page.locator('#videoPlayerLayer')
  const video = player.locator('video')
  await player.hover()
  await page.getByRole('button', { name: /全屏/u }).click()
  await expect(player).not.toHaveClass(/\bplayer-fullscreen\b/u)
  await expect
    .poll(() =>
      page.evaluate(() => ({
        targetIsVideo:
          document.fullscreenElement ===
          document.querySelector('#videoPlayerLayer video'),
        targetIsPlayer:
          document.fullscreenElement ===
          document.querySelector('#videoPlayerLayer'),
        requests: window.__elytrueFullscreenRequests ?? [],
      })),
    )
    .toEqual({
      targetIsVideo: true,
      targetIsPlayer: false,
      requests: [{ video: true, player: false }],
    })
  await expect(video).toBeVisible()
  await expect(page.getByRole('button', { name: /退出全屏/u })).toHaveCount(1)

  await page.getByRole('button', { name: /退出全屏/u }).click()
  await expect(player).not.toHaveClass(/\bplayer-fullscreen\b/u)
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement))
    .toBeNull()
  await expect(page.getByRole('button', { name: /全屏/u })).toHaveCount(1)
})

test('mobile video fullscreen uses the synchronous WebKit media fallback', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    HTMLElement.prototype.requestFullscreen = async function () {
      window.__elytrueStandardFullscreenRequests =
        (window.__elytrueStandardFullscreenRequests ?? 0) + 1
    }
    HTMLVideoElement.prototype.webkitEnterFullscreen = function () {
      window.__elytrueWebkitFullscreenTarget = this
      this.dispatchEvent(new Event('webkitbeginfullscreen'))
    }
    HTMLVideoElement.prototype.webkitExitFullscreen = function () {
      window.__elytrueWebkitFullscreenExits =
        (window.__elytrueWebkitFullscreenExits ?? 0) + 1
      this.dispatchEvent(new Event('webkitendfullscreen'))
    }
  })
  await page.goto('/')
  await openThemeSelector(page)
  await page.locator('#themeList [data-theme="story-because-of-you"]').click()

  const player = page.locator('#videoPlayerLayer')
  await player.hover()
  await page.getByRole('button', { name: /全屏/u }).click()
  await expect(player).not.toHaveClass(/\bplayer-fullscreen\b/u)
  await expect
    .poll(() =>
      page.evaluate(() => ({
        targetIsVideo:
          window.__elytrueWebkitFullscreenTarget ===
          document.querySelector('#videoPlayerLayer video'),
        standardRequests: window.__elytrueStandardFullscreenRequests ?? 0,
      })),
    )
    .toEqual({ targetIsVideo: true, standardRequests: 0 })
  await expect(page.getByRole('button', { name: /退出全屏/u })).toHaveCount(1)

  await page.getByRole('button', { name: /退出全屏/u }).click()
  await expect
    .poll(() => page.evaluate(() => window.__elytrueWebkitFullscreenExits ?? 0))
    .toBe(1)
  await expect(page.getByRole('button', { name: /全屏/u })).toHaveCount(1)
  await expect(player).not.toHaveClass(/\bplayer-fullscreen\b/u)
})
