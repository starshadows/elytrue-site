import { expect, test } from '@playwright/test'

const popup = (page, name) =>
  page.locator(`#popups [data-popup-name="${name}"]`)

async function openTheme(page) {
  await page.locator('.mainTitleUnder').click()
  await expect(popup(page, 'themeSelectorPopup')).toBeVisible()
}

async function openGalleryFromTheme(page) {
  await popup(page, 'themeSelectorPopup').getByText('下载背景图片').click()
  await expect(popup(page, 'getImgPopup')).toBeVisible()
}

async function expectHigherLayer(page, upperName, lowerName) {
  const upper = popup(page, upperName)
  const lower = popup(page, lowerName)
  const [upperZ, lowerZ] = await Promise.all([
    upper.evaluate((element) => Number(getComputedStyle(element).zIndex)),
    lower.evaluate((element) => Number(getComputedStyle(element).zIndex)),
  ])
  expect(upperZ).toBeGreaterThan(lowerZ)
  await expect(upper).toHaveAttribute('data-topmost', 'true')
  await expect(lower.locator('.popupItem')).toHaveAttribute('inert', '')
}

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-app-ready', 'true')
})

test('popup stack follows open order and closes one layer at a time', async ({
  page,
}) => {
  await openTheme(page)
  const theme = popup(page, 'themeSelectorPopup')
  const download = theme.getByText('下载背景图片')

  await download.evaluate((element) => {
    element.click()
    element.click()
  })
  const gallery = popup(page, 'getImgPopup')
  await expect(gallery).toHaveCount(1)
  await expect(gallery).toBeVisible()
  await expectHigherLayer(page, 'getImgPopup', 'themeSelectorPopup')

  const themeLinkBox = await theme.getByText('显示设置').boundingBox()
  expect(themeLinkBox).not.toBeNull()
  const topAtThemeLink = await page.evaluate(
    ({ x, y }) => {
      return document
        .elementFromPoint(x, y)
        ?.closest('[data-popup-name]')
        ?.getAttribute('data-popup-name')
    },
    {
      x: themeLinkBox.x + themeLinkBox.width / 2,
      y: themeLinkBox.y + themeLinkBox.height / 2,
    },
  )
  expect(topAtThemeLink).toBe('getImgPopup')

  await gallery.locator('.closeBtn').click()
  expect(themeLinkBox).not.toBeNull()
  await page.mouse.click(
    themeLinkBox.x + themeLinkBox.width / 2,
    themeLinkBox.y + themeLinkBox.height / 2,
  )
  await expect(popup(page, 'displaySettings')).toHaveCount(0)
  await expect(gallery).toHaveCount(0)
  await expect(theme).toBeVisible()
  await expect(theme.locator('.popupItem')).not.toHaveAttribute('inert', '')

  await theme.getByText('显示设置').click()
  const display = popup(page, 'displaySettings')
  await expect(display).toBeVisible()
  await expectHigherLayer(page, 'displaySettings', 'themeSelectorPopup')

  await page.keyboard.press('Escape')
  await expect(display).toHaveCount(0)
  await expect(theme).toBeVisible()
  await expect(theme).toHaveAttribute('data-topmost', 'true')

  await page.keyboard.press('Escape')
  await expect(theme).toBeHidden()
  await expect(page.locator('#popups .popupContainer:visible')).toHaveCount(0)
})

test('mobile popup stack remains ordered, fitted, and interactive', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openTheme(page)
  await openGalleryFromTheme(page)
  await expectHigherLayer(page, 'getImgPopup', 'themeSelectorPopup')

  const galleryItem = popup(page, 'getImgPopup').locator('.popupItem')
  const box = await galleryItem.boundingBox()
  expect(box).not.toBeNull()
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.y).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  expect(box.y + box.height).toBeLessThanOrEqual(844)

  await page.keyboard.press('Escape')
  await expect(popup(page, 'getImgPopup')).toHaveCount(0)
  const theme = popup(page, 'themeSelectorPopup')
  await expect(theme).toBeVisible()
  await expect(theme).toHaveAttribute('data-topmost', 'true')
  await theme.getByText('显示设置').click()
  await expect(popup(page, 'displaySettings')).toBeVisible()
})
