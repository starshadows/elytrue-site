import { expect, test } from '@playwright/test'

test('站点只保留展示功能并固定显示备案信息', async ({ page }) => {
  const apiRequests = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) {
      apiRequests.push(request.url())
    }
  })

  await page.goto('/')
  await expect(page.locator('#userInfo')).toHaveCount(0)
  await expect(page.locator('#lowerPanel')).toHaveCount(0)
  await expect(page.locator('#comments')).toHaveCount(0)
  await expect(page.locator('#siteControls')).toHaveCount(0)
  await expect(page.locator('#menu')).toHaveCount(0)
  await expect(page.getByText(/发送留言|New message/)).toHaveCount(0)
  expect(apiRequests).toEqual([])

  const legal = page.locator('.siteLegalLinks')
  await expect(legal).toBeVisible()
  await expect(legal).toHaveCSS('position', 'fixed')
  await expect(legal).toHaveCSS('bottom', '0px')
  await expect(legal).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(legal).toHaveCSS('background-image', 'none')
  await expect(legal).toHaveCSS('backdrop-filter', 'none')
  await expect(legal).toHaveCSS('box-shadow', 'none')
  expect(
    await legal.evaluate(
      (element) => getComputedStyle(element, '::before').content,
    ),
  ).toBe('none')
  await expect(legal.getByText('赣ICP备2026015414号')).toBeVisible()
  await expect(legal.getByText('赣公网安备36073502000226号')).toBeVisible()
  await expect(legal.locator('a')).toHaveCount(2)
})

test('左上角主题入口提供主题卡片、音乐列表、背景下载与显示设置', async ({
  page,
}) => {
  await page.goto('/')
  await page.locator('.mainTitleUnder').click()
  const popup = page.locator('[data-popup-name="themeSelectorPopup"]')
  await expect(popup).toBeVisible()
  await expect(popup.getByText(/主题\s*&\s*音乐/)).toBeVisible()
  await expect(popup.getByText('显示设置')).toBeVisible()
  await expect(popup.getByText('下载背景图片')).toBeVisible()
  await expect(page.locator('#themeList > div')).toHaveCount(10)
  await expect(page.locator('#songList > li')).toHaveCount(11)
  await expect(
    page.locator('#themeList [data-theme="birthday-video"] img'),
  ).toHaveCSS('object-position', '50% 30%')
  await expect(page.getByText(/刷新留言|跳转到留言|发送留言/)).toHaveCount(0)

  await popup.getByText('显示设置').click()
  await expect(page.locator('#displaySettings')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('#displaySettings')).toHaveCount(0)

  await popup.getByText('下载背景图片').click()
  await expect(page.locator('#getImgPopup')).toBeVisible()
  await expect(
    page.locator('#getImgPopup .backgroundDownloadGroup'),
  ).toHaveCount(2)
})

test('首次背景轮换与后续轮换保持一致的淡出过渡动画', async ({ page }) => {
  await page.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout.bind(window)
    window.setTimeout = (callback, timeout = 0, ...args) =>
      nativeSetTimeout(callback, timeout === 8_000 ? 600 : timeout, ...args)
  })
  await page.goto('/')
  await page.locator('.mainTitleUnder').click()
  await page.locator('#themeList [data-theme="mainline"]').click()

  const visible = page.locator('.mainbg.visible')
  await expect(visible).toHaveAttribute('data-theme-id', 'mainline')
  await expect(visible).toHaveClass(/\bbgzoom\b/u)
  const firstId = await visible.getAttribute('data-background-id')
  expect(firstId).toBeTruthy()
  expect(
    await visible.evaluate((el) => getComputedStyle(el).transitionDuration),
  ).toBe('0s')

  await expect
    .poll(() => visible.getAttribute('data-background-id'))
    .not.toBe(firstId)

  const outgoingFirst = page.locator(
    `.mainbg[data-theme-id="mainline"][data-background-id="${firstId}"]`,
  )
  const firstTransition = await outgoingFirst.evaluate((el) => ({
    transitionDuration: getComputedStyle(el).transitionDuration,
    opacity: Number(getComputedStyle(el).opacity),
  }))
  expect(firstTransition.transitionDuration).toBe('2s')
  expect(firstTransition.opacity).toBeGreaterThan(0)
})

test('已撤下的交互接口统一返回 404，健康检查返回 display-only', async ({
  request,
}) => {
  const health = await request.get('/api/health')
  expect(health.status()).toBe(200)
  const body = await health.json()
  expect(body.data.mode).toBe('display-only')

  for (const [method, path] of [
    ['post', '/api/user/register'],
    ['post', '/api/user/login'],
    ['get', '/api/user/me'],
    ['get', '/api/comments'],
    ['post', '/api/comments/post'],
    ['post', '/api/uploads/image'],
    ['post', '/api/admin/bootstrap'],
  ]) {
    const response = await request[method](path)
    expect(response.status(), `${method.toUpperCase()} ${path}`).toBe(404)
  }
})
