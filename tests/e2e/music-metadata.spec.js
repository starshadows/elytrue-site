import { expect, test } from '@playwright/test'

const TRACKS = [
  {
    file: 'miss-elf-magical-invitation.mp3',
    title: "妖精小姐的魔法邀约 Miss Elf's Magical Invitation",
    artist: '宴宁/HOYO-MiX',
    album: '崩坏3-故星铭于长空-Original Soundtrack',
  },
  {
    file: '黄龄 HOYO-MiX - TruE.mp3',
    title: 'TruE',
    artist: '黄龄/HOYO-MiX',
    album: 'TruE',
  },
  {
    file: 'HOYO-MiX - Conflict.mp3',
    title: 'Conflict',
    artist: 'HOYO-MiX',
    album: '崩坏3-Elysium-Original Soundtrack',
  },
  {
    file: 'HOYO-MiX - Elysia.mp3',
    title: 'Elysia',
    artist: 'HOYO-MiX',
    album: '崩坏3-Elysium-Original Soundtrack',
  },
  {
    file: 'HOYO-MiX - Elysian Realm.mp3',
    title: 'Elysian Realm',
    artist: 'HOYO-MiX',
    album: '崩坏3-Elysium-Original Soundtrack',
  },
  {
    file: 'HOYO-MiX - Erupt.mp3',
    title: 'Erupt',
    artist: 'HOYO-MiX',
    album: '崩坏3-Elysium-Original Soundtrack',
  },
  {
    file: 'HOYO-MiX - ForEly.mp3',
    title: 'ForEly',
    artist: 'HOYO-MiX',
    album: '崩坏3-Elysium-Original Soundtrack',
  },
  {
    file: 'HOYO-MiX - Last Waltz.mp3',
    title: 'Last Waltz',
    artist: 'HOYO-MiX',
    album: '崩坏3-Elysium-Original Soundtrack',
  },
  {
    file: 'HOYO-MiX - Subtle.mp3',
    title: 'Subtle',
    artist: 'HOYO-MiX',
    album: '崩坏3-Elysium-Original Soundtrack',
  },
  {
    file: 'HOYO-MiX - Sweet Trap.mp3',
    title: 'Sweet Trap',
    artist: 'HOYO-MiX',
    album: '崩坏3-Paradox-Original Soundtrack',
  },
  {
    file: 'HOYO-MiX - The Flawless Human.mp3',
    title: 'The Flawless Human',
    artist: 'HOYO-MiX',
    album: '崩坏3-跨越终焉之日-Original Soundtrack',
  },
]

async function prepareMusic(page) {
  await page.addInitScript(() => {
    Math.random = () => 0
    localStorage.setItem('mutebgm', 'true')
  })
  await page.goto('/?musicDebug=1')
  await expect(page.locator('#songList > li')).toHaveCount(TRACKS.length)
}

async function imageDetails(page) {
  return page.locator('#musicImg').evaluate(async (element) => {
    const image = new Image()
    image.src = element.src
    await image.decode()
    const session = navigator.mediaSession.metadata
    return {
      source: element.src,
      width: image.naturalWidth,
      height: image.naturalHeight,
      clickable: element.dataset.artwork,
      media: session
        ? {
            title: session.title,
            artist: session.artist,
            album: session.album,
            artwork: session.artwork[0]?.src,
          }
        : null,
    }
  })
}

async function selectTrack(page, title) {
  await page.locator('#songList > li').evaluateAll((items, expected) => {
    const target = items.find((item) => item.textContent?.trim() === expected)
    if (!(target instanceof HTMLElement))
      throw new Error(`Missing track: ${expected}`)
    target.click()
  }, title)
  await expect(page.locator('#musicImg')).toHaveAttribute('src', /^blob:/u)
  await expect(page.locator('#musicImg')).toHaveAttribute(
    'data-artwork',
    'true',
  )
}

test('real HTTP metadata uses Range GET and all official tracks share decoded artwork with Media Session', async ({
  page,
}) => {
  const requests = []
  const responses = []
  page.on('request', (request) => {
    if (request.resourceType() !== 'xhr') return
    if (!new URL(request.url()).pathname.endsWith('.mp3')) return
    requests.push({ method: request.method(), range: request.headers().range })
  })
  page.on('response', (response) => {
    const request = response.request()
    if (request.resourceType() !== 'xhr') return
    if (!new URL(response.url()).pathname.endsWith('.mp3')) return
    responses.push({ status: response.status(), headers: response.headers() })
  })
  await prepareMusic(page)

  await page.locator('#musicImg').dispatchEvent('click')
  await expect(page.locator('.img-viewer-overlay')).not.toBeVisible()
  await page.locator('#musicPlayBtn').dispatchEvent('click')

  for (const track of TRACKS) {
    await selectTrack(page, track.title)
    const details = await imageDetails(page)
    expect(details).toMatchObject({
      width: 1200,
      height: 1200,
      clickable: 'true',
      media: {
        title: track.title,
        artist: track.artist,
        album: track.album,
        artwork: details.source,
      },
    })
  }

  expect(requests.length).toBeGreaterThanOrEqual(TRACKS.length * 2)
  expect(requests.every((request) => request.method === 'GET')).toBe(true)
  expect(
    requests.every((request) => /^bytes=\d+-\d*$/u.test(request.range)),
  ).toBe(true)
  expect(responses.every((response) => response.status === 206)).toBe(true)
  expect(
    responses.every(
      (response) =>
        response.headers['content-type']?.includes('audio/mpeg') &&
        /^bytes \d+-\d+\/\d+$/u.test(response.headers['content-range']),
    ),
  ).toBe(true)

  const bytesByTrack = new Map()
  for (const response of responses) {
    const match = response.headers['content-range'].match(
      /^bytes (\d+)-(\d+)\/(\d+)$/u,
    )
    if (!match) continue
    const total = Number(match[3])
    const key = total
    const entry = bytesByTrack.get(key) ?? { read: 0, total }
    entry.read += Number(match[2]) - Number(match[1]) + 1
    bytesByTrack.set(key, entry)
  }
  expect(
    [...bytesByTrack.values()].every((entry) => entry.read < entry.total),
  ).toBe(true)

  await page.locator('#musicImg').dispatchEvent('click')
  await expect(page.locator('.img-viewer-overlay')).toBeVisible()
  await page.keyboard.press('Escape')
})

test('track changes keep compact titles and reveal only decoded artwork', async ({
  page,
}) => {
  let delayedConflict = false
  await page.route('**/*.mp3', async (route) => {
    const request = route.request()
    const pathname = decodeURIComponent(new URL(request.url()).pathname)
    if (
      !delayedConflict &&
      request.resourceType() === 'xhr' &&
      request.headers().range === 'bytes=0-1023' &&
      pathname.endsWith('Conflict.mp3')
    ) {
      delayedConflict = true
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    await route.continue()
  })

  await prepareMusic(page)
  const playlistTitles = await page.locator('#songList > li').allTextContents()
  expect(playlistTitles.toSorted()).toEqual(
    TRACKS.map((track) => track.title).toSorted(),
  )
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await expect(page.locator('#musicImg')).toHaveAttribute('src', /^blob:/u)
  const oldCover = await page.locator('#musicImg').getAttribute('src')

  await page
    .locator('#songList > li')
    .filter({ hasText: /^Conflict$/u })
    .dispatchEvent('click')
  await expect(page.locator('#musicPlayer .currentSong')).toHaveText('Conflict')
  await expect(page.locator('#musicImg')).toHaveAttribute('aria-busy', 'true')
  await expect(page.locator('#musicImg')).toHaveCSS('visibility', 'hidden')
  await expect(page.locator('#musicImg')).toHaveAttribute('src', oldCover)
  await expect(page.locator('#musicImg')).not.toHaveAttribute(
    'src',
    /\/res\/music_note\.svg$/u,
  )

  await expect(page.locator('#musicImg')).toHaveAttribute('src', /^blob:/u)
  await expect(page.locator('#musicImg')).not.toHaveAttribute(
    'aria-busy',
    'true',
  )
  await expect(page.locator('#musicImg')).toHaveCSS('visibility', 'visible')
  await expect(page.locator('#musicImg')).toHaveAttribute(
    'data-artwork',
    'true',
  )
  await expect
    .poll(() => page.locator('#musicImg').getAttribute('src'))
    .not.toBe(oldCover)
})

test('failed Range reads retry automatically and remain retryable on later playback', async ({
  page,
}) => {
  let defaultStarts = 0
  let conflictAbortBudget = 2
  let conflictStarts = 0
  await page.route('**/*.mp3', async (route) => {
    const request = route.request()
    const range = request.headers().range
    if (request.resourceType() !== 'xhr' || range !== 'bytes=0-1023') {
      await route.continue()
      return
    }
    const pathname = decodeURIComponent(new URL(request.url()).pathname)
    if (pathname.endsWith('Elysian Realm.mp3')) {
      defaultStarts += 1
      if (defaultStarts === 1) {
        await route.abort('failed')
        return
      }
    }
    if (pathname.endsWith('Conflict.mp3')) {
      conflictStarts += 1
      if (conflictAbortBudget > 0) {
        conflictAbortBudget -= 1
        await route.abort('failed')
        return
      }
    }
    await route.continue()
  })
  await prepareMusic(page)
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await expect(page.locator('#musicImg')).toHaveAttribute('src', /^blob:/u)
  expect(defaultStarts).toBeGreaterThanOrEqual(2)

  await page
    .locator('#songList > li')
    .filter({ hasText: 'Conflict' })
    .dispatchEvent('click')
  await page.waitForTimeout(750)
  await expect(page.locator('#musicImg')).toHaveAttribute(
    'src',
    /\/res\/music_note\.svg$/u,
  )
  await expect(page.locator('#musicImg')).not.toHaveAttribute(
    'data-artwork',
    'true',
  )
  if (
    await page
      .locator('#musicPlayBtn')
      .evaluate((button) => button.classList.contains('playing'))
  ) {
    await page.locator('#musicPlayBtn').dispatchEvent('click')
  }
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await expect(page.locator('#musicImg')).toHaveAttribute('src', /^blob:/u)
  expect(conflictStarts).toBeGreaterThanOrEqual(3)
})

test('rapid track changes retain old blobs during the grace period and revoke them safely', async ({
  page,
}) => {
  const blobErrors = []
  page.on('console', (message) => {
    if (
      /ERR_FILE_NOT_FOUND|blob:/u.test(message.text()) &&
      message.type() === 'error'
    ) {
      blobErrors.push(message.text())
    }
  })
  page.on('pageerror', (error) => blobErrors.push(error.message))
  await prepareMusic(page)
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await expect(page.locator('#musicImg')).toHaveAttribute('src', /^blob:/u)
  const oldCover = await page.locator('#musicImg').getAttribute('src')
  expect(oldCover).toBeTruthy()

  await page.locator('#songList > li').nth(1).dispatchEvent('click')
  expect(
    await page.evaluate((url) => {
      const image = new Image()
      image.src = url
      return image.decode().then(
        () => true,
        () => false,
      )
    }, oldCover),
  ).toBe(true)
  for (const index of [2, 4, 6]) {
    await page.locator('#songList > li').nth(index).dispatchEvent('click')
    await page.waitForTimeout(25)
  }
  await expect(page.locator('#musicImg')).toHaveAttribute('src', /^blob:/u)
  await expect
    .poll(() => page.locator('#musicImg').getAttribute('src'))
    .not.toBe(oldCover)
  await page.waitForTimeout(1_100)
  expect(blobErrors).toEqual([])
  expect(
    await page.evaluate((url) => {
      const image = new Image()
      image.src = url
      return image.decode().then(
        () => true,
        () => false,
      )
    }, oldCover),
  ).toBe(false)
  const current = await imageDetails(page)
  expect(current.width).toBe(1200)
  expect(current.height).toBe(1200)
})
