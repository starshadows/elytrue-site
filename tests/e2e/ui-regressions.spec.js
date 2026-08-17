import { expect, test } from '@playwright/test'

function commentRecord() {
  return {
    id: 101,
    number: 101,
    displayId: 101,
    uid: 'report-author',
    sender: '举报样式测试用户',
    avatar: '',
    comment: '用于验证评论操作区的举报按钮样式。',
    image: '',
    replyid: null,
    time: Math.floor(Date.now() / 1000),
    hidden: false,
    liked: false,
    likes: 0,
  }
}

async function fulfill(route, data) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ code: 1, message: 'OK', data }),
  })
}

test('theme popup link underlines share the same bottom edge across languages and root scales', async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem('mutebgm', 'true'))
  await page.goto('/')

  for (const language of ['zh', 'en']) {
    await page.evaluate(
      (value) => localStorage.setItem('lang', value),
      language,
    )
    await page.reload()
    for (const rootSize of [14, 16, 20]) {
      await page.evaluate(
        (value) => (document.documentElement.style.fontSize = `${value}px`),
        rootSize,
      )
      await page.locator('.mainTitleUnder').click()
      await expect(page.locator('#themeSelectorPopup')).toBeVisible()
      const bottoms = await page
        .locator('#themeSelectorPopup .underlinedIconLink')
        .evaluateAll((links) =>
          links.map((link) => link.getBoundingClientRect().bottom),
        )
      expect(bottoms).toHaveLength(2)
      expect(Math.abs(bottoms[0] - bottoms[1])).toBeLessThanOrEqual(1)
      await page.keyboard.press('Escape')
    }
  }
})

test('report action stays white for normal, hover, focus and disabled states', async ({
  page,
}) => {
  const record = commentRecord()
  await page.addInitScript(() => localStorage.setItem('mutebgm', 'true'))
  await page.route('**/api/comments/public*', (route) =>
    fulfill(route, {
      items: [record],
      hasMore: false,
      nextCursor: null,
      todayCount: 1,
    }),
  )
  await page.route('**/api/user/me', (route) =>
    fulfill(route, {
      id: 'report-viewer',
      uid: 103,
      name: '举报测试访客',
      avatar: '',
      role: 'user',
      csrfToken: 'report-style-csrf',
    }),
  )
  await page.route('**/api/comments/count', (route) => fulfill(route, 1))
  await page.route('**/api/comments/viewer-likes*', (route) =>
    fulfill(route, []),
  )
  await page.goto('/')
  await expect(page.locator('#userInfoName')).toHaveText('举报测试访客')
  await page.waitForFunction(
    () =>
      !document.getElementById('lowerPanel')?.classList.contains('animating'),
  )
  await page
    .locator('#lowerPanel')
    .evaluate((panel) => panel.classList.add('lowerPanelUp'))
  const report = page.locator('#comments .commentItem .btn.report')
  await report.evaluate((button) =>
    button.closest('.commentItem')?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
    }),
  )
  await expect(report).toBeVisible()
  await expect(report).toHaveCSS('color', 'rgb(255, 255, 255)')
  await report.hover()
  await expect(report).toHaveCSS('color', 'rgb(255, 255, 255)')
  await report.focus()
  await expect(report).toHaveCSS('color', 'rgb(255, 255, 255)')
  await report.evaluate((button) => {
    button.disabled = true
  })
  await expect(report).toHaveCSS('color', 'rgb(255, 255, 255)')
  await expect(report).toHaveCSS('opacity', '0.55')
})
