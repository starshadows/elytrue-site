import { expect, test } from '@playwright/test'

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

async function send(page, text) {
  await page.locator('#msgText').fill(text)
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url().endsWith('/api/comments/post') &&
      candidate.request().method() === 'POST',
  )
  await page.locator('#sendBtn').click()
  const result = await response
  expect(result.status()).toBe(201)
  await expect(page.locator('#newCommentBox')).toHaveCount(0)
  return (await result.json()).data
}

test.beforeEach(async ({ page, context }) => {
  await page.request.post('/__test/reset')
  await context.clearCookies()
})

test.afterEach(async ({ page }) => {
  await page.request.post('/__test/reset')
})

test('guest journal survives reload, regressed Fast falls back once, and ACK restores reconciliation', async ({
  page,
}) => {
  await page.goto('/')
  await liftPanel(page)
  await page.locator('#newMsg').click()
  const created = await send(page, '刷新一致性留言')
  const revision = created.visibleSinceRevision
  expect(Number.isSafeInteger(revision)).toBe(true)
  await expect(
    page
      .locator('#comments .commentItem')
      .filter({ hasText: '刷新一致性留言' }),
  ).toHaveCount(1)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem('elytrue:local-comments:v1')
        return raw ? JSON.parse(raw).entries.length : 0
      }),
    )
    .toBe(1)

  await page.evaluate((highWatermark) => {
    sessionStorage.setItem(
      'elytrue:comments-consistency:v1',
      JSON.stringify({
        version: 1,
        lastAcceptedSnapshotRevision: highWatermark,
      }),
    )
  }, revision)

  let phase = 'regressed'
  let fastRequests = 0
  let nodeRequests = 0
  page.on('request', (request) => {
    if (request.method() !== 'GET') return
    const pathname = new URL(request.url()).pathname
    if (pathname === '/api/comments/public-fast') fastRequests += 1
    if (pathname === '/api/comments/public') nodeRequests += 1
  })
  await page.route('**/api/comments/public-fast*', async (route) => {
    const accepted = phase === 'accepted'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 1,
        message: 'OK',
        data: {
          items: [],
          hasMore: false,
          todayCount: accepted ? 0 : 1,
          snapshotGeneratedAt: Date.now(),
          ...(accepted
            ? { snapshotRevision: revision + 1 }
            : revision > 1
              ? { snapshotRevision: revision - 1 }
              : {}),
        },
      }),
    })
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(
    page
      .locator('#comments .commentItem')
      .filter({ hasText: '刷新一致性留言' }),
  ).toHaveCount(1)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = sessionStorage.getItem('elytrue:local-comments:v1')
        return raw ? JSON.parse(raw).entries.length : -1
      }),
    )
    .toBe(0)
  expect(fastRequests).toBe(1)
  expect(nodeRequests).toBe(1)

  phase = 'accepted'
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(
    page
      .locator('#comments .commentItem')
      .filter({ hasText: '刷新一致性留言' }),
  ).toHaveCount(0)
  expect(fastRequests).toBe(2)
  expect(nodeRequests).toBe(1)
})

test('a visitor posts and replies anonymously without receiving account powers', async ({
  page,
}) => {
  await page.goto('/')
  await liftPanel(page)
  await page.locator('#newMsg').click()
  await expect(page.locator('#newCommentBox')).toBeVisible()
  await expect(page.locator('#senderText')).toContainText('匿名用户')
  await expect(page.locator('#uploadImgPicker')).toHaveCount(0)
  await expect(page.locator('#popups .loginPopup')).toHaveCount(0)
  await send(page, '匿名首条留言')

  const first = page.locator('#comments .commentItem').first()
  await expect(first).toContainText('匿名首条留言')
  await expect(first.locator('.sender')).toContainText('匿名用户')
  await expect(first.locator('.btn.report')).toHaveCount(0)

  await first.locator('.btn.reply').dispatchEvent('click')
  await expect(page.locator('#newCommentReplyQuote')).toContainText(
    '匿名首条留言',
  )
  await send(page, '匿名回复留言')
  await expect(page.locator('#comments .commentItem').first()).toContainText(
    '匿名回复留言',
  )
})
