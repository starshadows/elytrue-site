import { test, expect } from '@playwright/test'

const BASE = 'http://127.0.0.1:4173'
const PASSWORD = 'e2e-test-password-123'

test.afterAll(async ({ request }) => {
  const response = await request.post('/__test/reset')
  expect(response.ok()).toBeTruthy()
})

const unique = (prefix) =>
  `${prefix}_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`

/**
 * 与 site.spec.js 相同的面板抬起逻辑:悬停面板上部条带,
 * 并等入场动画结束后再与留言区交互。
 */
async function liftPanel(page) {
  await page.waitForFunction(
    () =>
      !document.getElementById('lowerPanel').classList.contains('animating'),
    null,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(300)
  await page.mouse.move(640, 690)
  await page.waitForFunction(
    () => {
      const panel = document.getElementById('lowerPanel')
      return panel.matches(':hover') && panel.getBoundingClientRect().top < 350
    },
    null,
    { timeout: 5000 },
  )
  await page.waitForTimeout(300)
}

/**
 * 注册并保持登录(每个测试自建用户,不依赖测试间共享状态)。
 */
async function registerAndStayLoggedIn(page, name) {
  await page.goto('/')
  await page.locator('#userInfo').click()
  const popup = page.locator('#popups .loginPopup')
  await page.getByText(/第一次来/).click()
  await expect(popup.locator('h2')).toContainText('注册账号')
  await popup.locator('input').nth(0).fill(name)
  await popup
    .locator('input')
    .nth(1)
    .fill(`${name.replace(/[^\x00-\x7F]/gu, 'p')}_${Date.now()}@example.com`)
  await popup.locator('input').nth(2).fill(PASSWORD)
  await popup.locator('input').nth(3).fill(PASSWORD)
  await popup.locator('.okBtn').click()
  const recoveryPopup = page.locator('#popups .recoveryKeyPopup')
  await expect(recoveryPopup).toBeVisible()
  await recoveryPopup.locator('.recoveryConfirmation input').check()
  await recoveryPopup.getByTestId('confirm-recovery-key').click()
  await expect(page.locator('#popups .popupContainer')).toHaveCount(0)
}

async function postViaApi(page, comment, index = 0) {
  const me = await page.request.get('/api/user/me', {
    headers: { origin: BASE },
  })
  const csrf = (await me.json()).data.csrfToken
  const posted = await page.request.post('/api/comments/post', {
    data: { comment },
    headers: {
      origin: BASE,
      // 每个帖子用独立模拟 IP,规避 mock 的 comment 限流(10 条/10 分钟/身份)
      'x-forwarded-for': `203.0.113.${90 + (index % 200)}`,
      'x-csrf-token': csrf,
    },
  })
  expect(posted.ok()).toBeTruthy()
}

function commentPayload(id = 1) {
  return {
    id,
    number: id,
    displayId: id,
    uid: 'perf-user',
    sender: '性能用户',
    avatar: '',
    comment: `性能留言 ${id}`,
    image: '',
    replyid: null,
    time: Math.floor(Date.now() / 1000),
    hidden: false,
    liked: false,
    likes: 0,
  }
}

async function fulfillBootstrap(
  route,
  { delay = 0, items = [commentPayload()] } = {},
) {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: {
      'Server-Timing':
        'auth;dur=1, routing;dur=1, index;dur=2, commentBodies;dur=3, likes;dur=1, replyPreviews;dur=0, todayCount;dur=1, serialization;dur=1, total;dur=9',
    },
    body: JSON.stringify({
      code: 1,
      message: 'OK',
      data: {
        profile: null,
        comments: { items, hasMore: false, todayCount: items.length },
      },
    }),
  })
}

test('首次加载:无 direction 请求、今日数量已合并、主留言区无旋转加载圈', async ({
  page,
}) => {
  await registerAndStayLoggedIn(page, unique('性能旅人'))
  for (let index = 0; index < 3; index += 1) {
    await postViaApi(page, `性能回归留言 ${index} ${Date.now()}`, index)
  }

  let directionAfterRequests = 0
  let directionBeforeRequests = 0
  let countRequests = 0
  let mainListRequests = 0
  let bootstrapRequests = 0
  await page.route('**/api/bootstrap', async (route) => {
    bootstrapRequests += 1
    await route.continue()
  })
  await page.route('**/api/comments*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/comments') {
      mainListRequests += 1
      if (url.searchParams.get('direction') === 'after')
        directionAfterRequests += 1
      if (url.searchParams.get('direction') === 'before')
        directionBeforeRequests += 1
    }
    if (url.pathname === '/api/comments/count') countRequests += 1
    await route.continue()
  })

  await page.reload()
  await liftPanel(page)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()

  expect(directionAfterRequests).toBe(0)
  expect(directionBeforeRequests).toBe(0)
  expect(bootstrapRequests).toBe(1)
  expect(mainListRequests).toBe(0)
  expect(countRequests).toBe(0)
  await expect(page.locator('#comments .loadingCircle')).toHaveCount(0)
  await expect(page.locator('#comments .paginationSentinel')).toHaveCount(2)

  await page.waitForTimeout(5000)
  expect(directionAfterRequests).toBe(0)
  expect(directionBeforeRequests).toBe(0)
  expect(mainListRequests).toBe(0)
})

test('滚动到最旧一端只请求一次历史,5 秒空闲后不循环分页', async ({ page }) => {
  await registerAndStayLoggedIn(page, unique('性能旅人'))
  for (let index = 0; index < 35; index += 1) {
    await postViaApi(page, `历史分页 ${index} ${Date.now()}`, index)
  }

  let beforeRequests = 0
  await page.route('**/api/comments*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (
      request.method() === 'GET' &&
      url.pathname === '/api/comments' &&
      url.searchParams.get('direction') === 'before'
    ) {
      beforeRequests += 1
    }
    await route.continue()
  })

  await page.reload()
  await liftPanel(page)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()

  await page.evaluate(() => {
    const container = document.getElementById('comments')
    container.scrollLeft = container.scrollWidth
  })
  await expect.poll(() => beforeRequests).toBe(1)
  await page.waitForTimeout(5000)
  expect(beforeRequests).toBe(1)
})

test('置顶卡片与首条普通留言在 50ms 内开始同一入场动画', async ({ page }) => {
  await registerAndStayLoggedIn(page, unique('性能旅人'))
  await postViaApi(page, `动画配置 ${Date.now()}`)
  await page.reload()
  await liftPanel(page)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()

  const animationState = await page.evaluate(() => {
    const pinned = document.getElementById('topComment')
    const first = document.querySelector('#comments .commentItem')
    const sentinels = [
      ...document.querySelectorAll('#comments .paginationSentinel'),
    ].map((el) => getComputedStyle(el).animationName)
    return {
      pinned: getComputedStyle(pinned).animationName,
      first: first ? getComputedStyle(first).animationName : '',
      sentinels,
      pinnedStart: performance.getEntriesByName('pinned-animation-start').at(-1)
        ?.startTime,
      firstStart: performance
        .getEntriesByName('first-comment-animation-start')
        .at(-1)?.startTime,
    }
  })
  expect(animationState.pinned).toBeTruthy()
  expect(animationState.first).toBe(animationState.pinned)
  expect(animationState.sentinels.every((name) => name === 'none')).toBe(true)
  expect(animationState.pinnedStart).toBeTruthy()
  expect(animationState.firstStart).toBeTruthy()
  expect(
    Math.abs(animationState.pinnedStart - animationState.firstStart),
  ).toBeLessThan(50)
})

test('200ms 首次请求不显示加载提示', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    fulfillBootstrap(route, { delay: 200 }),
  )
  await page.goto('/')
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  await expect(page.locator('#commentsLoadingHint')).toHaveCount(0)
  await expect(page.locator('#comments .loadingCircle')).toHaveCount(0)
})

test('800ms 首次请求只显示一个非阻塞提示', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    fulfillBootstrap(route, { delay: 800 }),
  )
  await page.goto('/')
  await page.waitForTimeout(500)
  await expect(page.locator('#commentsLoadingHint')).toHaveCount(1)
  await expect(page.locator('#comments .loadingCircle')).toHaveCount(0)
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  await expect(page.locator('#commentsLoadingHint')).toHaveCount(0)
})

test('首次请求失败仍显示置顶、错误状态和可用重试', async ({ page }) => {
  await page.route('**/api/bootstrap', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ code: 500, message: '暂时不可用', data: null }),
    }),
  )
  await page.route('**/api/comments', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 1,
        message: 'OK',
        data: {
          items: [commentPayload(2)],
          hasMore: false,
          todayCount: 1,
        },
      }),
    }),
  )
  await page.goto('/')
  await expect(page.locator('#topComment')).toBeVisible()
  await expect(page.locator('.commentsLoadError')).toBeVisible()
  await liftPanel(page)
  await page.locator('.commentsLoadError button').click()
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
})

test('认证未决时重复点击只保留一个弹窗和一个 bootstrap 请求', async ({
  page,
}) => {
  let bootstrapRequests = 0
  await page.route('**/api/bootstrap', async (route) => {
    bootstrapRequests += 1
    await fulfillBootstrap(route, { delay: 800, items: [] })
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const started = Date.now()
  await page.locator('#userInfo').dispatchEvent('click')
  await page.locator('#userInfo').dispatchEvent('click')
  await expect(page.locator('#popups .userHome')).toBeVisible({ timeout: 100 })
  expect(Date.now() - started).toBeLessThan(100)
  await expect(page.locator('#popups .userHome')).toHaveCount(1)
  await page.waitForTimeout(900)
  expect(bootstrapRequests).toBe(1)
  await expect(page.locator('#popups .loginPopup')).toBeVisible()
})

test('注册刷新不复用注册前仍未完成的匿名 bootstrap', async ({ page }) => {
  let releaseBootstrap = () => {}
  const bootstrapGate = new Promise((resolve) => {
    releaseBootstrap = resolve
  })
  let meRequests = 0
  await page.route('**/api/bootstrap', async (route) => {
    await bootstrapGate
    await fulfillBootstrap(route, { items: [] })
  })
  await page.route('**/api/user/me', async (route) => {
    meRequests += 1
    await route.continue()
  })

  const name = unique('并发注册旅人')
  await page.goto('/#popup-loginPopup', { waitUntil: 'domcontentloaded' })
  const popup = page.locator('#popups .loginPopup')
  await expect(popup).toBeVisible()
  await page.getByText(/第一次来/).click()
  await popup.locator('input').nth(0).fill(name)
  await popup
    .locator('input')
    .nth(1)
    .fill(`bootstrap_race_${Date.now()}@example.com`)
  await popup.locator('input').nth(2).fill(PASSWORD)
  await popup.locator('input').nth(3).fill(PASSWORD)
  await popup.locator('.okBtn').click()

  const recoveryPopup = page.locator('#popups .recoveryKeyPopup')
  await expect(recoveryPopup).toBeVisible()
  await expect.poll(() => meRequests).toBe(1)
  releaseBootstrap()
  await recoveryPopup.locator('.recoveryConfirmation input').check()
  await recoveryPopup.getByTestId('confirm-recovery-key').click()
  await expect(page.locator('#userInfoName')).toHaveText(name)
})

test('reduced-motion 不强制执行留言入场动画', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/bootstrap', (route) => fulfillBootstrap(route))
  await page.goto('/')
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  const state = await page.evaluate(() => ({
    pinnedAnimations: document.getElementById('topComment')?.getAnimations()
      .length,
    firstAnimations: document
      .querySelector('#comments .commentItem')
      ?.getAnimations().length,
    forcedMarks:
      performance.getEntriesByName('pinned-animation-start').length +
      performance.getEntriesByName('first-comment-animation-start').length,
  }))
  expect(state.pinnedAnimations).toBe(0)
  expect(state.firstAnimations).toBe(0)
  expect(state.forcedMarks).toBe(0)
})

test('发布新留言只新增一张卡片,已有卡片不重新播放动画', async ({ page }) => {
  await registerAndStayLoggedIn(page, unique('性能旅人'))
  await postViaApi(page, `动画回归 ${Date.now()}`)
  await page.reload()
  await liftPanel(page)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()
  await page.waitForTimeout(700)

  const before = await page.evaluate(() => ({
    count: document.querySelectorAll('#comments .commentItem').length,
    running: [...document.querySelectorAll('#comments .commentItem')].map(
      (el) => el.getAnimations().length,
    ),
  }))
  expect(before.count).toBeGreaterThan(0)
  expect(before.running.every((count) => count === 0)).toBe(true)

  await page.locator('#newMsg').click()
  const msgText = page.locator('#msgText')
  await expect(msgText).toBeVisible()
  await msgText.click()
  await page.keyboard.type(`动画回归 ${Date.now()}`)
  await page.locator('#sendBtn').click()
  await expect(page.locator('#newCommentBox')).toHaveCount(0)
  await expect(page.locator('#comments .commentItem')).toHaveCount(
    before.count + 1,
  )

  const after = await page.evaluate(() => ({
    running: [...document.querySelectorAll('#comments .commentItem')].map(
      (el) => el.getAnimations().length,
    ),
  }))
  expect(after.running[0]).toBeGreaterThanOrEqual(1)
  expect(after.running.slice(1).every((count) => count === 0)).toBe(true)
})

test('点击头像后弹窗立即出现,且同一弹窗可见的加载反馈最多一个', async ({
  page,
}) => {
  await registerAndStayLoggedIn(page, unique('性能旅人'))
  await postViaApi(page, `弹窗加载回归 ${Date.now()}`)
  await page.reload()
  let meRequests = 0
  await page.route('**/api/user/me', async (route) => {
    meRequests += 1
    await route.continue()
  })
  await page.route('**/api/comments*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 800))
    await route.continue()
  })
  await liftPanel(page)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()

  await page.locator('#userInfo').click()
  const userHome = page.locator('#popups .userHome')
  await expect(userHome).toBeVisible({ timeout: 100 })
  await expect(userHome.locator('.userinfo')).toBeVisible()
  expect(meRequests).toBe(0)

  const loaderState = await page.evaluate(async () => {
    let maxCircles = 0
    let maxHints = 0
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      maxCircles = Math.max(
        maxCircles,
        document.querySelectorAll('#popups .loadingCircle').length,
      )
      maxHints = Math.max(
        maxHints,
        document.querySelectorAll('#popups .userCommentsLoading').length,
      )
    }
    return { maxCircles, maxHints }
  })
  expect(loaderState.maxCircles).toBe(0)
  expect(loaderState.maxHints).toBe(1)
})

test('用户留言首个可见页为空时沿游标继续加载', async ({ page }) => {
  await registerAndStayLoggedIn(page, unique('隐藏分页旅人'))
  let userPageRequests = 0
  await page.route('**/api/comments*', async (route) => {
    const url = new URL(route.request().url())
    if (route.request().method() !== 'GET' || !url.searchParams.has('uid')) {
      await route.continue()
      return
    }
    userPageRequests += 1
    const cursor = url.searchParams.get('cursor')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 1,
        message: 'OK',
        data: cursor
          ? {
              items: [
                {
                  id: 9,
                  number: 9,
                  comment: '隐藏页之后的可见留言',
                  image: '',
                  time: Math.floor(Date.now() / 1000),
                },
              ],
              hasMore: false,
              nextCursor: null,
            }
          : { items: [], hasMore: true, nextCursor: 'hidden-page' },
      }),
    })
  })

  await page.locator('#userInfo').click()
  const userHome = page.locator('#popups .userHome')
  await expect(userHome.getByText('隐藏页之后的可见留言')).toBeVisible()
  expect(userPageRequests).toBe(2)
})
