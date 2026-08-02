import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const OUTPUT = fileURLToPath(new URL('./baseline/', import.meta.url))
const PASSWORD = 'baseline-password-123'

async function capture(page, name) {
    await page.screenshot({
        path: `${OUTPUT}${name}.png`,
        animations: 'disabled',
    })
}

async function liftPanel(page) {
    await page.waitForFunction(() => !document.querySelector('#lowerPanel')?.classList.contains('animating'))
    await page.mouse.move(720, 780)
    await page.waitForFunction(() => {
        const panel = document.querySelector('#lowerPanel')
        return panel?.matches(':hover') && panel.getBoundingClientRect().top < 430
    })
}

test.skip(process.env.CAPTURE_BASELINE !== '1', 'Only runs when explicitly capturing the pre-refactor baseline')

test('capture pre-refactor desktop and mobile states', async ({ page, context }) => {
    await mkdir(OUTPUT, { recursive: true })
    await page.request.post('/__test/reset')
    await context.clearCookies()
    await page.addInitScript(() => {
        Math.random = () => 0
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('/')
    await expect(page.locator('#userInfoName')).toHaveText(/访客/)

    await capture(page, 'desktop-home')

    await liftPanel(page)
    await page.locator('#menu').hover()
    await capture(page, 'desktop-tools-menu')

    await page.getByText('主题&音乐设置').click()
    await expect(page.locator('#themeSelectorPopup')).toBeVisible()
    await capture(page, 'desktop-theme-music')
    await page.locator('#themeSelectorPopup .closeBtn').click()

    await liftPanel(page)
    await page.locator('#menu').hover()
    await page.locator('#menu').getByText('保存背景图片').click()
    await expect(page.locator('#getImgPopup')).toBeVisible()
    await capture(page, 'desktop-background-download')
    await page.locator('#getImgPopup .closeBtn').click()

    await liftPanel(page)
    await page.locator('#userInfo').click()
    await expect(page.locator('#popups .loginPopup')).toBeVisible()
    await capture(page, 'desktop-login')
    await page.getByText(/第一次来/).click()
    await expect(page.locator('#popups .loginPopup h2')).toContainText('注册账号')
    await capture(page, 'desktop-register')
    await page.locator('#popups .closeBtn').last().click()

    const registerResponse = await page.request.post('/api/user/register', {
        data: {
            name: '基线管理员',
            email: 'baseline-admin@example.com',
            password: PASSWORD,
        },
        headers: { origin: 'http://127.0.0.1:4173' },
    })
    expect(registerResponse.status()).toBe(201)
    const registerBody = await registerResponse.json()
    const csrfToken = registerBody.data.csrfToken
    const postResponse = await page.request.post('/api/comments/post', {
        data: { comment: '愿花与星辉伴你同行♪', image: [] },
        headers: {
            origin: 'http://127.0.0.1:4173',
            'x-csrf-token': csrfToken,
        },
    })
    expect(postResponse.status()).toBe(201)
    const bootstrapResponse = await page.request.post('/api/admin/bootstrap', {
        data: {},
        headers: {
            origin: 'http://127.0.0.1:4173',
            'x-csrf-token': csrfToken,
            'x-admin-bootstrap-secret': 'e2e-bootstrap-secret',
        },
    })
    expect(bootstrapResponse.ok()).toBeTruthy()

    await page.reload()
    await expect(page.locator('#userInfoName')).toHaveText('基线管理员')
    await expect(page.locator('#comments .commentItem')).toHaveCount(1)
    await capture(page, 'desktop-comments')

    await liftPanel(page)
    await page.locator('#newMsg').click()
    await expect(page.locator('#newCommentBox')).toBeVisible()
    await capture(page, 'desktop-new-comment')
    await page.locator('#cancelSendBtn').click()

    await page.locator('#userInfo').click()
    await expect(page.locator('#popups .userHome')).toBeVisible()
    await capture(page, 'desktop-user-home')
    await page.getByText('管理举报与留言').click()
    await expect(page.locator('#popups .adminPanel')).toBeVisible()
    await capture(page, 'desktop-admin')
    await page.locator('#popups .closeBtn').last().click()

    await context.clearCookies()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.locator('#userInfoName')).toHaveText(/访客/)
    await capture(page, 'mobile-home')
})
