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
  const csp = documentResponse?.headers()['content-security-policy'] ?? ''
  expect(csp).toContain("script-src 'self'")
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/u)
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

  const backgrounds = await page
    .locator('.mainbg[data-background-id]')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        id: element.dataset.backgroundId,
        layout: element.dataset.layout,
        source: element.dataset.src,
        original: element.dataset.original,
        focus: element.firstElementChild?.style.backgroundPosition,
      })),
    )
  expect(backgrounds).toHaveLength(16)
  expect(new Set(backgrounds.map((item) => item.id)).size).toBe(16)
  expect(backgrounds.find((item) => item.id === 'landscape2')).toMatchObject({
    layout: 'landscape',
    source: 'assets/elytrue-20260724/bg/landscape2.webp',
    original: 'assets/elytrue-20260724/originals/landscape2.png',
    focus: '38% 50%',
  })
})

test('theme, music, and language settings use the current local configuration', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('lang', 'en')
  })
  await page.goto('/')
  await expect(page.locator('#themeList > div')).toHaveCount(2)
  await expect(page.locator('#songList > li')).toHaveCount(10)
  await expect(page.locator('#themeTxt-default')).toContainText('Elysia')
  await expect
    .poll(() => page.locator('#langCSS').textContent())
    .toContain('.ui.en')
  await expect(page.locator('#musicAudio')).toHaveAttribute(
    'src',
    /HOYO-MiX(?:%20| )-(?:%20| )Elysian(?:%20| )Realm\.mp3/u,
  )
})
