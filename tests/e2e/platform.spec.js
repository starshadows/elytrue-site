import { expect, test } from '@playwright/test'

test.beforeEach(async ({ page, context }) => {
  await page.request.post('/__test/reset')
  await context.clearCookies()
  await page.addInitScript(() => {
    Math.random = () => 0
  })
})

test('SPA fallback does not shadow /api routes', async ({ page }) => {
  const documentResponse = await page.goto('/nested/client/route')
  expect(documentResponse?.status()).toBe(200)
  await expect(page.locator('#app')).toHaveAttribute('data-v-app', '')

  const health = await page.request.get('/api/health')
  expect(health.headers()['content-type']).toContain('application/json')
  expect((await health.json()).data.service).toBe('elytrue-edgeone')

  const missing = await page.request.get('/api/not-a-route')
  expect(missing.status()).toBe(404)
  expect(missing.headers()['content-type']).toContain('application/json')
  expect((await missing.json()).message).toBe('接口不存在')
})

test('PWA manifest and current asset metadata stay complete', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/index.manifest.json',
  )
  const manifest = await (await page.request.get('/index.manifest.json')).json()
  expect(manifest.name).toBe('星花札记')
  expect(manifest.start_url).toBe('/')
  expect(manifest.icons).toHaveLength(1)
  expect(manifest.icons[0]).toMatchObject({
    src: 'assets/elytrue-shell-20260805/favicon-320-c998712d.png',
    sizes: '320x320',
    type: 'image/png',
  })
  expect(
    (await page.request.get(`/${manifest.icons[0].src}`)).headers()[
      'content-type'
    ],
  ).toContain('image/png')
  expect(
    (
      await page.request.get(
        '/assets/elytrue-shell-20260805/default-avatar-320-dd2f4539.png',
      )
    ).headers()['content-type'],
  ).toContain('image/png')

  const backgrounds = await page
    .locator('.mainbg[data-theme-id^="auto-"]')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.dataset.backgroundId,
        layout: element.dataset.layout,
        source: element.dataset.src,
        original: element.dataset.original,
        focus: element.firstElementChild?.style.backgroundPosition,
      })),
    )
  expect(backgrounds).toHaveLength(28)
  expect(new Set(backgrounds.map((item) => item.id)).size).toBe(28)
  expect(backgrounds.find((item) => item.id === 'landscape2')).toMatchObject({
    layout: 'landscape',
    source: 'assets/elytrue-20260817/bg/auto/landscape/landscape2.webp',
    original: 'assets/elytrue-20260817/originals/auto/landscape/landscape2.jpg',
    focus: '38% 50%',
  })
  const imagePreloads = await page
    .locator('link[rel="preload"][as="image"]')
    .evaluateAll((links) =>
      links.map((link) => ({
        href: link.getAttribute('href'),
        media: link.getAttribute('media'),
        type: link.getAttribute('type'),
        fetchpriority: link.getAttribute('fetchpriority'),
      })),
    )
  expect(imagePreloads).toEqual([
    {
      href: '/assets/elytrue-20260817/bg/auto/landscape/landscape1.webp',
      media: null,
      type: 'image/webp',
      fetchpriority: 'high',
    },
  ])
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-background-id',
    'landscape1',
  )
})

test('mobile uses the matching early-selected background', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-background-id',
    'portrait1',
  )
})

test('first hero handoff keeps opacity constant and only scales', async ({
  page,
}) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const animation = await page
    .locator('.mainbg.visible')
    .evaluate((element) => {
      const layer = element.firstElementChild
      const effect = layer
        ?.getAnimations()
        .find((item) => item.animationName === 'bgzoom16')?.effect
      return {
        outerOpacity: getComputedStyle(element).opacity,
        outerTransition: getComputedStyle(element).transitionDuration,
        layerOpacity: layer ? getComputedStyle(layer).opacity : null,
        keyframes:
          effect?.getKeyframes().map(({ opacity, transform }) => ({
            opacity,
            transform,
          })) ?? [],
      }
    })

  expect(animation.outerOpacity).toBe('1')
  expect(animation.outerTransition).toBe('0s')
  expect(animation.layerOpacity).toBe('1')
  expect(animation.keyframes).toEqual([
    { opacity: undefined, transform: 'scale(1.6)' },
    { opacity: undefined, transform: 'scale(1.15)' },
    { opacity: undefined, transform: 'scale(1)' },
  ])
})

test('a reload can choose another valid hero without cache-busting its URL', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-background-id',
    'landscape1',
  )
  await page.addInitScript(() => {
    Math.random = () => 0.999
  })
  await page.reload()
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-background-id',
    'official-landscape-封面',
  )
  const href = await page
    .locator('link[rel="preload"][as="image"]')
    .getAttribute('href')
  expect(href).toBe('/assets/elytrue-20260817/bg/auto/landscape/封面.webp')
  expect(href).not.toContain('?')
})

test('first-screen network prioritizes the selected hero and public comments over music', async ({
  page,
}) => {
  const audioRequests = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('.mp3')) {
      audioRequests.push(request.url())
    }
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('.mainbg.visible')).toHaveAttribute(
    'data-background-id',
    'landscape1',
  )
  await page.waitForTimeout(500)

  const timings = await page.evaluate(() => {
    const resources = performance.getEntriesByType('resource')
    const startedAt = (suffix) =>
      resources.find((entry) => new URL(entry.name).pathname.endsWith(suffix))
        ?.startTime ?? -1
    return {
      background: startedAt('/bg/auto/landscape/landscape1.webp'),
      comments: startedAt('/api/comments/public'),
      backgrounds: resources
        .map((entry) => new URL(entry.name).pathname)
        .filter((pathname) =>
          /\/bg\/auto\/(?:landscape|portrait)\/[^/]+\.webp$/u.test(pathname),
        ),
    }
  })
  expect(timings.background).toBeGreaterThanOrEqual(0)
  expect(timings.comments).toBeGreaterThanOrEqual(timings.background)
  const loadedBackgrounds = new Set(timings.backgrounds)
  expect(loadedBackgrounds.size).toBe(2)
  expect(loadedBackgrounds).toContain(
    '/assets/elytrue-20260817/bg/auto/landscape/landscape1.webp',
  )
  expect(
    [...loadedBackgrounds].some((path) =>
      /\/bg\/auto\/portrait\/[^/]+\.webp$/u.test(path),
    ),
  ).toBe(true)
  expect(audioRequests).toEqual([])
})

test('theme, music, and language settings use the current local configuration', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en')
    localStorage.setItem('mutebgm', 'true')
  })
  await page.goto('/')
  await expect(page.locator('#themeList > div')).toHaveCount(9)
  await expect(page.locator('#songList > li')).toHaveCount(11)
  await expect(page.locator('#themeTxt-auto-landscape')).toHaveText(
    '爱莉希雅爱莉希雅',
  )
  await expect(page.locator('#themeTxt-auto-landscape')).not.toContainText(
    /Auto|Elysia/u,
  )
  await expect
    .poll(() => page.locator('#langCSS').textContent())
    .toContain('.ui.en')
  await expect(page.locator('#musicAudio')).toHaveAttribute('preload', 'none')
  await expect(page.locator('#musicAudio')).not.toHaveAttribute('src', /.+/u)
  expect(
    await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .some((entry) => entry.name.includes('jsmediatags')),
    ),
  ).toBe(false)
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await expect(page.locator('#musicAudio')).toHaveAttribute(
    'src',
    /HOYO-MiX(?:%20| )-(?:%20| )Elysian(?:%20| )Realm\.mp3/u,
  )
  await expect(page.locator('#musicImg')).toHaveAttribute('src', /^blob:/u)
  const firstCover = await page.locator('#musicImg').getAttribute('src')
  expect(firstCover).toBeTruthy()
  await page.locator('#songList > li').nth(1).dispatchEvent('click')
  await expect(page.locator('#musicImg')).toHaveAttribute('src', /^blob:/u)
  await expect
    .poll(() => page.locator('#musicImg').getAttribute('src'))
    .not.toBe(firstCover)
  expect(
    await page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const image = new Image()
          image.onload = () => resolve(true)
          image.onerror = () => resolve(false)
          image.src = url
        }),
      firstCover,
    ),
  ).toBe(true)
  await page.waitForTimeout(1_100)
  expect(
    await page.evaluate(
      (url) =>
        new Promise((resolve) => {
          const image = new Image()
          image.onload = () => resolve(true)
          image.onerror = () => resolve(false)
          image.src = url
        }),
      firstCover,
    ),
  ).toBe(false)
})
