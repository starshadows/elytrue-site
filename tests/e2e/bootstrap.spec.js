import { expect, test } from '@playwright/test'

function comment(id = 1, liked = false) {
  return {
    id,
    number: id,
    displayId: id,
    uid: 'bootstrap-user',
    sender: '首屏用户',
    avatar: '',
    comment: `首屏留言 ${id}`,
    image: '',
    replyid: null,
    time: Math.floor(Date.now() / 1000),
    hidden: false,
    liked,
    likes: 0,
  }
}

function profile(name = '首屏用户') {
  return { id: 'bootstrap-user', name, avatar: '', role: 'user' }
}

async function fulfill(route, data, { delay = 0, status = 200 } = {}) {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({
      code: status === 200 ? 1 : status,
      message: status === 200 ? 'OK' : '暂时不可用',
      data,
    }),
  })
}

function bootstrap(overrides = {}) {
  return {
    profile: null,
    comments: { items: [comment()], hasMore: false, todayCount: 1 },
    todayCount: 1,
    ...overrides,
  }
}

function requestCounts(page) {
  const counts = { bootstrap: 0, comments: 0, count: 0, likes: 0, me: 0 }
  page.on('request', (request) => {
    if (request.method() !== 'GET') return
    const path = new URL(request.url()).pathname
    if (path === '/api/bootstrap') counts.bootstrap += 1
    if (path === '/api/comments/public') counts.comments += 1
    if (path === '/api/comments/count') counts.count += 1
    if (path === '/api/comments/viewer-likes') counts.likes += 1
    if (path === '/api/user/me') counts.me += 1
  })
  return counts
}

test('cold bootstrap is the only first-screen request', async ({ page }) => {
  const counts = requestCounts(page)
  await page.route('**/api/bootstrap', (route) =>
    fulfill(
      route,
      bootstrap({
        comments: {
          items: [comment(11)],
          hasMore: false,
          todayCount: 4,
        },
        todayCount: 4,
      }),
      { delay: 300 },
    ),
  )
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  await expect(page.locator('#todayCommentCount')).toHaveText('4')
  expect(counts).toEqual({
    bootstrap: 1,
    comments: 0,
    count: 0,
    likes: 0,
    me: 0,
  })
  const delay = await page.evaluate(() => {
    const response = performance.getEntriesByName('bootstrap-response').at(-1)
    const commit = performance
      .getEntriesByName('comments-state-committed')
      .at(-1)
    return commit.startTime - response.startTime
  })
  expect(delay).toBeLessThan(50)
})

test('cache and profile hint render immediately and keep DOM identity', async ({
  page,
}) => {
  const cached = comment(12)
  await page.addInitScript(
    ({ record }) => {
      sessionStorage.setItem(
        'elytrue:home-comments:v1',
        JSON.stringify({
          version: 1,
          savedAt: Date.now(),
          items: [record],
          hasMore: false,
        }),
      )
      localStorage.setItem(
        'elytrue.profileHint',
        JSON.stringify({
          version: 1,
          userId: 'bootstrap-user',
          name: '缓存用户',
          avatar: '',
          savedAt: Date.now(),
        }),
      )
    },
    { record: cached },
  )
  await page.route('**/api/bootstrap', (route) =>
    fulfill(
      route,
      bootstrap({
        profile: profile('缓存用户'),
        csrfToken: 'cache-csrf',
        comments: { items: [cached], hasMore: false, todayCount: 1 },
      }),
      { delay: 2000 },
    ),
  )
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const card = page.locator('#comments .commentItem').first()
  const avatar = page.locator('#userInfoAvatar')
  await expect(card).toBeVisible({ timeout: 200 })
  await expect(page.locator('#userInfoName')).toHaveText('缓存用户', {
    timeout: 200,
  })
  const cardHandle = await card.elementHandle()
  const avatarHandle = await avatar.elementHandle()
  await expect(page.locator('#userInfo')).not.toHaveClass(/nologin/u, {
    timeout: 3000,
  })
  expect(
    await card.evaluate((node, initial) => node === initial, cardHandle),
  ).toBe(true)
  expect(
    await avatar.evaluate((node, initial) => node === initial, avatarHandle),
  ).toBe(true)
  expect(await card.evaluate((node) => node.getAnimations().length)).toBe(0)
})

test('authenticated bootstrap needs no user/me or viewer-like request', async ({
  page,
}) => {
  const counts = requestCounts(page)
  await page.route('**/api/bootstrap', (route) =>
    fulfill(
      route,
      bootstrap({
        profile: profile('认证用户'),
        csrfToken: 'auth-csrf',
        comments: {
          items: [comment(13, true)],
          hasMore: false,
          todayCount: 1,
        },
      }),
    ),
  )
  await page.goto('/')
  await expect(page.locator('#userInfoName')).toHaveText('认证用户')
  await expect(page.locator('#comments .btn.like')).toHaveClass(/liked/u)
  expect(counts.me).toBe(0)
  expect(counts.likes).toBe(0)
})

test('partial failures request only the failed branch', async ({ page }) => {
  const commentsCounts = requestCounts(page)
  await page.route('**/api/bootstrap', (route) =>
    fulfill(
      route,
      bootstrap({ comments: null, commentsError: true, todayCount: 6 }),
    ),
  )
  await page.route('**/api/comments/public*', (route) =>
    fulfill(route, { items: [comment(14)], hasMore: false }),
  )
  await page.goto('/')
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  expect(commentsCounts.comments).toBe(1)
  expect(commentsCounts.me).toBe(0)
  expect(commentsCounts.count).toBe(0)

  const profilePage = await page.context().newPage()
  const profileCounts = requestCounts(profilePage)
  await profilePage.route('**/api/bootstrap', (route) =>
    fulfill(route, bootstrap({ profile: { id: 1 } })),
  )
  await profilePage.route('**/api/user/me', (route) =>
    fulfill(route, { ...profile('资料回退用户'), csrfToken: 'fallback-csrf' }),
  )
  await profilePage.goto('/')
  await expect(profilePage.locator('#userInfoName')).toHaveText('资料回退用户')
  expect(profileCounts.me).toBe(1)
  expect(profileCounts.comments).toBe(0)
})

test('full failure runs fallbacks once and bootstrap CSRF hydrates mutations', async ({
  page,
}) => {
  const counts = requestCounts(page)
  await page.route('**/api/bootstrap', (route) =>
    fulfill(route, null, { status: 503 }),
  )
  await page.route('**/api/user/me', (route) => fulfill(route, null))
  await page.route('**/api/comments/public*', (route) =>
    fulfill(route, { items: [comment(15)], hasMore: false }),
  )
  await page.route('**/api/comments/count', (route) => fulfill(route, 9))
  await page.goto('/')
  await expect(page.locator('#todayCommentCount')).toHaveText('9')
  expect(counts).toEqual({
    bootstrap: 1,
    comments: 1,
    count: 1,
    likes: 0,
    me: 1,
  })

  const authPage = await page.context().newPage()
  let csrf = ''
  await authPage.route('**/api/bootstrap', (route) =>
    fulfill(
      route,
      bootstrap({
        profile: profile(),
        csrfToken: 'bootstrap-csrf-token',
        comments: { items: [comment(16)], hasMore: false, todayCount: 1 },
      }),
    ),
  )
  await authPage.route('**/api/comments/like*', async (route) => {
    csrf = route.request().headers()['x-csrf-token'] ?? ''
    await fulfill(route, { liked: true, likes: 1 })
  })
  await authPage.goto('/')
  await authPage.locator('#comments .btn.like').dispatchEvent('click')
  await expect.poll(() => csrf).toBe('bootstrap-csrf-token')
})
