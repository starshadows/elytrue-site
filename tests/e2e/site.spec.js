import { test, expect } from '@playwright/test'

const BASE = 'http://127.0.0.1:4173'
const PASSWORD = 'e2e-test-password-123'

const unique = (prefix) =>
  `${prefix}_${Date.now().toString(36).slice(-6)}${Math.random().toString(36).slice(2, 5)}`

const user1Name = unique('星花旅人')
const user1Email = `owner_${Date.now()}@example.com`

let user1Message = '第一条测试留言，愿星花与你同在'
let user1RecoveryKey = ''

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

async function expectPanelCollapsed(page) {
  await expect
    .poll(() =>
      page
        .locator('#lowerPanel')
        .evaluate((panel) => panel.getBoundingClientRect().top),
    )
    .toBeGreaterThan(400)
}

async function leaveAndReliftPanel(page) {
  await page.mouse.move(640, 100)
  await expectPanelCollapsed(page)
  await page.mouse.move(640, 690)
  await expect
    .poll(() =>
      page
        .locator('#lowerPanel')
        .evaluate((panel) => panel.getBoundingClientRect().top),
    )
    .toBeLessThan(350)
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

async function confirmRecoveryKey(page) {
  const popup = page.locator('#popups .recoveryKeyPopup')
  await expect(popup).toBeVisible()
  const key = (await popup.getByTestId('recovery-key').textContent()).trim()
  await expect(popup.getByTestId('confirm-recovery-key')).toBeDisabled()
  await popup.locator('.recoveryConfirmation input').check()
  await popup.getByTestId('confirm-recovery-key').click()
  await expect(popup).toHaveCount(0)
  return key
}

async function registerViaPopup(page, name, email, password) {
  await fillRegisterForm(page, name, email, password)
  await confirmRecoveryKey(page)
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

test('注册：展示一次性恢复密钥，支持复制下载并确认保存', async ({
  page,
  context,
}) => {
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

  const recoveryPopup = page.locator('#popups .recoveryKeyPopup')
  await expect(recoveryPopup).toBeVisible()
  user1RecoveryKey = (
    await recoveryPopup.getByTestId('recovery-key').textContent()
  ).trim()
  expect(user1RecoveryKey).toMatch(
    /^ELY-(?:[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-){6}[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/,
  )
  await expect(recoveryPopup.getByText('Save your recovery key')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(recoveryPopup).toBeVisible()
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: BASE,
  })
  await recoveryPopup.getByTestId('copy-recovery-key').click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(user1RecoveryKey)
  const downloadPromise = page.waitForEvent('download')
  await recoveryPopup.getByTestId('download-recovery-key').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe('elytrue-recovery-key.txt')
  await recoveryPopup.locator('.recoveryConfirmation input').check()
  await recoveryPopup.getByTestId('confirm-recovery-key').click()
  await expect(page.locator('#popups .popupContainer')).toHaveCount(0)
  await expectLoggedIn(page, user1Name)
})

test('注册：登录态刷新失败时仍先展示一次性恢复密钥', async ({ page }) => {
  let failProfileRefresh = false
  let markProfileRefreshStarted
  let releaseProfileRefresh
  const profileRefreshStarted = new Promise((resolve) => {
    markProfileRefreshStarted = resolve
  })
  const profileRefreshRelease = new Promise((resolve) => {
    releaseProfileRefresh = resolve
  })
  await page.route('**/api/user/me', async (route) => {
    if (!failProfileRefresh) {
      await route.continue()
      return
    }
    markProfileRefreshStarted()
    await profileRefreshRelease
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: 503, message: '测试刷新失败', data: null }),
    })
  })
  await page.goto('/')
  await expectVisitor(page)
  failProfileRefresh = true
  await fillRegisterForm(
    page,
    unique('刷新失败用户'),
    `refresh_failure_${Date.now()}@example.com`,
    PASSWORD,
  )

  const recoveryPopup = page.locator('#popups .recoveryKeyPopup')
  await expect(recoveryPopup).toBeVisible()
  await expect(recoveryPopup.getByTestId('recovery-key')).toHaveText(/^ELY-/)
  await profileRefreshStarted
  releaseProfileRefresh()
  await recoveryPopup.locator('.recoveryConfirmation input').check()
  await recoveryPopup.getByTestId('confirm-recovery-key').click()
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

test('忘记密码：使用恢复密钥并要求保存轮换后的新密钥', async ({
  page,
  request,
}) => {
  const name = unique('恢复旅人')
  const email = `recover_${Date.now()}@example.com`
  const registration = await request.post('/api/user/register', {
    headers: { origin: BASE, 'x-forwarded-for': '203.0.113.91' },
    data: { name, email, password: PASSWORD },
  })
  expect(registration.status()).toBe(201)
  const originalKey = (await registration.json()).data.recoveryKey

  await page.goto('/')
  await expectVisitor(page)

  await openLoginPopup(page)
  await page.getByText(/忘记密码/).click()

  const recoveryForm = page.locator('#popups .loginPopup')
  await expect(recoveryForm.locator('h2')).toContainText('使用恢复密钥找回账号')
  await expect(recoveryForm).not.toContainText('重置邮件')
  await recoveryForm.locator('input').nth(0).fill(email)
  await recoveryForm.locator('input').nth(1).fill(originalKey)
  await recoveryForm.locator('input').nth(2).fill('recovered-password-123')
  await recoveryForm.locator('input').nth(3).fill('recovered-password-123')
  await recoveryForm.locator('.okBtn').click()

  const newKey = await confirmRecoveryKey(page)
  expect(newKey).not.toBe(originalKey)
  const loginPopup = page.locator('#popups .loginPopup')
  await expect(loginPopup).toBeVisible()
  await loginPopup.locator('input').nth(0).fill(name)
  await loginPopup.locator('input').nth(1).fill('recovered-password-123')
  await loginPopup.locator('.okBtn').click()
  await expectLoggedIn(page, name)
})

test('已有用户：输入当前密码后可重新生成恢复密钥', async ({ page }) => {
  await page.goto('/')
  await loginByIdentifier(page, user1Name, PASSWORD)
  await page.locator('#userInfo').click()
  const userHome = page.locator('#popups .userHome')
  await expect(userHome).toBeVisible()
  await userHome.locator('.useraction > div').first().hover()
  await userHome.getByText('重新生成恢复密钥', { exact: true }).click()

  const setup = page.locator('#popups .recoveryKeySetupPopup')
  await expect(setup).toBeVisible()
  await setup.locator('input').fill(PASSWORD)
  await setup.locator('.okBtn').click()
  const rotatedKey = await confirmRecoveryKey(page)
  expect(rotatedKey).not.toBe(user1RecoveryKey)
})

test('取消发送后鼠标离开再进入可重新展开留言区', async ({ page }) => {
  await page.goto('/')
  await loginByIdentifier(page, user1Name, PASSWORD)
  await liftPanel(page)
  await page.locator('#newMsg').click()
  await expect(page.locator('#newCommentBox')).toBeVisible()
  await page.locator('#cancelSendBtn').click()
  await expect(page.locator('#newCommentBox')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.style.overscrollBehavior || '',
      ),
    )
    .toBe('')
  await leaveAndReliftPanel(page)
  await expect(page.locator('#newMsg')).toBeVisible()
})

test('按 Escape 收起后鼠标离开再进入可重新展开留言区', async ({ page }) => {
  await page.goto('/')
  await liftPanel(page)
  await page.keyboard.press('Escape')
  await expectPanelCollapsed(page)
  await leaveAndReliftPanel(page)
  await expect(page.locator('#comments')).toBeVisible()
})

test('发布留言：新留言卡片出现且编号为 #1', async ({ page }) => {
  let commentListRequests = 0
  await page.route('**/api/comments*', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === 'GET' && url.pathname === '/api/comments') {
      commentListRequests += 1
    }
    await route.continue()
  })
  await page.goto('/')
  await expectVisitor(page)

  await loginByIdentifier(page, user1Name, PASSWORD)
  await expectLoggedIn(page, user1Name)

  await liftPanel(page)
  await page.locator('#newMsg').click()
  await expect(page.locator('#msgPopupAvatar')).toHaveAttribute(
    'src',
    await page.locator('#userInfoAvatar').getAttribute('src'),
  )
  await expect(page.locator('#senderText')).toHaveText(user1Name)
  await typeMessage(page, user1Message)
  const listRequestsBeforePost = commentListRequests
  await sendMessageAndWaitNewCard(page, 1)
  expect(commentListRequests).toBe(listRequestsBeforePost)
  await leaveAndReliftPanel(page)

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

test('点赞支持键盘操作，快速重复触发只计一次', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)

  await loginByIdentifier(page, user1Name, PASSWORD)
  await expectLoggedIn(page, user1Name)

  await liftPanel(page)
  const card = page.locator('#comments .commentItem').first()
  const likeBtn = card.locator('.btn.like')
  await expect(likeBtn).toBeVisible()

  let likeRequests = 0
  let releaseLike = () => {}
  const likeGate = new Promise((resolve) => {
    releaseLike = resolve
  })
  await page.route(/\/api\/comments\/like\?commentId=/, async (route) => {
    likeRequests += 1
    await likeGate
    await route.continue()
  })

  await likeBtn.focus()
  await page.keyboard.press('Enter')
  await expect(likeBtn).toHaveClass(/busy/)
  await expect(likeBtn).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => likeRequests).toBe(1)
  await likeBtn.click({ force: true })
  expect(likeRequests).toBe(1)
  releaseLike()

  await expect(card.locator('.like-count')).toHaveText('1')
  await expect(likeBtn).not.toHaveClass(/busy/)
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
  const gotoInput = page.locator('#goto')
  const jumpResponse = page.waitForResponse(
    (response) =>
      response.url().includes('/api/comments') &&
      response.url().includes('number=1'),
    { timeout: 10_000 },
  )
  await gotoInput.fill('1')
  await gotoInput.press('Enter')
  await jumpResponse

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

  // 延迟认证请求,制造初始化未完成窗口
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
  // 点击新留言触发 ensureLoggedIn → 复用首次 /user/me Promise
  await liftPanel(page)
  await page.locator('#newMsg').click()
  await expect(page.locator('#popups .loginPopup')).toBeVisible()
  await page.waitForTimeout(200)
  expect(meRequests).toBe(1)
})

test('已登录头像：缓存资料立即显示且不重复请求 /user/me', async ({ page }) => {
  let meRequests = 0
  await page.route('**/api/user/me', async (route) => {
    meRequests += 1
    await route.continue()
  })
  await page.goto('/')
  await loginByIdentifier(page, user1Name, PASSWORD)
  await expectLoggedIn(page, user1Name)
  const requestsBeforeOpen = meRequests

  await page.locator('#userInfo').click()
  const userHome = page.locator('#popups .userHome')
  await expect(userHome).toBeVisible()
  await expect(userHome.locator('.userinfo')).toContainText(user1Name)
  expect(meRequests).toBe(requestsBeforeOpen)
})

test('留言加载失败：保留置顶卡并提供重试入口', async ({ page }) => {
  await page.route('**/api/comments/public*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 503,
        message: '测试加载失败',
        data: null,
      }),
    }),
  )
  await page.goto('/')
  await liftPanel(page)
  await expect(page.locator('#topComment')).toBeVisible()
  await expect(page.locator('#comments .commentsLoadError')).toBeVisible()
  await expect(page.locator('#comments .loadingCircle')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /重新加载|Retry/ }),
  ).toBeVisible()
})

test('举报按钮：留言先加载、用户后登录时自动出现', async ({ page }) => {
  await page.goto('/')
  await expectVisitor(page)
  await liftPanel(page)
  await expect(page.locator('#comments .commentItem').first()).toBeVisible()
  await expect(page.locator('#comments .btn.report')).toHaveCount(0)

  // 第二个用户登录(其没有留言,user1 的留言可见 → 举报按钮出现)
  const reporter = unique('举报旅人')
  await registerViaPopup(
    page,
    reporter,
    `rp_${Date.now()}@example.com`,
    PASSWORD,
  )
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
  expect(
    await page.evaluate(() => localStorage.getItem('elytrue.profileHint')),
  ).toBeNull()
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
