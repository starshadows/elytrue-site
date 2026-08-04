import { test, expect } from '@playwright/test'

const BASE = 'http://127.0.0.1:4173'
const PASSWORD = 'e2e-test-password-123'

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
  expect(mainListRequests).toBe(1)
  expect(countRequests).toBe(0)
  await expect(page.locator('#comments .loadingCircle')).toHaveCount(0)
  await expect(page.locator('#comments .paginationSentinel')).toHaveCount(2)

  await page.waitForTimeout(5000)
  expect(directionAfterRequests).toBe(0)
  expect(directionBeforeRequests).toBe(0)
  expect(mainListRequests).toBe(1)
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

test('置顶卡片与首条普通留言卡片的入场动画配置一致', async ({ page }) => {
  await registerAndStayLoggedIn(page, unique('性能旅人'))
  await postViaApi(page, `动画配置 ${Date.now()}`)
  await page.reload()
  await liftPanel(page)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()

  const animationNames = await page.evaluate(() => {
    const pinned = document.getElementById('topComment')
    const first = document.querySelector('#comments .commentItem')
    const sentinels = [
      ...document.querySelectorAll('#comments .paginationSentinel'),
    ].map((el) => getComputedStyle(el).animationName)
    return {
      pinned: getComputedStyle(pinned).animationName,
      first: first ? getComputedStyle(first).animationName : '',
      sentinels,
    }
  })
  expect(animationNames.pinned).toBeTruthy()
  expect(animationNames.first).toBe(animationNames.pinned)
  expect(animationNames.sentinels.every((name) => name === 'none')).toBe(true)
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
  await liftPanel(page)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()

  const started = Date.now()
  await page.locator('#userInfo').click()
  const userHome = page.locator('#popups .userHome')
  await expect(userHome).toBeVisible({ timeout: 300 })
  expect(Date.now() - started).toBeLessThan(300)

  const maxVisibleLoaders = await page.evaluate(async () => {
    let max = 0
    for (let index = 0; index < 20; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      max = Math.max(
        max,
        document.querySelectorAll('#popups .loadingCircle').length,
      )
    }
    return max
  })
  expect(maxVisibleLoaders).toBeLessThanOrEqual(1)
})
