import { expect, test } from '@playwright/test'

const BASE = 'http://127.0.0.1:4173'
const PASSWORD = 'auth-consistency-password-123'

async function reset(page) {
  await page.request.post('/__test/reset')
}

async function register(page, name, suffix) {
  const response = await page.request.post('/api/user/register', {
    data: {
      name,
      email: `${suffix}@example.com`,
      password: PASSWORD,
    },
    headers: {
      origin: BASE,
      'x-forwarded-for': `203.0.113.${suffix.length + name.length}`,
    },
  })
  expect(response.status()).toBe(201)
  return (await response.json()).data
}

async function login(page, identifier) {
  await page.locator('#userInfo').click()
  const popup = page.locator('#popups .loginPopup')
  await expect(popup).toBeVisible()
  await popup.locator('input').nth(0).fill(identifier)
  await popup.locator('input').nth(1).fill(PASSWORD)
  await popup.locator('.okBtn').click()
  await expect(popup).toHaveCount(0)
}

async function liftPanel(page) {
  await page.waitForFunction(
    () =>
      !document.getElementById('lowerPanel').classList.contains('animating'),
  )
  await page.mouse.move(640, 690)
  await expect
    .poll(() =>
      page
        .locator('#lowerPanel')
        .evaluate((panel) => panel.getBoundingClientRect().top),
    )
    .toBeLessThan(350)
}

test.beforeEach(async ({ page }) => reset(page))
test.afterEach(async ({ page }) => reset(page))

test('valid cookie recovers when the first authentication transport fails', async ({
  page,
}) => {
  const name = `认证重试_${Date.now().toString(36)}`
  await register(page, name, 'auth-retry')
  let meRequests = 0
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 503, message: 'offline', data: null }),
    }),
  )
  await page.route('**/api/user/me', async (route) => {
    meRequests += 1
    if (meRequests === 1) await route.abort('failed')
    else await route.continue()
  })

  await page.goto('/')
  await expect.poll(() => meRequests).toBe(1)
  await page.locator('#userInfo').click()

  await expect(page.locator('#userInfoName')).toHaveText(name)
  await expect.poll(() => meRequests).toBe(2)
})

test('viewer-likes 401 cannot undo a fresh login but a protected mutation 401 can', async ({
  page,
  context,
}) => {
  const owner = `点赞防御_${Date.now().toString(36)}`
  const session = await register(page, owner, 'likes-defense')
  const posted = await page.request.post('/api/comments/post', {
    data: { comment: '认证防御测试留言' },
    headers: {
      origin: BASE,
      'x-forwarded-for': '203.0.113.181',
      'x-csrf-token': session.csrfToken,
    },
  })
  expect(posted.status()).toBe(201)
  await context.clearCookies()

  const order = []
  await page.route('**/api/user/login', async (route) => {
    order.push('login')
    await route.continue()
  })
  await page.route('**/api/user/me', async (route) => {
    order.push('me')
    await route.continue()
  })
  await page.route('**/api/comments/viewer-likes*', async (route) => {
    order.push('likes')
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 401, message: 'expired', data: null }),
    })
  })
  await page.goto('/')
  await login(page, owner)

  await expect.poll(() => order.includes('likes')).toBe(true)
  expect(order.indexOf('login')).toBeLessThan(order.indexOf('me'))
  expect(order.indexOf('me')).toBeLessThan(order.indexOf('likes'))
  await expect(page.locator('#userInfoName')).toHaveText(owner)
  await expect(page.locator('#userInfo')).not.toHaveClass(/nologin/u)

  await page.route(/\/api\/comments\/like\?/, (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 401, message: 'expired', data: null }),
    }),
  )
  await page.locator('#comments .btn.like').first().dispatchEvent('click')
  await expect(page.locator('#userInfoName')).toHaveText(/访客/)
  await expect(page.locator('#userInfo')).toHaveClass(/nologin/u)
})

test('login hydrates likes without replacing a numbered historical view', async ({
  page,
  context,
}) => {
  const owner = `历史作者_${Date.now().toString(36)}`
  const ownerSession = await register(page, owner, 'history-owner')
  const posted = await page.request.post('/api/comments/post', {
    data: { comment: '必须保留的历史留言' },
    headers: {
      origin: BASE,
      'x-forwarded-for': '203.0.113.182',
      'x-csrf-token': ownerSession.csrfToken,
    },
  })
  expect(posted.status()).toBe(201)
  await context.clearCookies()
  const viewer = `历史访客_${Date.now().toString(36)}`
  await register(page, viewer, 'history-viewer')
  await context.clearCookies()
  await page.goto('/')
  await liftPanel(page)
  await page.locator('#menu').hover()
  const jump = page.waitForResponse((response) =>
    response.url().includes('number=1'),
  )
  await page.locator('#goto').fill('1')
  await page.locator('#goto').press('Enter')
  await jump
  await page.waitForTimeout(500)
  const card = page.locator('#comments .commentItem').first()
  const cardHandle = await card.elementHandle()

  let listRequestsAfterLogin = 0
  let loginStarted = false
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (
      loginStarted &&
      request.method() === 'GET' &&
      url.pathname === '/api/comments' &&
      !url.searchParams.has('uid')
    ) {
      listRequestsAfterLogin += 1
    }
  })
  loginStarted = true
  await login(page, viewer)
  await expect(page.locator('#comments .btn.report').first()).toBeVisible()

  expect(listRequestsAfterLogin).toBe(0)
  expect(
    await card.evaluate(
      (element, original) => element === original,
      cardHandle,
    ),
  ).toBe(true)
  await expect(card.locator('.comment')).toContainText('必须保留的历史留言')
})
