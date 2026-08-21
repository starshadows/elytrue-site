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
  await expect(legal.getByText('赣ICP备2026015414号')).toBeVisible()
  await expect(legal.getByText('赣公网安备36073502000226号')).toBeVisible()
  await expect(legal.locator('a')).toHaveCount(2)
})

test('左上角主题入口继续提供音乐与展示设置', async ({ page }) => {
  await page.goto('/')
  await page.locator('.mainTitleUnder').click()
  const popup = page.locator('[data-popup-name="themeSelectorPopup"]')
  await expect(popup).toBeVisible()
  await expect(popup.getByText(/主题\s*&\s*音乐/)).toBeVisible()
  await expect(popup.getByText('显示设置')).toBeVisible()
  await expect(popup.getByText('下载背景图片')).toBeVisible()
  await expect(page.getByText(/刷新留言|跳转到留言|发送留言/)).toHaveCount(0)
})

test('已撤下的交互接口统一返回 404', async ({ request }) => {
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
