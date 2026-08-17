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
    likes: liked ? 1 : 0,
  }
}

function profile(name = '首屏用户') {
  return {
    id: 'bootstrap-user',
    uid: 102,
    name,
    avatar: '',
    role: 'user',
    csrfToken: 'user-me-csrf',
  }
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

function requestCounts(page) {
  const counts = {
    bootstrap: 0,
    fastComments: 0,
    comments: 0,
    count: 0,
    likes: 0,
    me: 0,
  }
  page.on('request', (request) => {
    if (request.method() !== 'GET') return
    const path = new URL(request.url()).pathname
    if (path === '/api/bootstrap') counts.bootstrap += 1
    if (path === '/api/comments/public-fast') counts.fastComments += 1
    if (path === '/api/comments/public') counts.comments += 1
    if (path === '/api/comments/count') counts.count += 1
    if (path === '/api/comments/viewer-likes') counts.likes += 1
    if (path === '/api/user/me') counts.me += 1
  })
  return counts
}

test('public comments start before the app module and render without auth or count', async ({
  page,
}) => {
  const counts = requestCounts(page)
  await page.route('**/api/comments/public*', (route) =>
    fulfill(
      route,
      { items: [comment(11)], hasMore: false, todayCount: 4 },
      { delay: 250 },
    ),
  )
  await page.route('**/api/user/me', (route) =>
    fulfill(route, null, { delay: 900 }),
  )
  await page.route('**/api/comments/count', (route) =>
    fulfill(route, 4, { delay: 1200 }),
  )

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  expect(counts.fastComments).toBe(1)
  expect(counts.comments).toBe(0)
  expect(counts.bootstrap).toBe(0)
  expect(counts.me).toBe(1)
  await expect(page.locator('#todayCommentCount')).toHaveText('4')
  expect(counts.count).toBe(0)

  const timings = await page.evaluate(() => {
    const at = (name) =>
      performance.getEntriesByName(name).at(-1)?.startTime ?? -1
    return {
      request: at('comments-request-start'),
      app: at('app-script-start'),
      response: at('comments-response'),
      state: at('comments-state-committed'),
      dom: at('initial-comment-dom-ready'),
    }
  })
  expect(timings.request).toBeLessThan(timings.app)
  expect(timings.state - timings.response).toBeLessThan(50)
  expect(timings.dom - timings.response).toBeLessThan(50)
})

test('cached comments render immediately and revalidate without replacing the card', async ({
  page,
}) => {
  const cached = comment(12)
  await page.addInitScript((record) => {
    sessionStorage.setItem(
      'elytrue:home-comments:v1',
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        items: [record],
        hasMore: false,
      }),
    )
  }, cached)
  await page.route('**/api/comments/public*', (route) =>
    fulfill(route, { items: [cached], hasMore: false }, { delay: 1500 }),
  )
  await page.route('**/api/user/me', (route) => fulfill(route, null))
  await page.route('**/api/comments/count', (route) => fulfill(route, 1))

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const card = page.locator('#comments .commentItem').first()
  await expect(card).toBeVisible({ timeout: 300 })
  const handle = await card.elementHandle()
  await expect(card).toHaveText(/首屏留言 12/u, { timeout: 2500 })
  expect(await card.evaluate((node, initial) => node === initial, handle)).toBe(
    true,
  )
  expect(await card.evaluate((node) => node.getAnimations().length)).toBe(0)
})

test('authentication and viewer likes progressively enhance the public list', async ({
  page,
}) => {
  const counts = requestCounts(page)
  await page.route('**/api/comments/public*', (route) =>
    fulfill(
      route,
      { items: [comment(13)], hasMore: false, todayCount: 1 },
      { delay: 100 },
    ),
  )
  await page.route('**/api/user/me', (route) =>
    fulfill(route, profile('认证用户'), { delay: 200 }),
  )
  await page.route('**/api/comments/count', (route) => fulfill(route, 1))
  await page.route('**/api/comments/viewer-likes*', (route) =>
    fulfill(route, [{ id: 13, liked: true }], { delay: 700 }),
  )

  await page.goto('/')
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  await expect(page.locator('#userInfoName')).toHaveText('认证用户')
  await expect(page.locator('#comments .btn.like')).toHaveClass(/liked/u)
  expect(counts).toEqual({
    bootstrap: 0,
    fastComments: 1,
    comments: 0,
    count: 0,
    likes: 1,
    me: 1,
  })
})

test('an early public failure retries once and user/me supplies mutation CSRF', async ({
  page,
}) => {
  const counts = requestCounts(page)
  let commentsAttempt = 0
  let csrf = ''
  await page.route('**/api/comments/public*', (route) => {
    commentsAttempt += 1
    return commentsAttempt === 1
      ? fulfill(route, null, { status: 503 })
      : fulfill(route, { items: [comment(15)], hasMore: false })
  })
  await page.route('**/api/user/me', (route) => fulfill(route, profile()))
  await page.route('**/api/comments/count', (route) => fulfill(route, 9))
  await page.route('**/api/comments/viewer-likes*', (route) =>
    fulfill(route, []),
  )
  await page.route('**/api/comments/like*', async (route) => {
    csrf = route.request().headers()['x-csrf-token'] ?? ''
    await fulfill(route, { liked: true, likes: 1 })
  })

  await page.goto('/')
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  expect(counts.fastComments).toBe(1)
  expect(counts.comments).toBe(1)
  expect(counts.bootstrap).toBe(0)
  await page.locator('#comments .btn.like').dispatchEvent('click')
  await expect.poll(() => csrf).toBe('user-me-csrf')
})
