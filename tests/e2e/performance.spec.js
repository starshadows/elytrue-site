import { test, expect } from '@playwright/test'

const BASE = 'http://127.0.0.1:4173'
const PASSWORD = 'e2e-test-password-123'
const AVATAR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

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

function commentPayload(id = 1, avatar = '') {
  return {
    id,
    number: id,
    displayId: id,
    uid: 'perf-user',
    sender: '性能用户',
    avatar,
    comment: `性能留言 ${id}`,
    image: '',
    replyid: null,
    time: Math.floor(Date.now() / 1000),
    hidden: false,
    liked: false,
    likes: 0,
  }
}

function seedHomeComments(page, items, savedAt = Date.now()) {
  return page.addInitScript(
    ({ items: cachedItems, savedAt: cacheTime }) => {
      sessionStorage.setItem(
        'elytrue:home-comments:v1',
        JSON.stringify({
          version: 1,
          savedAt: cacheTime,
          items: cachedItems,
          hasMore: false,
        }),
      )
    },
    { items, savedAt },
  )
}

async function fulfillComments(
  route,
  { delay = 0, items = [commentPayload()], status = 200 } = {},
) {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'Server-Timing':
        'routing;dur=1, index;dur=2, commentBodies;dur=3, likes;dur=1, replyPreviews;dur=0, serialization;dur=1, total;dur=8',
    },
    body: JSON.stringify({
      code: status === 200 ? 1 : status,
      message: status === 200 ? 'OK' : '暂时不可用',
      data: status === 200 ? { items, hasMore: false } : null,
    }),
  })
}

async function fulfillMe(
  route,
  { delay = 0, profile = null, status = 200 } = {},
) {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  await route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'Server-Timing':
        'routing;dur=1, session;dur=1, user;dur=1, adminMarker;dur=1, sessionRefresh;dur=0, serialization;dur=1, total;dur=5',
    },
    body: JSON.stringify({
      code: status === 200 ? 1 : status,
      message: status === 200 ? 'OK' : '请先登录',
      data: status === 200 ? profile : null,
    }),
  })
}

async function fulfillAvatar(route, { delay = 0, status = 200 } = {}) {
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
  await route.fulfill({
    status,
    contentType: 'image/png',
    body: status === 200 ? AVATAR_PNG : undefined,
  })
}

function profilePayload(name = '缓存用户', avatar = '') {
  return {
    id: 'perf-user',
    name,
    avatar,
    role: 'user',
    csrfToken: 'test-csrf-token',
  }
}

function installProfileHint(page, name = '缓存用户', avatar = '') {
  return page.addInitScript(
    ({ cachedName, cachedAvatar }) => {
      localStorage.setItem(
        'elytrue.profileHint',
        JSON.stringify({
          version: 1,
          userId: 'perf-user',
          name: cachedName,
          avatar: cachedAvatar,
          savedAt: Date.now(),
        }),
      )
    },
    { cachedName: name, cachedAvatar: avatar },
  )
}

test('首次加载:认证、公共留言和统计各自单飞且不误触分页', async ({ page }) => {
  let directionAfterRequests = 0
  let directionBeforeRequests = 0
  let countRequests = 0
  let mainListRequests = 0
  let publicListRequests = 0
  let meRequests = 0
  let viewerLikeRequests = 0
  let bootstrapRequests = 0
  await page.route('**/api/bootstrap', async (route) => {
    bootstrapRequests += 1
    await route.continue()
  })
  await page.route('**/api/user/me', async (route) => {
    meRequests += 1
    await fulfillMe(route, { profile: profilePayload() })
  })
  await page.route(/\/api\/comments(?:\/[^?]+)?(?:\?.*)?$/u, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/comments') {
      mainListRequests += 1
      if (url.searchParams.get('direction') === 'after')
        directionAfterRequests += 1
      if (url.searchParams.get('direction') === 'before')
        directionBeforeRequests += 1
    }
    if (url.pathname === '/api/comments/public') publicListRequests += 1
    if (url.pathname === '/api/comments/count') countRequests += 1
    if (url.pathname === '/api/comments/viewer-likes') viewerLikeRequests += 1
    if (url.pathname === '/api/comments/public') {
      await fulfillComments(route, { items: [commentPayload(3)] })
      return
    }
    if (url.pathname === '/api/comments/count') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 1, message: 'OK', data: 3 }),
      })
      return
    }
    if (url.pathname === '/api/comments/viewer-likes') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 1, message: 'OK', data: [] }),
      })
      return
    }
    await fulfillComments(route, { items: [] })
  })

  await page.goto('/')
  await liftPanel(page)

  expect(directionAfterRequests).toBe(0)
  expect(directionBeforeRequests).toBe(0)
  expect(publicListRequests).toBe(1)
  expect(mainListRequests).toBe(0)
  await expect.poll(() => countRequests).toBe(1)
  await expect.poll(() => viewerLikeRequests).toBe(1)
  expect(bootstrapRequests).toBe(0)
  expect(meRequests).toBe(1)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()
  await expect(page.locator('#comments .loadingCircle')).toHaveCount(0)
  await expect(page.locator('#comments .paginationSentinel')).toHaveCount(2)

  await page.waitForTimeout(5000)
  expect(directionAfterRequests).toBe(0)
  expect(directionBeforeRequests).toBe(0)
  expect(mainListRequests).toBe(0)
})

test('页面首次入场独立于认证和留言请求,且只播放一次', async ({ page }) => {
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, { delay: 1500 }),
  )
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { delay: 1500 }),
  )

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const state = await page.evaluate(() => {
    const panel = document.getElementById('lowerPanel')
    const animation = panel
      ?.getAnimations()
      .find((item) => item.animationName === 'commentsUp')
    const keyframes = animation?.effect?.getKeyframes() ?? []
    return {
      panel: animation?.animationName,
      duration: getComputedStyle(panel).animationDuration,
      keyframes: keyframes.map(({ transform, opacity }) => ({
        transform,
        opacity,
      })),
      pinned: document.getElementById('topComment')?.getAnimations().length,
      userClass: document.getElementById('userInfo')?.className,
      userAnimations: document.getElementById('userInfo')?.getAnimations()
        .length,
      viewportHeight: window.innerHeight,
    }
  })
  expect(state.panel).toBe('commentsUp')
  expect(state.duration).toBe('1.7s')
  expect(state.keyframes).toEqual([
    { transform: 'translateY(calc(100% + 30px))', opacity: undefined },
    { transform: 'translateY(calc(100% + 30px))', opacity: undefined },
    {
      transform: `translateY(${state.viewportHeight * 0.33}px)`,
      opacity: undefined,
    },
  ])
  expect(
    state.keyframes.every(({ transform }) => !transform.includes('scale')),
  ).toBe(true)
  expect(state.pinned).toBe(0)
  expect(state.userClass).not.toContain('pageEntrance')
  expect(state.userAnimations).toBe(0)

  await page.waitForTimeout(1900)
  await expect(page.locator('#lowerPanel')).not.toHaveClass(/animating/u)
  await page.locator('.mainTitleUnder').click()
  await page.locator('#themeList [data-theme="default"]').click()
  await page.evaluate(() => {
    document.body.classList.add('fullscreen')
    document.body.classList.remove('fullscreen')
    document.documentElement.lang = 'en'
  })
  await page.waitForTimeout(100)
  expect(
    await page
      .locator('#lowerPanel')
      .evaluate((element) =>
        element
          .getAnimations()
          .some((item) => item.animationName === 'commentsUp'),
      ),
  ).toBe(false)
})

test('公共留言缓存先渲染,后台相同数据保持 DOM 身份', async ({ page }) => {
  const cached = commentPayload(41)
  await seedHomeComments(page, [cached])
  await page.route('**/api/user/me', (route) => fulfillMe(route))
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { delay: 1500, items: [cached] }),
  )

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const card = page.locator('#comments .commentItem').first()
  await expect(card).toBeVisible({ timeout: 100 })
  await expect(page.locator('#comments .commentSkeleton')).toHaveCount(0)
  expect(await card.evaluate((element) => element.getAnimations().length)).toBe(
    0,
  )
  const handle = await card.elementHandle()
  await page.waitForTimeout(1700)
  expect(
    await card.evaluate((element, original) => element === original, handle),
  ).toBe(true)
  expect(await card.evaluate((element) => element.getAnimations().length)).toBe(
    0,
  )
})

test('公共留言后台校准只为新增 ID 入场并移除已删除留言', async ({ page }) => {
  const cached = commentPayload(42)
  let publicCalls = 0
  await seedHomeComments(page, [cached])
  await page.route('**/api/user/me', (route) => fulfillMe(route))
  await page.route('**/api/comments/public*', (route) => {
    publicCalls += 1
    return fulfillComments(route, {
      delay: 300,
      items:
        publicCalls === 1 ? [cached, commentPayload(43)] : [commentPayload(43)],
    })
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  await expect(page.locator('#comments .commentItem')).toHaveCount(2, {
    timeout: 2000,
  })
  const cards = page.locator('#comments .commentItem')
  await expect
    .poll(async () => {
      return cards.evaluateAll((elements) =>
        elements.map((element) => element.classList.contains('commentEnter')),
      )
    })
    .toEqual([true, false])
  const newCommentAnimation = await cards.first().evaluate((element) => {
    const animation = element
      .getAnimations()
      .find((item) => item.animationName === 'newCommentUp')
    return {
      name: animation?.animationName,
      transforms:
        animation?.effect?.getKeyframes().map((frame) => frame.transform) ?? [],
    }
  })
  expect(newCommentAnimation.name).toBe('newCommentUp')
  expect(newCommentAnimation.transforms).toEqual([
    'translateY(24px)',
    'translateY(0px)',
  ])
  expect(
    newCommentAnimation.transforms.every((value) => !value.includes('scale')),
  ).toBe(true)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('#comments .commentItem')).toHaveCount(1, {
    timeout: 2000,
  })
  await expect(page.locator('#comments .commentItem').first()).toHaveText(
    /性能留言 43/,
  )
})

test('公共留言缓存损坏或过期时删除缓存并回退骨架网络加载', async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem('elytrue:home-comments:v1', '{broken')
  })
  await page.route('**/api/user/me', (route) => fulfillMe(route))
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { delay: 300, items: [commentPayload(44)] }),
  )
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#comments .commentSkeleton')).toHaveCount(3)
  await expect(page.locator('#comments .commentItem')).toHaveCount(1, {
    timeout: 2000,
  })
  expect(
    await page.evaluate(() =>
      sessionStorage.getItem('elytrue:home-comments:v1'),
    ),
  ).not.toBe('{broken')
})

test('公共留言校准失败时保留缓存并提供非阻塞重试', async ({ page }) => {
  const cached = commentPayload(45)
  let calls = 0
  await seedHomeComments(page, [cached])
  await page.route('**/api/user/me', (route) => fulfillMe(route))
  await page.route('**/api/comments/public*', (route) => {
    calls += 1
    return fulfillComments(route, {
      status: calls === 1 ? 500 : 200,
      items: [cached],
    })
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#comments .commentItem')).toHaveCount(1, {
    timeout: 100,
  })
  await expect(page.locator('.commentsRevalidateError')).toBeVisible()
  await page.locator('.commentsRevalidateError button').click()
  await expect(page.locator('.commentsRevalidateError')).toHaveCount(0)
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
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

test('置顶与已有留言只随父级面板整体上升', async ({ page }) => {
  const cached = commentPayload(46)
  await seedHomeComments(page, [cached])
  await page.route('**/api/user/me', (route) => fulfillMe(route))
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { delay: 1500, items: [cached] }),
  )
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()
  await page.waitForTimeout(50)

  const animationState = await page.evaluate(() => {
    const panel = document.getElementById('lowerPanel')
    const pinned = document.getElementById('topComment')
    const first = document.querySelector('#comments .commentItem')
    const sentinels = [
      ...document.querySelectorAll('#comments .paginationSentinel'),
    ].map((el) => getComputedStyle(el).animationName)
    return {
      panel: getComputedStyle(panel).animationName,
      pinned: getComputedStyle(pinned).animationName,
      first: first ? getComputedStyle(first).animationName : '',
      sentinels,
      firstStart: performance
        .getEntriesByName('first-comment-animation-start')
        .at(-1)?.startTime,
    }
  })
  expect(animationState.panel).toBe('commentsUp')
  expect(animationState.pinned).toBe('none')
  expect(animationState.first).toBe('none')
  expect(animationState.sentinels.every((name) => name === 'none')).toBe(true)
  expect(animationState.firstStart).toBeTruthy()
})

test('1500ms 公共留言请求期间立即显示置顶卡和三个骨架', async ({ page }) => {
  await page.route('**/api/user/me', (route) => fulfillMe(route))
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { delay: 1500 }),
  )
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#topComment')).toBeVisible({ timeout: 100 })
  await expect(page.locator('#comments .commentSkeleton')).toHaveCount(3)
  await expect(page.locator('#comments .loadingCircle')).toHaveCount(0)
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  await expect(page.locator('#comments .commentSkeleton')).toHaveCount(0)
})

test('首次请求失败仍显示置顶、错误状态和可用重试', async ({ page }) => {
  let requests = 0
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, { profile: profilePayload() }),
  )
  await page.route('**/api/comments/viewer-likes*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 1,
        message: 'OK',
        data: [{ id: 2, liked: true }],
      }),
    }),
  )
  await page.route('**/api/comments/public*', (route) => {
    requests += 1
    return fulfillComments(route, {
      items: [commentPayload(2)],
      status: requests === 1 ? 500 : 200,
    })
  })
  await page.goto('/')
  await expect(page.locator('#topComment')).toBeVisible()
  await expect(page.locator('.commentsLoadError')).toBeVisible()
  await liftPanel(page)
  await page.locator('.commentsLoadError button').click()
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  await expect(page.locator('#comments .btn.like')).toHaveClass(/liked/)
})

test('认证未决时重复点击只保留一个弹窗和一个 /user/me 请求', async ({
  page,
}) => {
  let meRequests = 0
  await page.route('**/api/user/me', async (route) => {
    meRequests += 1
    await fulfillMe(route, { delay: 800 })
  })
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { items: [] }),
  )
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const started = await page.evaluate(() => performance.now())
  await page.locator('#userInfo').dispatchEvent('click')
  await page.locator('#userInfo').dispatchEvent('click')
  await expect(page.locator('#popups .userHome')).toBeVisible({ timeout: 100 })
  const openedAt = await page.evaluate(
    () =>
      performance.getEntriesByName('user-popup-shell-open').at(-1)?.startTime,
  )
  expect(openedAt).toBeTruthy()
  expect(openedAt - started).toBeLessThan(100)
  await expect(page.locator('#popups .userHome')).toHaveCount(1)
  await page.waitForTimeout(900)
  expect(meRequests).toBe(1)
  await expect(page.locator('#popups .loginPopup')).toBeVisible()
})

test('公共留言延迟 3000ms 不阻塞缓存用户名和认证确认', async ({ page }) => {
  await installProfileHint(page, '独立认证用户')
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, { profile: profilePayload('独立认证用户') }),
  )
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { delay: 3000 }),
  )
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#userInfoName')).toHaveText('独立认证用户', {
    timeout: 100,
  })
  await expect(page.locator('#userInfo')).not.toHaveClass(/nologin/)
  await expect(page.locator('#comments .commentSkeleton')).toHaveCount(3)
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
})

test('认证延迟 3000ms 不阻塞公共留言,期间显示用户名骨架而非访客', async ({
  page,
}) => {
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, { delay: 3000 }),
  )
  await page.route('**/api/comments/public*', (route) => fulfillComments(route))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#comments .commentItem')).toHaveCount(1, {
    timeout: 500,
  })
  await expect(page.locator('#userInfo .userNameSkeleton')).toHaveCount(1)
  await expect(page.locator('#userInfoName')).not.toContainText('访客')
  await expect(page.locator('#userInfoName')).toHaveText(/访客/, {
    timeout: 4000,
  })
})

test('缓存用户名在 100ms 内显示,服务端确认未登录后才清除', async ({ page }) => {
  await installProfileHint(page, '缓存命中用户')
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, { delay: 500 }),
  )
  await page.route('**/api/comments/public*', (route) => fulfillComments(route))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#userInfoName')).toHaveText('缓存命中用户', {
    timeout: 100,
  })
  await expect(page.locator('#userInfoName')).toHaveText(/访客/)
  expect(
    await page.evaluate(() => localStorage.getItem('elytrue.profileHint')),
  ).toBeNull()
})

test('认证请求失败会清除缓存用户名', async ({ page }) => {
  await installProfileHint(page, '失效缓存用户')
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, { delay: 200, status: 503 }),
  )
  await page.route('**/api/comments/public*', (route) => fulfillComments(route))
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#userInfoName')).toHaveText('失效缓存用户', {
    timeout: 100,
  })
  await expect(page.locator('#userInfoName')).toHaveText(/访客/)
  expect(
    await page.evaluate(() => localStorage.getItem('elytrue.profileHint')),
  ).toBeNull()
})

test('相同 Profile Hint 头像只预加载一次且不替换节点', async ({ page }) => {
  let avatarRequests = 0
  await installProfileHint(page, '头像缓存用户', 'profile-avatar')
  await page.route('**/api/data/images/avatars/profile-avatar', (route) => {
    avatarRequests += 1
    return fulfillAvatar(route, { delay: 300 })
  })
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, {
      delay: 1500,
      profile: profilePayload('头像缓存用户', 'profile-avatar'),
    }),
  )
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { items: [] }),
  )

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const avatar = page.locator('#userInfoAvatar')
  await expect(avatar).toHaveAttribute('src', '/res/defaultAvatar.png')
  const handle = await avatar.elementHandle()
  await avatar.evaluate((element) => {
    const changes = []
    const observer = new MutationObserver(() => {
      changes.push(element.getAttribute('src'))
    })
    observer.observe(element, {
      attributes: true,
      attributeFilter: ['src'],
    })
    Reflect.set(window, 'avatarSrcChanges', changes)
    Reflect.set(window, 'avatarObserver', observer)
  })
  await expect(avatar).toHaveAttribute(
    'src',
    '/api/data/images/avatars/profile-avatar',
  )
  await page.waitForTimeout(1500)

  expect(avatarRequests).toBe(1)
  expect(
    await avatar.evaluate((element, original) => element === original, handle),
  ).toBe(true)
  expect(
    await page.evaluate(() => Reflect.get(window, 'avatarSrcChanges')),
  ).toEqual(['/api/data/images/avatars/profile-avatar'])
})

test('头像目标变化时保留旧图直到新图完成解码', async ({ page }) => {
  await installProfileHint(page, '头像切换用户', 'avatar-old')
  await page.route('**/api/data/images/avatars/avatar-old', (route) =>
    fulfillAvatar(route, { delay: 200 }),
  )
  await page.route('**/api/data/images/avatars/avatar-new', (route) =>
    fulfillAvatar(route, { delay: 1000 }),
  )
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, {
      delay: 500,
      profile: profilePayload('头像切换用户', 'avatar-new'),
    }),
  )
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { items: [] }),
  )

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const avatar = page.locator('#userInfoAvatar')
  const handle = await avatar.elementHandle()
  await expect(avatar).toHaveAttribute(
    'src',
    '/api/data/images/avatars/avatar-old',
  )
  await page.waitForTimeout(700)
  await expect(avatar).toHaveAttribute(
    'src',
    '/api/data/images/avatars/avatar-old',
  )
  await expect(avatar).toHaveAttribute(
    'src',
    '/api/data/images/avatars/avatar-new',
  )
  expect(
    await avatar.evaluate((element, original) => element === original, handle),
  ).toBe(true)
})

test('首次动态头像 404 时始终保留默认头像', async ({ page }) => {
  await page.route('**/api/data/images/avatars/missing-avatar', (route) =>
    fulfillAvatar(route, { delay: 300, status: 404 }),
  )
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, {
      profile: profilePayload('头像失败用户', 'missing-avatar'),
    }),
  )
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { items: [] }),
  )

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const avatar = page.locator('#userInfoAvatar')
  const handle = await avatar.elementHandle()
  await expect(avatar).toHaveAttribute('src', '/res/defaultAvatar.png')
  await page.waitForTimeout(500)
  await expect(avatar).toHaveAttribute('src', '/res/defaultAvatar.png')
  expect(
    await avatar.evaluate((element, original) => element === original, handle),
  ).toBe(true)
})

test('留言缓存校准和 liked 更新不重载或替换头像', async ({ page }) => {
  let avatarRequests = 0
  const cached = commentPayload(61, 'comment-avatar')
  await seedHomeComments(page, [cached])
  await page.route('**/api/data/images/avatars/comment-avatar', (route) => {
    avatarRequests += 1
    return fulfillAvatar(route, { delay: 300 })
  })
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, { profile: profilePayload() }),
  )
  await page.route('**/api/comments/viewer-likes*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 1,
        message: 'OK',
        data: [{ id: 61, liked: true }],
      }),
    })
  })
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, { delay: 600, items: [cached] }),
  )

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  const card = page.locator('#comments .commentItem').first()
  const avatar = card.locator('.avatar')
  const cardHandle = await card.elementHandle()
  const avatarHandle = await avatar.elementHandle()
  await expect(avatar).toHaveAttribute(
    'src',
    '/api/data/images/avatars/comment-avatar',
  )
  await expect(card.locator('.btn.like')).toHaveClass(/liked/u)

  expect(avatarRequests).toBe(1)
  expect(
    await card.evaluate(
      (element, original) => element === original,
      cardHandle,
    ),
  ).toBe(true)
  expect(
    await avatar.evaluate(
      (element, original) => element === original,
      avatarHandle,
    ),
  ).toBe(true)
})

test('今日统计延迟 3000ms 不阻塞留言卡片', async ({ page }) => {
  await page.route('**/api/user/me', (route) => fulfillMe(route))
  await page.route('**/api/comments/public*', (route) => fulfillComments(route))
  await page.route('**/api/comments/count', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 1, message: 'OK', data: 7 }),
    })
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#comments .commentItem')).toHaveCount(1, {
    timeout: 500,
  })
  await expect(page.locator('#todayCommentCount')).toHaveText('0')
  await expect(page.locator('#todayCommentCount')).toHaveText('7', {
    timeout: 4000,
  })
})

test('延迟补充 viewer-like 只更新原卡片且不重播动画', async ({ page }) => {
  await page.route('**/api/user/me', (route) =>
    fulfillMe(route, { profile: profilePayload() }),
  )
  await page.route('**/api/comments/public*', (route) => fulfillComments(route))
  await page.route('**/api/comments/viewer-likes*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 1,
        message: 'OK',
        data: [{ id: 1, liked: true }],
      }),
    })
  })
  await page.goto('/')
  const card = page.locator('#comments .commentItem').first()
  await expect(card).toBeVisible()
  await page.waitForTimeout(700)
  const cardHandle = await card.elementHandle()
  expect(await card.evaluate((element) => element.getAnimations().length)).toBe(
    0,
  )
  await expect(card.locator('.btn.like')).toHaveClass(/liked/)
  expect(
    await card.evaluate(
      (element, original) => element === original,
      cardHandle,
    ),
  ).toBe(true)
  expect(await card.evaluate((element) => element.getAnimations().length)).toBe(
    0,
  )
})

test('reduced-motion 不强制执行留言入场动画', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/api/user/me', (route) => fulfillMe(route))
  await page.route('**/api/comments/public*', (route) => fulfillComments(route))
  await page.goto('/')
  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  const state = await page.evaluate(() => ({
    panelAnimating: document
      .getElementById('lowerPanel')
      ?.classList.contains('animating'),
    panelTransform: getComputedStyle(document.getElementById('lowerPanel'))
      .transform,
    pinnedAnimations: document.getElementById('topComment')?.getAnimations()
      .length,
    firstAnimations: document
      .querySelector('#comments .commentItem')
      ?.getAnimations().length,
    forcedMarks: performance.getEntriesByName('first-comment-animation-start')
      .length,
  }))
  expect(state.panelAnimating).toBe(false)
  expect(state.panelTransform).not.toBe('none')
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
