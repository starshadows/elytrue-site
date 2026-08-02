import { test, expect } from '@playwright/test'

const BASE = 'http://127.0.0.1:4173'
const PASSWORD = 'e2e-test-password-123'

const unique = (prefix) =>
  `${prefix}_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`

const user1Name = unique('星花旅人')
const user1Email = `owner_${Date.now()}@example.com`

let user1Message = '第一条测试留言，愿星花与你同在'

async function expectVisitor(page) {
  await expect(page.locator('#userInfoName')).toHaveText(/访客/)
  await expect(page.locator('#userInfo')).toHaveClass(/nologin/)
}

/**
 * #lowerPanel 默认下移 33vh,且 #comments 卡片子元素 pointer-events:none,
 * 必须先把鼠标悬停到面板可见条带将其抬起,页面控件才可点击。
 * 注意:右下角的备案悬浮条(#siteFooter, z-index:5)会遮挡面板底部,
 * 悬停点取面板上部的留言区;并等入场动画(.animating)结束后再悬停。
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

async function openLoginPopup(page) {
  await page.locator('#userInfo').click()
  await expect(page.locator('#popups .loginPopup')).toBeVisible()
}

async function loginByIdentifier(page, identifier, password) {
  await openLoginPopup(page)
  const popup = page.locator('#popups .loginPopup')
  await popup.locator('input').nth(0).fill(identifier)
  await popup.locator('input').nth(1).fill(password)
  await popup.locator('.okBtn').click()
  await expect(page.locator('#popups .popupContainer')).toHaveCount(0)
}

async function fillRegisterForm(page, name, email, password) {
  await openLoginPopup(page)
  const popup = page.locator('#popups .loginPopup')
  await page.getByText(/第一次来/).click()
  await expect(popup.locator('h2')).toContainText('注册账号')
  await popup.locator('input').nth(0).fill(name)
  await popup.locator('input').nth(1).fill(email)
  await popup.locator('input').nth(2).fill(password)
  await popup.locator('input').nth(3).fill(password)
  await popup.locator('.okBtn').click()
}

async function registerViaPopup(page, name, email, password) {
  await fillRegisterForm(page, name, email, password)
  await expect(page.locator('#popups .popupContainer')).toHaveCount(0)
}

async function expectLoggedIn(page, name) {
  await expect(page.locator('#userInfoName')).toHaveText(name)
  await expect(page.locator('#userInfo')).not.toHaveClass(/nologin/)
}

async function logoutViaCookies(page, context) {
  await context.clearCookies()
  await page.reload()
  await expectVisitor(page)
}

async function typeMessage(page, text) {
  const msgText = page.locator('#msgText')
  await expect(msgText).toBeVisible()
  await msgText.click()
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}

async function sendMessageAndWaitNewCard(page, expectedCount) {
  await page.locator('#sendBtn').click()
  await expect(page.locator('#newCommentBox')).toHaveCount(0)
  await expect(page.locator('#comments .commentItem')).toHaveCount(
    expectedCount,
  )
}

test('页面加载后默认显示访客', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)
  await expect(page.locator('#popups .loginPopup')).toHaveCount(0)
})

test('注册：弹登录框切换到注册并登录成功', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)

  await liftPanel(page)
  await page.locator('#newMsg').click()
  await expect(page.locator('#popups .loginPopup')).toBeVisible()
  await expect(page.getByText(/登录后即可留言/)).toBeVisible()

  await page.getByText(/第一次来/).click()
  const popup = page.locator('#popups .loginPopup')
  await expect(popup.locator('h2')).toContainText('注册账号')
  await popup.locator('input').nth(0).fill(user1Name)
  await popup.locator('input').nth(1).fill(user1Email)
  await popup.locator('input').nth(2).fill(PASSWORD)
  await popup.locator('input').nth(3).fill(PASSWORD)
  await popup.locator('.okBtn').click()

  await expect(page.locator('#popups .popupContainer')).toHaveCount(0)
  await expectLoggedIn(page, user1Name)
})

test('重复用户名注册被拒绝并提示', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)

  await fillRegisterForm(
    page,
    user1Name,
    `other_${Date.now()}@example.com`,
    PASSWORD,
  )

  await expect(page.getByText(/用户名已被使用/)).toBeVisible()
  await expect(page.locator('#popups .loginPopup')).toBeVisible()
})

test('用户名登录：登出后用户名+密码登录成功', async ({ page, context }) => {
  await page.goto('/')
  await expectVisitor(page)

  await loginByIdentifier(page, user1Name, PASSWORD)
  await expectLoggedIn(page, user1Name)

  await logoutViaCookies(page, context)
  await loginByIdentifier(page, user1Name, PASSWORD)
  await expectLoggedIn(page, user1Name)
})

test('邮箱登录：登出后用邮箱+密码登录成功', async ({ page, context }) => {
  await page.goto('/')
  await expectVisitor(page)

  await loginByIdentifier(page, user1Email, PASSWORD)
  await expectLoggedIn(page, user1Name)

  await logoutViaCookies(page, context)
  await loginByIdentifier(page, user1Email, PASSWORD)
  await expectLoggedIn(page, user1Name)
})

test('登录状态恢复：注册后刷新页面仍保持登录', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)

  const name = unique('重载旅人')
  await registerViaPopup(
    page,
    name,
    `reload_${Date.now()}@example.com`,
    PASSWORD,
  )
  await expectLoggedIn(page, name)

  await page.reload()
  await expectLoggedIn(page, name)
  await expect(page.locator('#popups .loginPopup')).toHaveCount(0)
})

test('忘记密码：任意邮箱提交后统一提示', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)

  await openLoginPopup(page)
  await page.getByText(/忘记密码/).click()

  const prompt = page.locator('#popups .popupContainer').last()
  await expect(prompt.locator('h2')).toContainText('找回密码')
  await prompt.locator('input').fill('nobody@example.com')
  await prompt.locator('.okBtn').click()

  await expect(page.getByText(/如果账号存在/)).toBeVisible()
})

test('发布留言：新留言卡片出现且编号为 #1', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)

  await loginByIdentifier(page, user1Name, PASSWORD)
  await expectLoggedIn(page, user1Name)

  await liftPanel(page)
  await page.locator('#newMsg').click()
  await typeMessage(page, user1Message)
  await sendMessageAndWaitNewCard(page, 1)

  const card = page.locator('#comments .commentItem').first()
  await expect(card.locator('.id')).toHaveText('#1')
  await expect(card.locator('.comment')).toContainText(user1Message)
  await expect(card.locator('.btn.report')).toHaveCount(0)
})

test('回复：点击回复出现引用块，发送后新卡片含回复引用', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)

  await loginByIdentifier(page, user1Name, PASSWORD)
  await expectLoggedIn(page, user1Name)

  await liftPanel(page)
  const firstCard = page.locator('#comments .commentItem').first()
  await expect(firstCard.locator('.id')).toHaveText('#1')
  await firstCard.locator('.btn.reply').click()

  const msgText = page.locator('#msgText')
  await expect(msgText).toBeVisible()
  await expect(page.locator('#newCommentReplyQuote')).toBeVisible()
  await expect(page.locator('#newCommentReplyQuote .quote-id')).toHaveText('#1')

  const replyText = '回复测试：星辉与花簇'
  await msgText.click()
  await page.keyboard.press('End')
  await page.keyboard.type(replyText)
  await sendMessageAndWaitNewCard(page, 2)

  const replyCard = page.locator('#comments .commentItem').first()
  await expect(replyCard.locator('.id')).toHaveText('#2')
  await expect(replyCard.locator('.comment')).toContainText(replyText)
  await expect(replyCard.locator('.reply-quote .quote-id')).toHaveText('#1')
})

test('点赞快速双击只计一次，且无网络错误提示', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)

  await loginByIdentifier(page, user1Name, PASSWORD)
  await expectLoggedIn(page, user1Name)

  await liftPanel(page)
  const card = page.locator('#comments .commentItem').first()
  const likeBtn = card.locator('.btn.like')
  await expect(likeBtn).toBeVisible()

  await likeBtn.click()
  await likeBtn.click()

  await expect(card.locator('.like-count')).toHaveText('1')
  await page.waitForTimeout(600)
  await expect(page.locator('#floatMsgs .float-msg.error')).toHaveCount(0)
  await expect(page.locator('#floatMsgs')).not.toContainText('网络错误')
})

test('举报：他人留言可举报，自己的留言无举报按钮', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)

  const reportUserName = unique('举报旅人')
  await registerViaPopup(
    page,
    reportUserName,
    `report_${Date.now()}@example.com`,
    PASSWORD,
  )
  await expectLoggedIn(page, reportUserName)

  await liftPanel(page)
  await page.locator('#newMsg').click()
  await typeMessage(page, '举报人自己的留言')
  await sendMessageAndWaitNewCard(page, 3)

  await page.reload()
  await expectLoggedIn(page, reportUserName)
  await expect(page.locator('#comments .commentItem')).toHaveCount(3)

  await liftPanel(page)
  const ownCard = page.locator('#comments .commentItem').first()
  await expect(ownCard.locator('.btn.report')).toHaveCount(0)

  const targetCard = page.locator('#comments .commentItem').filter({
    has: page.locator('.id', { hasText: /^#1$/ }),
  })
  await expect(targetCard).toHaveCount(1)
  await expect(targetCard.locator('.btn.report')).toHaveCount(1)
  await targetCard.locator('.btn.report').click()

  const prompt = page.locator('#popups .popupContainer').last()
  await expect(prompt.locator('h2')).toContainText('举报留言')
  await prompt.locator('input').fill('测试举报原因')
  await prompt.locator('.okBtn').click()

  await expect(page.getByText(/举报已提交/)).toBeVisible()
})

test('编号跳转：输入编号回车后显示对应留言', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()

  await liftPanel(page)
  await page.locator('#menu').hover()
  await page.locator('#goto').fill('1')
  await page.keyboard.press('Enter')

  await expect(page.locator('#comments .commentItem')).toHaveCount(1)
  await expect(page.locator('#comments .commentItem .id').first()).toHaveText(
    '#1',
  )
  await expect(
    page.locator('#comments .commentItem .comment').first(),
  ).toContainText(user1Message)
})

test('个人主页分页：滚动到底加载更多，显示共 N 条留言', async ({
  page,
  request,
}) => {
  const name = unique('分页旅人')
  const email = `pager_${Date.now()}@example.com`

  const reg = await request.post('/api/user/register', {
    headers: { origin: BASE, 'x-forwarded-for': '203.0.113.199' },
    data: { name, email, password: PASSWORD },
  })
  expect(reg.status()).toBe(201)
  const csrf = (await reg.json()).data.csrfToken

  const TOTAL = 60
  for (let i = 1; i <= TOTAL; i += 1) {
    const res = await request.post('/api/comments/post', {
      headers: {
        origin: BASE,
        'x-forwarded-for': `203.0.113.${(i % 250) + 1}`,
        'x-csrf-token': csrf,
      },
      data: { comment: `分页测试留言 ${i}` },
    })
    expect(res.status()).toBe(201)
  }

  await page.goto('/')
  await liftPanel(page)
  const firstCard = page.locator('#comments .commentItem').first()
  await expect(firstCard).toBeVisible()
  await firstCard.locator('.avatar').click()

  const userHome = page.locator('#popups .userHome')
  await expect(userHome).toBeVisible()
  await expect(userHome.locator('.userCommentItem').first()).toBeVisible()

  for (let i = 0; i < 12; i += 1) {
    if ((await userHome.getByText(/共\s*60\s*条留言/).count()) > 0) break
    await userHome.evaluate((el) => {
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event('scroll'))
    })
    await page.waitForTimeout(350)
  }
  await expect(userHome.getByText(/共\s*60\s*条留言/)).toBeVisible()
})

test('登录竞态：已有 Cookie 立即点击新留言,不弹登录框', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)

  // 通过 API 注册并写入 cookie
  const name = unique('竞态旅人')
  const register = await page.request.post('/api/user/register', {
    data: { name, email: `race_${Date.now()}@example.com`, password: PASSWORD },
    headers: { origin: BASE, 'x-forwarded-for': '203.0.113.80' },
  })
  expect(register.ok()).toBeTruthy()

  // 延迟 /user/me,制造初始化未完成窗口
  await page.route('**/api/user/me', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 4000))
    await route.continue()
  })
  await page.reload()
  await liftPanel(page)
  // 初始化尚未完成时立即点击
  await page.locator('#newMsg').click()
  await expect(page.locator('#popups .loginPopup')).toHaveCount(0)
  await expect(page.locator('#newCommentBox')).toBeVisible({ timeout: 10000 })
})

test('登录态初始化：首次加载只请求一次 /user/me', async ({ page }) => {
  let meRequests = 0
  await page.route('**/api/user/me', async (route) => {
    meRequests += 1
    await route.continue()
  })
  await page.goto('/')
  await expectVisitor(page)
  await page.waitForTimeout(200)
  expect(meRequests).toBe(1)
  // 点击新留言触发 ensureLoggedIn → 复用首次 Promise,不再发 /user/me
  await liftPanel(page)
  await page.locator('#newMsg').click()
  await expect(page.locator('#popups .loginPopup')).toBeVisible()
  await page.waitForTimeout(200)
  expect(meRequests).toBe(1)
})

test('举报按钮：留言先加载、用户后登录时自动出现', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)
  await liftPanel(page)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()
  await expect(page.locator('#comments .btn.report')).toHaveCount(0)

  // 第二个用户登录(其没有留言,user1 的留言可见 → 举报按钮出现)
  const reporter = unique('举报旅人')
  await fillRegisterForm(
    page,
    reporter,
    `rp_${Date.now()}@example.com`,
    PASSWORD,
  )
  await expect(page.locator('#popups .popupContainer')).toHaveCount(0)
  await expect(page.locator('#userInfoName')).toHaveText(reporter)
  await expect(page.locator('#comments .btn.report').first()).toBeVisible()

  // 登出后按钮消失
  await page.locator('#userInfo').click()
  const userHome = page.locator('#popups .userHome')
  await expect(userHome).toBeVisible()
  await userHome.locator('.useraction > div').nth(1).hover()
  await userHome.getByText('退出登录 (当前设备)', { exact: true }).click()
  await expect(page.locator('#userInfoName')).toHaveText(/访客/)
  await expect(page.locator('#comments .btn.report')).toHaveCount(0)
})

test('时间轴：跳转到今天返回留言而非空数组', async ({ page }) => {
  await page.goto('/')
  await loginByIdentifier(page, user1Name, PASSWORD)
  await expectLoggedIn(page, user1Name)

  const me = await page.request.get('/api/user/me', {
    headers: { origin: BASE },
  })
  const csrf = (await me.json()).data.csrfToken
  const posted = await page.request.post('/api/comments/post', {
    data: { comment: `时间轴测试 ${Date.now()}` },
    headers: {
      origin: BASE,
      'x-forwarded-for': '203.0.113.82',
      'x-csrf-token': csrf,
    },
  })
  expect(posted.ok()).toBeTruthy()

  await liftPanel(page)
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes('/api/comments') &&
      response.url().includes('time='),
    { timeout: 10000 },
  )
  // 注入今天的日期节点并点击时间轴容器(走真实 handler → loadComments({time}))
  await page.evaluate(() => {
    const container = document.getElementById('timelineContainer')
    const el = document.createElement('div')
    el.dataset.time = new Date().toDateString()
    container.appendChild(el)
    el.click()
    el.remove()
  })
  const response = await responsePromise
  const body = await response.json()
  expect(body.data.length).toBeGreaterThan(0)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()
})
