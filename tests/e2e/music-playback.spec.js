import { expect, test } from '@playwright/test'

const PLAYBACK_KEY = 'musicPlaybackStateV1'
const DEFAULT_SONG = 'HOYO-MiX - Elysian Realm.mp3'
const CONFLICT_SONG = 'HOYO-MiX - Conflict.mp3'
const NEW_SONG = 'miss-elf-magical-invitation.mp3'
const NEW_SONG_TITLE = "妖精小姐的魔法邀约 Miss Elf's Magical Invitation"

async function seedPlayback(page, state, options = {}) {
  await page.addInitScript(
    ({ playbackState, rejectPlay }) => {
      Math.random = () => 0
      const nativeSetItem = Storage.prototype.setItem
      if (sessionStorage.getItem('__musicPlaybackSeeded') !== 'true') {
        nativeSetItem.call(
          localStorage,
          'musicPlaybackStateV1',
          JSON.stringify(playbackState),
        )
        nativeSetItem.call(
          localStorage,
          'mutebgm',
          String(playbackState.paused),
        )
        nativeSetItem.call(sessionStorage, '__musicPlaybackSeeded', 'true')
        nativeSetItem.call(sessionStorage, '__musicPlaybackWrites', '[]')
      }
      Storage.prototype.setItem = function (key, value) {
        if (this === localStorage && key === 'musicPlaybackStateV1') {
          const writes = JSON.parse(
            sessionStorage.getItem('__musicPlaybackWrites') ?? '[]',
          )
          writes.push(value)
          nativeSetItem.call(
            sessionStorage,
            '__musicPlaybackWrites',
            JSON.stringify(writes),
          )
        }
        nativeSetItem.call(this, key, value)
      }
      if (rejectPlay) {
        HTMLMediaElement.prototype.play = function () {
          return Promise.reject(new DOMException('Autoplay blocked'))
        }
      }
    },
    { playbackState: state, rejectPlay: options.rejectPlay ?? false },
  )
}

async function waitForRestoredTrack(page, title, seconds) {
  await expect(page.locator('#musicPlayer .currentSong')).toHaveText(title)
  await expect
    .poll(() =>
      page.locator('#musicAudio').evaluate((audio) => ({
        duration: audio.duration,
        time: audio.currentTime,
      })),
    )
    .toMatchObject({
      duration: expect.any(Number),
      time: expect.any(Number),
    })
  await expect
    .poll(() =>
      page
        .locator('#musicAudio')
        .evaluate(
          (audio, expected) =>
            Number.isFinite(audio.duration) &&
            audio.duration > 0 &&
            Math.abs(audio.currentTime - expected) < 1,
          seconds,
        ),
    )
    .toBe(true)
  await expect(page.locator('#musicImg')).toHaveAttribute('src', /^blob:/u)
  await expect(page.locator('#musicImg')).toHaveAttribute(
    'data-artwork',
    'true',
  )
}

async function playbackWrites(page) {
  return page.evaluate(() =>
    JSON.parse(sessionStorage.getItem('__musicPlaybackWrites') ?? '[]').map(
      (value) => JSON.parse(value),
    ),
  )
}

async function dispatchTouchSwipe(page, start, end, steps = 6) {
  const session = await page.context().newCDPSession(page)
  const point = (x, y) => ({
    x,
    y,
    id: 1,
    radiusX: 4,
    radiusY: 4,
    force: 1,
  })
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [point(start.x, start.y)],
  })
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        point(
          start.x + (end.x - start.x) * ratio,
          start.y + (end.y - start.y) * ratio,
        ),
      ],
    })
    await page.waitForTimeout(18)
  }
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [],
  })
  await session.detach()
}

test('the route-safe added song loads as MPEG audio and starts playing', async ({
  page,
}) => {
  const mediaResponses = []
  page.on('response', (response) => {
    if (response.url().endsWith(`/${NEW_SONG}`)) {
      mediaResponses.push(response)
    }
  })
  await seedPlayback(page, { song: NEW_SONG, currentTime: 0, paused: true })
  await page.goto('/?musicDebug=1')
  await waitForRestoredTrack(page, NEW_SONG_TITLE, 0)

  const source = await page
    .locator('#musicAudio')
    .evaluate((audio) => audio.currentSrc)
  expect(source).toContain(`/${NEW_SONG}`)
  expect(source).not.toContain("'")
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await expect
    .poll(() =>
      page.locator('#musicAudio').evaluate((audio) => ({
        paused: audio.paused,
        duration: audio.duration,
        currentTime: audio.currentTime,
      })),
    )
    .toMatchObject({ paused: false, duration: expect.any(Number) })
  await expect
    .poll(() =>
      page.locator('#musicAudio').evaluate((audio) => audio.currentTime),
    )
    .toBeGreaterThan(0)
  expect(
    mediaResponses.some(
      (response) => response.headers()['content-type'] === 'audio/mpeg',
    ),
  ).toBe(true)
})

test('Conflict + 20s survives initial sync and later image theme changes', async ({
  page,
}) => {
  await seedPlayback(page, {
    song: CONFLICT_SONG,
    currentTime: 20,
    paused: true,
  })
  await page.goto('/?musicDebug=1')
  await waitForRestoredTrack(page, 'Conflict', 20)

  const restored = await page.locator('#musicAudio').evaluate((audio) => ({
    paused: audio.paused,
    source: audio.currentSrc,
    progress: document.querySelector('#nowPlayingProgress input')?.value,
  }))
  expect(restored.paused).toBe(true)
  expect(decodeURIComponent(restored.source)).toContain(CONFLICT_SONG)
  expect(Number(restored.progress)).toBeGreaterThan(0)

  const initialWrites = await playbackWrites(page)
  expect(initialWrites.length).toBeGreaterThan(0)
  expect(
    initialWrites.every(
      (state) =>
        state.song === CONFLICT_SONG &&
        state.currentTime > 19 &&
        state.paused === true,
    ),
  ).toBe(true)

  await page.locator('.mainTitleUnder').click()
  await page.locator('#themeList > [data-theme="mainline"]').click()
  await expect(page.locator('.mainTitleUnder .currentSong')).toHaveText(
    'Conflict',
  )
  const afterThemeChange = await page
    .locator('#musicAudio')
    .evaluate((audio) => ({
      paused: audio.paused,
      currentTime: audio.currentTime,
    }))
  expect(afterThemeChange.paused).toBe(true)
  expect(afterThemeChange.currentTime).toBeCloseTo(20, 0)
})

test('autoplay rejection retains logical playing state, source, seek, artwork and progress', async ({
  page,
}) => {
  await seedPlayback(
    page,
    { song: DEFAULT_SONG, currentTime: 35, paused: false },
    { rejectPlay: true },
  )
  await page.goto('/?musicDebug=1')
  await waitForRestoredTrack(page, 'Elysian Realm', 35)

  const state = await page.locator('#musicAudio').evaluate((audio) => ({
    actualPaused: audio.paused,
    source: audio.currentSrc,
    stored: JSON.parse(localStorage.getItem('musicPlaybackStateV1')),
    mutedSetting: localStorage.getItem('mutebgm'),
    progress: Number(
      document.querySelector('#nowPlayingProgress input')?.value,
    ),
  }))
  expect(state.actualPaused).toBe(true)
  expect(decodeURIComponent(state.source)).toContain(DEFAULT_SONG)
  expect(state.stored).toMatchObject({ song: DEFAULT_SONG, paused: false })
  expect(state.stored.currentTime).toBeCloseTo(35, 0)
  expect(state.mutedSetting).toBe('false')
  expect(state.progress).toBeGreaterThan(0)
})

test('paused 42-second snapshot restores source and artwork without autoplay', async ({
  page,
}) => {
  await seedPlayback(page, {
    song: DEFAULT_SONG,
    currentTime: 42,
    paused: true,
  })
  await page.goto('/?musicDebug=1')
  await waitForRestoredTrack(page, 'Elysian Realm', 42)
  const state = await page.locator('#musicAudio').evaluate((audio) => ({
    paused: audio.paused,
    source: decodeURIComponent(audio.currentSrc),
    progress: Number(
      document.querySelector('#nowPlayingProgress input')?.value,
    ),
  }))
  expect(state.paused).toBe(true)
  expect(state.source).toContain(DEFAULT_SONG)
  expect(state.progress).toBeGreaterThan(0)
})

test('rapid track change persists only complete source/time pairs and reloads the stable seek', async ({
  page,
}) => {
  await seedPlayback(page, {
    song: DEFAULT_SONG,
    currentTime: 35,
    paused: true,
  })
  await page.goto('/?musicDebug=1')
  await waitForRestoredTrack(page, 'Elysian Realm', 35)

  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await expect
    .poll(() => page.locator('#musicAudio').evaluate((audio) => audio.paused))
    .toBe(false)
  await page
    .locator('#songList > li')
    .filter({ hasText: /^Conflict$/u })
    .dispatchEvent('click')
  await expect(page.locator('#musicPlayer .currentSong')).toHaveText('Conflict')
  await expect
    .poll(() =>
      page.locator('#musicAudio').evaluate((audio) => audio.currentTime),
    )
    .toBeGreaterThan(1)

  await page.locator('#nowPlayingProgress input').evaluate((input, seconds) => {
    const audio = document.querySelector('#musicAudio')
    if (
      !(audio instanceof HTMLAudioElement) ||
      !Number.isFinite(audio.duration)
    )
      throw new Error('Audio metadata is not ready')
    input.value = String(seconds / audio.duration)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, 20)
  await expect
    .poll(() =>
      page.locator('#musicAudio').evaluate((audio) => audio.currentTime),
    )
    .toBeCloseTo(20, 0)
  await page.locator('#musicPlayBtn').dispatchEvent('click')

  const beforeReload = await playbackWrites(page)
  expect(
    beforeReload.some(
      (state) => state.song === CONFLICT_SONG && state.currentTime <= 0.25,
    ),
  ).toBe(false)
  expect(
    beforeReload
      .filter((state) => state.song === DEFAULT_SONG)
      .every((state) => state.currentTime >= 34),
  ).toBe(true)
  expect(beforeReload.at(-1)).toMatchObject({
    song: CONFLICT_SONG,
    paused: true,
  })
  expect(beforeReload.at(-1).currentTime).toBeCloseTo(20, 0)

  await page.reload()
  await waitForRestoredTrack(page, 'Conflict', 20)
  const afterReload = await playbackWrites(page)
  expect(
    afterReload.some(
      (state) => state.song === CONFLICT_SONG && state.currentTime <= 0.25,
    ),
  ).toBe(false)
  expect(
    afterReload.some(
      (state) => state.song === DEFAULT_SONG && state.currentTime < 34,
    ),
  ).toBe(false)
})

test('a late old-source media response cannot apply its seek to the replacement track', async ({
  page,
}) => {
  await seedPlayback(page, {
    song: DEFAULT_SONG,
    currentTime: 35,
    paused: true,
  })
  await page.route('**/*.mp3', async (route) => {
    const request = route.request()
    const path = decodeURIComponent(new URL(request.url()).pathname)
    if (
      request.resourceType() === 'media' &&
      path.endsWith('Elysian Realm.mp3')
    ) {
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
    await route.continue()
  })
  await page.goto('/?musicDebug=1')
  await expect(page.locator('#songList > li')).toHaveCount(11)
  await page
    .locator('#songList > li')
    .filter({ hasText: /^Conflict$/u })
    .dispatchEvent('click')
  await expect(page.locator('#musicPlayer .currentSong')).toHaveText('Conflict')
  await expect
    .poll(() =>
      page.locator('#musicAudio').evaluate((audio) => ({
        source: decodeURIComponent(audio.currentSrc),
        time: audio.currentTime,
      })),
    )
    .toMatchObject({ source: expect.stringContaining(CONFLICT_SONG) })
  await expect
    .poll(() =>
      page.locator('#musicAudio').evaluate((audio) => audio.currentTime),
    )
    .toBeGreaterThan(1)
  const currentTime = await page
    .locator('#musicAudio')
    .evaluate((audio) => audio.currentTime)
  expect(currentTime).toBeLessThan(5)
  const writes = await playbackWrites(page)
  expect(
    writes.some(
      (state) => state.song === CONFLICT_SONG && state.currentTime > 30,
    ),
  ).toBe(false)
})

test('ratio seek waits for metadata and applies against the matching duration', async ({
  page,
}) => {
  let releaseMedia
  let markMediaRequested
  const mediaGate = new Promise((resolve) => {
    releaseMedia = resolve
  })
  const mediaRequested = new Promise((resolve) => {
    markMediaRequested = resolve
  })
  await page.addInitScript(() => {
    Math.random = () => 0
    localStorage.setItem('mutebgm', 'true')
    localStorage.removeItem('musicPlaybackStateV1')
  })
  await page.route('**/*.mp3', async (route) => {
    if (route.request().resourceType() === 'media') {
      markMediaRequested()
      await mediaGate
    }
    await route.continue()
  })
  await page.goto('/?musicDebug=1')
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await mediaRequested
  await page.locator('#nowPlayingProgress input').evaluate((input) => {
    input.value = '0.5'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(
    await page.locator('#musicAudio').evaluate((audio) => audio.readyState),
  ).toBe(0)
  releaseMedia()
  await expect
    .poll(() =>
      page
        .locator('#musicAudio')
        .evaluate((audio) =>
          audio.duration ? audio.currentTime / audio.duration : 0,
        ),
    )
    .toBeCloseTo(0.5, 2)
})

test('invalid media clocks never publish progress or playback state', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Math.random = () => 0
    localStorage.setItem('mutebgm', 'true')
    localStorage.removeItem('musicPlaybackStateV1')
  })
  await page.goto('/?musicDebug=1')
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await expect
    .poll(() =>
      page
        .locator('#musicAudio')
        .evaluate((audio) => Number.isFinite(audio.duration) && audio.duration),
    )
    .toBeGreaterThan(0)
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await page.locator('.mainTitleUnder').click()

  const stable = await page.locator('#musicAudio').evaluate((audio) => {
    audio.currentTime = 10
    audio.dispatchEvent(new Event('timeupdate'))
    return { duration: audio.duration, time: audio.currentTime }
  })
  expect(stable.time).toBeCloseTo(10, 1)

  const slider = page.locator('#nowPlayingProgress input')
  await expect
    .poll(async () => Number(await slider.inputValue()))
    .toBeGreaterThan(0)
  const previousProgress = await slider.inputValue()
  await page.locator('#musicAudio').evaluate((audio) => {
    Object.defineProperties(audio, {
      currentTime: { configurable: true, value: Number.NaN, writable: true },
      duration: { configurable: true, value: 0, writable: true },
    })
    audio.dispatchEvent(new Event('timeupdate'))
  })
  await page.waitForTimeout(550)
  expect(await slider.inputValue()).toBe(previousProgress)

  await slider.evaluate((input) => {
    input.value = '0.6'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(
    await page
      .locator('#musicAudio')
      .evaluate((audio) => Number.isNaN(audio.currentTime)),
  ).toBe(true)
  await page.locator('#musicAudio').evaluate((audio, duration) => {
    audio.duration = duration
    audio.currentTime = 0
    audio.dispatchEvent(new Event('durationchange'))
  }, stable.duration)
  await expect
    .poll(() =>
      page
        .locator('#musicAudio')
        .evaluate((audio) =>
          audio.duration ? audio.currentTime / audio.duration : 0,
        ),
    )
    .toBeCloseTo(0.6, 2)
  const persisted = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('musicPlaybackStateV1')),
  )
  expect(Number.isFinite(persisted.currentTime)).toBe(true)
})

test('mouse, keyboard and a long drag share slider commit without timer rollback', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Math.random = () => 0
    localStorage.setItem('mutebgm', 'true')
    localStorage.removeItem('musicPlaybackStateV1')
  })
  await page.goto('/?musicDebug=1')
  await page.locator('#musicPlayBtn').dispatchEvent('click')
  await expect
    .poll(() =>
      page
        .locator('#musicAudio')
        .evaluate((audio) => Number.isFinite(audio.duration) && audio.duration),
    )
    .toBeGreaterThan(0)
  await page.locator('#musicPlayBtn').dispatchEvent('click')

  await page.locator('.mainTitleUnder').click()
  await expect(page.locator('#themeSelectorPopup')).toBeVisible()

  const slider = page.locator('#nowPlayingProgress input')
  const box = await slider.boundingBox()
  if (!box) throw new Error('Progress slider is missing')
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2)
  await expect
    .poll(() =>
      page
        .locator('#musicAudio')
        .evaluate((audio) =>
          audio.duration ? audio.currentTime / audio.duration : 0,
        ),
    )
    .toBeCloseTo(0.25, 1)

  await slider.focus()
  await page.keyboard.press('ArrowRight')
  const keyboardValue = Number(await slider.inputValue())
  await expect
    .poll(() =>
      page
        .locator('#musicAudio')
        .evaluate((audio) =>
          audio.duration ? audio.currentTime / audio.duration : 0,
        ),
    )
    .toBeCloseTo(keyboardValue, 2)

  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height / 2)
  await page.waitForTimeout(650)
  const draggedValue = Number(await slider.inputValue())
  expect(draggedValue).toBeCloseTo(0.8, 1)
  const visualWidth = await page
    .locator('#nowPlayingProgress .progress')
    .evaluate((element) => Number.parseFloat(element.style.width))
  expect(visualWidth).toBeCloseTo(draggedValue * 100, 1)
  await page.mouse.up()
  await expect
    .poll(() =>
      page
        .locator('#musicAudio')
        .evaluate((audio) =>
          audio.duration ? audio.currentTime / audio.duration : 0,
        ),
    )
    .toBeCloseTo(draggedValue, 2)
})

test.describe('touch progress slider', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  })

  test('touch drag commits the same finite ratio seek', async ({ page }) => {
    await page.addInitScript(() => {
      Math.random = () => 0
      localStorage.setItem('mutebgm', 'true')
      localStorage.removeItem('musicPlaybackStateV1')
    })
    await page.goto('/?musicDebug=1')
    await page.locator('#musicPlayBtn').dispatchEvent('click')
    await expect
      .poll(() =>
        page
          .locator('#musicAudio')
          .evaluate(
            (audio) => Number.isFinite(audio.duration) && audio.duration,
          ),
      )
      .toBeGreaterThan(0)
    await page.locator('#musicPlayBtn').dispatchEvent('click')
    await page.locator('.mainTitleUnder').click()

    const slider = page.locator('#nowPlayingProgress input')
    const box = await slider.boundingBox()
    if (!box) throw new Error('Progress slider is missing')
    expect(
      await page.evaluate(
        ({ x, y }) => document.elementFromPoint(x, y)?.tagName,
        { x: box.x + 8, y: box.y + box.height / 2 },
      ),
    ).toBe('INPUT')
    await dispatchTouchSwipe(
      page,
      { x: box.x + 8, y: box.y + box.height / 2 },
      { x: box.x + box.width * 0.7, y: box.y + box.height / 2 },
    )
    const value = Number(await slider.inputValue())
    expect(value).toBeCloseTo(0.7, 1)
    await expect
      .poll(() =>
        page
          .locator('#musicAudio')
          .evaluate((audio) =>
            audio.duration ? audio.currentTime / audio.duration : 0,
          ),
      )
      .toBeCloseTo(value, 2)
  })
})
