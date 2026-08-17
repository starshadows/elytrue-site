import { expect, test } from '@playwright/test'

async function expectBaseline(page, name) {
  await page.locator('#mainCaptions').evaluate((element) => {
    element.style.visibility = 'hidden'
  })
  await expect(page).toHaveScreenshot(`${name}.png`, {
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.003,
  })
}

async function waitForCommentImages(page) {
  await page.locator('#comments img').evaluateAll(async (images) => {
    await Promise.all(
      images.map(async (image) => {
        if (!image.complete) {
          await new Promise((resolve) => {
            image.addEventListener('load', resolve, { once: true })
            image.addEventListener('error', resolve, { once: true })
          })
        }
        await image.decode?.().catch(() => undefined)
      }),
    )
  })
}

async function setVisualBaselineBackground(page, source, position) {
  await page.locator('.mainbg.visible > div').evaluate(
    async (element, background) => {
      const image = new Image()
      image.src = background.source
      await image.decode()
      element.style.backgroundImage = `url("${background.source}")`
      element.style.backgroundPosition = background.position
    },
    { source, position },
  )
}

async function setPinnedBaselineBackground(page) {
  await page.locator('#topComment .bg').evaluate(async (image) => {
    image.src = '/assets/elytrue-20260817-fmp4/bg/auto/portrait/portrait1.webp'
    if (!image.complete) {
      await new Promise((resolve) => {
        image.addEventListener('load', resolve, { once: true })
        image.addEventListener('error', resolve, { once: true })
      })
    }
    await image.decode?.().catch(() => undefined)
  })
}

test.beforeEach(async ({ page, context }) => {
  await page.request.post('/__test/reset')
  await context.clearCookies()
  await page.addInitScript(() => {
    Math.random = () => 0
  })
})

test('desktop home matches the current media visual baseline', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')
  await expect(page.locator('#userInfoName')).toHaveText(/访客/)
  await page.evaluate(() => document.fonts.ready)
  await setVisualBaselineBackground(
    page,
    '/assets/elytrue-20260817-fmp4/bg/auto/landscape/landscape2.webp',
    '38% 50%',
  )
  await setPinnedBaselineBackground(page)
  await expectBaseline(page, 'desktop-home')
})

test('mobile home matches the current media visual baseline', async ({
  page,
}) => {
  const register = await page.request.post('/api/user/register', {
    data: {
      name: '视觉基线用户',
      email: 'visual-baseline@example.com',
      password: 'visual-baseline-password-123',
    },
    headers: { origin: 'http://127.0.0.1:4173' },
  })
  expect(register.status()).toBe(201)
  const registered = await register.json()
  const posted = await page.request.post('/api/comments/post', {
    data: { comment: '愿花与星辉伴你同行♪', image: [] },
    headers: {
      origin: 'http://127.0.0.1:4173',
      'x-csrf-token': registered.data.csrfToken,
    },
  })
  expect(posted.status()).toBe(201)
  await page.context().clearCookies()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await expect(page.locator('#userInfoName')).toHaveText(/访客/)
  await page.evaluate(() => document.fonts.ready)
  await setVisualBaselineBackground(
    page,
    '/assets/elytrue-20260817-fmp4/bg/auto/portrait/portrait2.webp',
    '50% 50%',
  )
  await page
    .locator('#comments .commentItem .bg')
    .first()
    .evaluate(
      (image) =>
        (image.src =
          '/assets/elytrue-20260817-fmp4/bg/auto/portrait/portrait2.webp'),
    )
  await setPinnedBaselineBackground(page)
  await waitForCommentImages(page)
  await expectBaseline(page, 'mobile-home')
})
