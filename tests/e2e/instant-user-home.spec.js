import { expect, test } from '@playwright/test'

const AVATAR_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

const profile = ({
  id = 'perf-user',
  name = '认证用户',
  avatar = 'avatar-a',
} = {}) => ({
  id,
  name,
  avatar,
  role: 'user',
  create_time: 1_700_000_000,
  hasRecoveryKey: false,
})

const comment = (id, text) => ({
  id,
  number: id,
  comment: text,
  image: '',
  time: 1_700_000_000 + id,
})

const envelope = (data, code = 1, message = 'OK') => ({
  code,
  message,
  data,
})

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

async function installHint(
  page,
  { userId = 'perf-user', name = '缓存用户', avatar = 'avatar-a' } = {},
) {
  await page.addInitScript(
    ({ userId: cachedUserId, name: cachedName, avatar: cachedAvatar }) => {
      localStorage.setItem(
        'elytrue.profileHint',
        JSON.stringify({
          version: 1,
          userId: cachedUserId,
          name: cachedName,
          avatar: cachedAvatar,
          savedAt: Date.now(),
        }),
      )
    },
    { userId, name, avatar },
  )
}

async function installApiRoutes(
  page,
  {
    authDelay = 0,
    authProfile = profile(),
    authStatus = 200,
    userDelay = 0,
    userPages = {},
    avatarStatus = 200,
    avatarDelays = {},
  } = {},
) {
  const counters = { auth: 0, user: 0, avatar: 0 }
  await page.route('**/api/user/me', async (route) => {
    counters.auth += 1
    await delay(authDelay)
    await route.fulfill({
      status: authStatus,
      contentType: 'application/json',
      body: JSON.stringify(
        envelope(
          authStatus === 200 ? authProfile : null,
          authStatus === 200 ? 1 : authStatus,
          authStatus === 200 ? 'OK' : '请先登录',
        ),
      ),
    })
  })
  await page.route('**/api/data/images/avatars/*', async (route) => {
    const name = decodeURIComponent(
      new URL(route.request().url()).pathname.split('/').pop() ?? '',
    )
    counters.avatar += 1
    await delay(avatarDelays[name] ?? 0)
    if (avatarStatus !== 200) {
      await route.fulfill({ status: avatarStatus })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: AVATAR_PNG,
    })
  })
  await page.route('**/api/comments*', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/comments' && url.searchParams.has('uid')) {
      const uid = url.searchParams.get('uid')
      counters.user += 1
      await delay(userDelay)
      const items = userPages[uid] ?? [comment(1, `${uid} 的留言`)]
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          envelope({ items, hasMore: false, nextCursor: null }),
        ),
      })
      return
    }
    if (url.pathname === '/api/comments/count') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope(0)),
      })
      return
    }
    if (url.pathname === '/api/comments/viewer-likes') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope([])),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope({ items: [], hasMore: false })),
    })
  })
  await page.route('**/api/bootstrap', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope({})),
    })
  })
  return counters
}

async function openUser(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('#userInfo').click()
  await expect(page.locator('#popups .userHome')).toBeVisible({ timeout: 500 })
}

test('hint renders immediately and user comments do not wait for auth', async ({
  page,
}) => {
  await installHint(page)
  const counters = await installApiRoutes(page, {
    authDelay: 1500,
    userDelay: 600,
    userPages: { 'perf-user': [comment(1, '并行加载的留言')] },
  })

  await openUser(page)
  const userHome = page.locator('#popups .userHome')
  await expect(userHome.locator('.userinfo')).toContainText('缓存用户', {
    timeout: 100,
  })
  await expect(userHome.locator('.userinfo')).toContainText('perf-user')
  await expect(userHome.locator('.userinfo img')).toHaveAttribute(
    'src',
    /avatar-a/,
  )
  await expect(userHome.getByText('并行加载的留言')).toBeVisible({
    timeout: 1000,
  })
  expect(counters.auth).toBe(1)
  expect(counters.user).toBe(1)
})

test('same-user auth calibration preserves avatar and comment nodes', async ({
  page,
}) => {
  await installHint(page)
  const counters = await installApiRoutes(page, {
    authDelay: 1000,
    userDelay: 100,
    authProfile: profile({ name: '服务端用户', avatar: 'avatar-a' }),
    userPages: { 'perf-user': [comment(2, '保持节点的留言')] },
  })

  await openUser(page)
  const userHome = page.locator('#popups .userHome')
  await expect(userHome.getByText('保持节点的留言')).toBeVisible()
  const avatarNode = await userHome.locator('.userinfo img').elementHandle()
  const commentNode = await userHome.locator('.userCommentItem').elementHandle()
  await expect(userHome).toContainText('服务端用户')
  await page.waitForTimeout(1100)
  expect(await avatarNode?.evaluate((node) => document.contains(node))).toBe(
    true,
  )
  expect(await commentNode?.evaluate((node) => document.contains(node))).toBe(
    true,
  )
  expect(counters.auth).toBe(1)
  expect(counters.user).toBe(1)
})

test('different auth user aborts old data and switches the popup in place', async ({
  page,
}) => {
  await installHint(page)
  const counters = await installApiRoutes(page, {
    authDelay: 1500,
    userDelay: 700,
    authProfile: profile({
      id: 'server-user',
      name: '真实用户',
      avatar: 'avatar-b',
    }),
    userPages: {
      'perf-user': [comment(3, '旧用户留言')],
      'server-user': [comment(4, '真实用户留言')],
    },
  })

  await openUser(page)
  const userHome = page.locator('#popups .userHome')
  await expect(userHome).toContainText('缓存用户')
  await expect(userHome.getByText('真实用户留言')).toBeVisible({
    timeout: 3000,
  })
  await expect(userHome).not.toContainText('旧用户留言')
  expect(counters.user).toBe(2)
})

test('auth failure replaces the existing popup container with login', async ({
  page,
}) => {
  await installHint(page)
  await installApiRoutes(page, {
    authDelay: 800,
    authStatus: 401,
    userDelay: 600,
  })

  await openUser(page)
  const popupItem = await page
    .locator('#popups .popupItem')
    .filter({ has: page.locator('.userHome') })
    .elementHandle()
  await expect(page.locator('#popups .loginPopup')).toBeVisible({
    timeout: 1000,
  })
  expect(await popupItem?.evaluate((node) => document.contains(node))).toBe(
    true,
  )
})

test('session cache is visible immediately after a page refresh', async ({
  page,
}) => {
  await installHint(page)
  const counters = await installApiRoutes(page, {
    userDelay: 500,
    userPages: { 'perf-user': [comment(5, '刷新后缓存留言')] },
  })

  await openUser(page)
  await expect(page.getByText('刷新后缓存留言')).toBeVisible({ timeout: 1000 })
  await page.reload()
  await page.locator('#userInfo').click()
  await expect(page.locator('#popups .userHome')).toContainText(
    '刷新后缓存留言',
    {
      timeout: 200,
    },
  )
  expect(counters.user).toBe(2)
})

test('pointerenter prefetch is reused by the click and actions stay hidden before auth', async ({
  page,
}) => {
  await installHint(page)
  const counters = await installApiRoutes(page, {
    authDelay: 900,
    userDelay: 500,
    userPages: { 'perf-user': [comment(6, '预取留言')] },
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await page.locator('#userInfo').hover()
  await page.waitForTimeout(100)
  await page.locator('#userInfo').click()
  const userHome = page.locator('#popups .userHome')
  await expect(userHome.locator('.useraction')).toHaveCount(0)
  await expect(userHome.getByText('退出登录')).toHaveCount(0)
  await expect(userHome.getByText('预取留言')).toBeVisible({ timeout: 1000 })
  expect(counters.user).toBe(1)
  await expect(userHome.locator('.useraction')).toBeVisible({ timeout: 1000 })
})

test('avatar keeps the old URL until the new image is ready and falls back on 404', async ({
  page,
}) => {
  await installHint(page, { avatar: 'avatar-a' })
  const counters = await installApiRoutes(page, {
    authDelay: 100,
    authProfile: profile({ avatar: 'avatar-b' }),
    avatarDelays: { 'avatar-b': 400 },
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#userInfoAvatar')).toHaveAttribute(
    'src',
    /avatar-a/,
  )
  const avatarNode = await page.locator('#userInfoAvatar').elementHandle()
  await page.waitForTimeout(150)
  await expect(page.locator('#userInfoAvatar')).toHaveAttribute(
    'src',
    /avatar-a/,
  )
  await expect(page.locator('#userInfoAvatar')).toHaveAttribute(
    'src',
    /avatar-b/,
    {
      timeout: 1000,
    },
  )
  expect(await avatarNode?.evaluate((node) => document.contains(node))).toBe(
    true,
  )
  expect(counters.auth).toBe(1)
})

test('cached avatar 404 falls back to the default image', async ({ page }) => {
  await installHint(page, { avatar: 'missing-avatar' })
  await installApiRoutes(page, {
    authProfile: profile({ avatar: 'missing-avatar' }),
    avatarStatus: 404,
  })
  await page.goto('/', { waitUntil: 'domcontentloaded' })
  await expect(page.locator('#userInfoAvatar')).toHaveAttribute(
    'src',
    /default(?:Avatar\.png|[-a-z0-9]+\.png)/,
  )
})
