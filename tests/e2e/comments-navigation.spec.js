import { expect, test } from '@playwright/test'

function commentPayload(id, comment = `导航留言 ${id}`) {
  return {
    id,
    number: id,
    displayId: id,
    uid: `navigation-${id}`,
    sender: `导航用户 ${id}`,
    avatar: '',
    comment,
    image: '',
    replyid: null,
    time: 1_775_000_000 - id,
    hidden: false,
    liked: false,
    likes: 0,
  }
}

async function fulfillComments(route, items, options = {}) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      code: 1,
      message: 'OK',
      data: {
        items,
        hasMore: options.hasMore ?? false,
        nextCursor: options.nextCursor ?? items.at(-1)?.id ?? null,
        todayCount: items.length,
      },
    }),
  })
}

async function prepareComments(page, options = {}) {
  const items =
    options.items ??
    Array.from({ length: 12 }, (_, index) => commentPayload(120 - index))
  await page.addInitScript((showTimeline) => {
    Math.random = () => 0
    localStorage.setItem('mutebgm', 'true')
    localStorage.setItem('showTimeline', String(showTimeline))
    sessionStorage.clear()
  }, options.showTimeline ?? false)
  await page.route('**/api/comments/public*', (route) =>
    fulfillComments(route, items, {
      hasMore: options.hasMore,
      nextCursor: options.nextCursor,
    }),
  )
  if (options.listHandler) {
    await page.route('**/api/comments?*', options.listHandler)
  }
  await page.goto('/')
  await expect(page.locator('#comments > .commentItem')).toHaveCount(
    items.length,
  )
  await page.waitForFunction(
    () =>
      !document.getElementById('lowerPanel')?.classList.contains('animating'),
  )
  if (options.lift !== false) await page.mouse.move(640, 690)
  return items
}

async function backgroundCreditAnchorState(page) {
  return page.evaluate(() => {
    const credit = document.querySelector('.backgroundCredit.visible')
    if (!(credit instanceof HTMLElement))
      throw new Error('Visible background credit is missing')
    const box = credit.getBoundingClientRect()
    const rootFontSize = Number.parseFloat(
      getComputedStyle(document.documentElement).fontSize,
    )
    return {
      actualBottom: window.innerHeight - box.bottom,
      expectedBottom: window.innerHeight * 0.2 + rootFontSize * 4.25,
      customTop: document.documentElement.style.getPropertyValue(
        '--background-credit-top',
      ),
      computedBottom: getComputedStyle(credit).bottom,
      transform: getComputedStyle(credit).transform,
    }
  })
}

async function expectFixedBackgroundCreditAnchor(page) {
  const state = await backgroundCreditAnchorState(page)
  expect(
    Math.abs(state.actualBottom - state.expectedBottom),
  ).toBeLessThanOrEqual(2)
  expect(state.customTop).toBe('')
  expect(state.transform).toBe('none')
  return state
}

async function waitForTwoAnimationFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  )
}

async function dispatchTouchSwipe(
  page,
  start,
  end,
  steps = 5,
  stepDelay = 18,
  endType = 'touchEnd',
  durationMs,
) {
  const session = await page.context().newCDPSession(page)
  const startedAt = durationMs === undefined ? undefined : Date.now() / 1000
  const timestampAt = (elapsedMs) =>
    startedAt === undefined ? {} : { timestamp: startedAt + elapsedMs / 1000 }
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
    ...timestampAt(0),
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
      ...timestampAt(durationMs === undefined ? 0 : durationMs * ratio),
    })
    await page.waitForTimeout(stepDelay)
  }
  await session.send('Input.dispatchTouchEvent', {
    type: endType,
    touchPoints: [],
    ...timestampAt(durationMs === undefined ? 0 : durationMs + 1),
  })
  await session.detach()
}

async function snapState(page) {
  return page.locator('#comments').evaluate((element) => {
    const containerRect = element.getBoundingClientRect()
    const paddingLeft =
      Number.parseFloat(getComputedStyle(element).paddingLeft) || 0
    const contentLeft = containerRect.left + element.clientLeft + paddingLeft
    const maximum = Math.max(0, element.scrollWidth - element.clientWidth)
    const points = Array.from(element.children)
      .filter(
        (child) =>
          child instanceof HTMLElement &&
          child.classList.contains('commentBox') &&
          getComputedStyle(child).display !== 'none',
      )
      .map((child) => ({
        id: child.id || child.dataset.number || '',
        left: Math.min(
          maximum,
          Math.max(
            0,
            element.scrollLeft +
              child.getBoundingClientRect().left -
              contentLeft,
          ),
        ),
      }))
      .sort((left, right) => left.left - right.left)
      .filter(
        (point, index, all) =>
          index === all.length - 1 ||
          Math.abs(point.left - all[index + 1].left) > 0.5,
      )
    const nearest = points.reduce(
      (current, point, index) =>
        Math.abs(point.left - element.scrollLeft) < current.distance
          ? {
              index,
              distance: Math.abs(point.left - element.scrollLeft),
              id: point.id,
            }
          : current,
      { index: -1, distance: Number.POSITIVE_INFINITY, id: '' },
    )
    return {
      scrollLeft: element.scrollLeft,
      maximum,
      points,
      nearest,
    }
  })
}

async function resetNavigation(page, left = 0) {
  await page.locator('#comments').evaluate((element, offset) => {
    element.scrollLeft = offset
    element.dispatchEvent(new Event('scroll'))
  }, left)
  await page.waitForTimeout(50)
}

async function recordNavigation(page, trigger) {
  return page.locator('#comments').evaluate(async (element, action) => {
    const trace = [element.scrollLeft]
    const startedAt = performance.now()
    const dispatchWheel = (deltaY) =>
      element.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY,
        }),
      )

    if (action === 'arrow') {
      document.querySelector('[aria-label="下一页留言"]')?.click()
    } else if (action === 'wheel-back') {
      dispatchWheel(-3)
    } else {
      const count = action === 'wheel-three' ? 3 : 1
      for (let index = 0; index < count; index += 1) dispatchWheel(3)
    }

    await new Promise((resolve) => {
      const sample = () => {
        trace.push(element.scrollLeft)
        if (element.dataset.seekAnimating === 'true')
          requestAnimationFrame(sample)
        else resolve()
      }
      requestAnimationFrame(sample)
    })
    return {
      duration: performance.now() - startedAt,
      final: element.scrollLeft,
      trace,
    }
  }, trigger)
}

function expectMonotonic(trace, direction) {
  for (let index = 1; index < trace.length; index += 1) {
    if (direction > 0)
      expect(trace[index]).toBeGreaterThanOrEqual(trace[index - 1] - 0.1)
    else expect(trace[index]).toBeLessThanOrEqual(trace[index - 1] + 0.1)
  }
}

test('arrows and ordinary wheel share exact-card animation and accumulate targets', async ({
  page,
}) => {
  await prepareComments(page)
  await expect(page.getByRole('button', { name: '下一页留言' })).toBeVisible()
  const initial = await snapState(page)

  const arrow = await recordNavigation(page, 'arrow')
  expect(arrow.final).toBeCloseTo(initial.points[1].left, 0)
  expectMonotonic(arrow.trace, 1)

  await resetNavigation(page)
  const wheel = await recordNavigation(page, 'wheel')
  expect(wheel.final).toBeCloseTo(initial.points[1].left, 0)
  expectMonotonic(wheel.trace, 1)
  // Background decoding and host scheduling can delay a few animation frames;
  // the exact-card and monotonic assertions above remain the behavior contract.
  expect(Math.abs(wheel.duration - arrow.duration)).toBeLessThanOrEqual(200)

  await resetNavigation(page)
  const accumulated = await recordNavigation(page, 'wheel-three')
  expect(accumulated.final).toBeCloseTo(initial.points[3].left, 0)
  expectMonotonic(accumulated.trace, 1)

  const backwards = await recordNavigation(page, 'wheel-back')
  expect(backwards.final).toBeCloseTo(initial.points[2].left, 0)
  expectMonotonic(backwards.trace, -1)
})

test('scale, resize, pinned removal, and editor insertion keep real geometry aligned', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1050, height: 720 })
  await prepareComments(page)
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '20px'
  })
  await page.waitForTimeout(100)
  await resetNavigation(page)

  await page.locator('#comments').evaluate((element) => {
    element.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: 3,
      }),
    )
    document.querySelector('#topComment button')?.click()
  })
  await expect(page.locator('#topComment')).toHaveCount(0)
  await expect
    .poll(async () => (await snapState(page)).nearest.distance)
    .toBeLessThanOrEqual(1)

  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('elytrue:open-comment-editor')),
  )
  await expect(page.locator('#newCommentBox')).toBeVisible()
  await resetNavigation(page)
  const withEditor = await snapState(page)
  const navigating = recordNavigation(page, 'wheel')
  await page.setViewportSize({ width: 920, height: 700 })
  await navigating
  const afterResize = await snapState(page)
  expect(afterResize.nearest.distance).toBeLessThanOrEqual(1)
  expect(afterResize.nearest.id).toBe(withEditor.points[1].id)
})

test('inputs, scrollable body, trackpad deltas, and fullscreen keep native behavior', async ({
  page,
}) => {
  const longText = '可纵向滚动的长正文。'.repeat(180)
  await prepareComments(page, {
    items: [commentPayload(10, longText), commentPayload(9), commentPayload(8)],
  })
  const comments = page.locator('#comments')
  const initial = await snapState(page)
  await resetNavigation(page, initial.points[1].left)
  const body = page.locator('.commentItem').first().locator('.comment')
  await body.evaluate((element) => {
    element.style.height = '3rem'
    element.style.overflowY = 'auto'
    const spacer = document.createElement('div')
    spacer.style.height = '30rem'
    spacer.style.width = '1px'
    element.append(spacer)
  })
  await expect
    .poll(() =>
      body.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true)
  const bodyWheel = await body.evaluate((element) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 3,
    })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(bodyWheel).toBe(false)
  expect((await snapState(page)).scrollLeft).toBeCloseTo(
    initial.points[1].left,
    0,
  )

  await page.evaluate(() =>
    document.dispatchEvent(new CustomEvent('elytrue:open-comment-editor')),
  )
  const editorPrevented = await page.locator('#msgText').evaluate((element) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(editorPrevented).toBe(false)

  const nativeDeltas = await comments.evaluate((element) => {
    const small = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: 5,
    })
    element.dispatchEvent(small)
    element.scrollLeft = Math.max(
      1,
      (element.scrollWidth - element.clientWidth) / 2,
    )
    const horizontal = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 20,
    })
    element.dispatchEvent(horizontal)
    element.scrollLeft = element.scrollWidth
    const boundary = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 20,
    })
    element.dispatchEvent(boundary)
    return {
      small: small.defaultPrevented,
      horizontal: horizontal.defaultPrevented,
      boundary: boundary.defaultPrevented,
    }
  })
  expect(nativeDeltas).toEqual({
    small: false,
    horizontal: false,
    boundary: true,
  })

  await comments.evaluate((element) => {
    element.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: -3,
      }),
    )
    document.body.classList.add('fullscreen')
  })
  await expect(comments).not.toHaveAttribute('data-seek-animating', 'true')
  const fullscreenPrevented = await comments.evaluate((element) => {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 120,
    })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(fullscreenPrevented).toBe(false)
})

test.describe('mobile touch gestures', () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  })

  test('mobile touch controller owns one panel decision while native targets keep their gestures', async ({
    page,
  }) => {
    const longText = '移动端可滚动正文。'.repeat(240)
    await prepareComments(page, {
      items: [commentPayload(10, longText), commentPayload(9)],
      lift: false,
    })
    const panel = page.locator('#lowerPanel')
    await expect
      .poll(() =>
        panel.evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeGreaterThan(500)
    await panel.evaluate((element) => {
      window.__panelModeTrace = []
      new MutationObserver(() => {
        window.__panelModeTrace.push(element.classList.contains('lowerPanelUp'))
      }).observe(element, { attributes: true, attributeFilter: ['class'] })
    })

    const collapsedTop = await panel.evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    const start = { x: 195, y: Math.min(825, collapsedTop + 24) }
    await dispatchTouchSwipe(page, start, { x: start.x + 80, y: start.y - 8 })
    await expect(panel).not.toHaveClass(/lowerPanelUp/u)
    await dispatchTouchSwipe(page, start, { x: start.x, y: start.y - 15 })
    await expect(panel).not.toHaveClass(/lowerPanelUp/u)

    await dispatchTouchSwipe(page, start, { x: start.x, y: start.y - 110 })
    await expect(panel).toHaveClass(/lowerPanelUp/u)
    await expect
      .poll(() =>
        panel.evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeLessThan(450)
    const traceAfterExpand = await panel.evaluate(() => window.__panelModeTrace)
    expect(traceAfterExpand.filter(Boolean)).toHaveLength(1)

    const body = page.locator('#topComment .comment')
    await body.evaluate((element) => {
      element.style.height = '4rem'
      element.style.overflowY = 'auto'
      const spacer = document.createElement('div')
      spacer.style.height = '30rem'
      spacer.style.width = '1px'
      element.append(spacer)
      element.scrollTop = Math.min(
        120,
        element.scrollHeight - element.clientHeight,
      )
    })
    const bodyBox = await body.boundingBox()
    if (!bodyBox) throw new Error('Scrollable comment body is missing')
    expect(
      await page.evaluate(
        ({ x, y }) => {
          const target = document.elementFromPoint(x, y)
          return Boolean(target?.closest('#topComment .comment'))
        },
        { x: bodyBox.x + bodyBox.width / 2, y: bodyBox.y + 30 },
      ),
    ).toBe(true)
    await panel.evaluate((element) => {
      window.__nativeBodyMoves = []
      element.addEventListener(
        'touchmove',
        (event) => window.__nativeBodyMoves.push(event.defaultPrevented),
        { passive: true },
      )
    })
    await dispatchTouchSwipe(
      page,
      { x: bodyBox.x + bodyBox.width / 2, y: bodyBox.y + 30 },
      { x: bodyBox.x + bodyBox.width / 2, y: bodyBox.y + 100 },
    )
    await expect(panel).toHaveClass(/lowerPanelUp/u)
    const nativeBodyMoves = await panel.evaluate(() => window.__nativeBodyMoves)
    expect(nativeBodyMoves.length).toBeGreaterThan(0)
    expect(nativeBodyMoves.every((prevented) => !prevented)).toBe(true)

    await body.evaluate((element) => {
      element.scrollTop = 0
    })
    await dispatchTouchSwipe(
      page,
      { x: bodyBox.x + bodyBox.width / 2, y: bodyBox.y + 30 },
      { x: bodyBox.x + bodyBox.width / 2, y: bodyBox.y + 190 },
    )
    await expect(panel).not.toHaveClass(/lowerPanelUp/u)

    const collapsedAfterBodySwipe = await panel.evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    await dispatchTouchSwipe(
      page,
      { x: 195, y: Math.min(825, collapsedAfterBodySwipe + 24) },
      { x: 195, y: Math.min(825, collapsedAfterBodySwipe + 24) - 110 },
    )
    await expect(panel).toHaveClass(/lowerPanelUp/u)
    const expandedTop = await panel.evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    await dispatchTouchSwipe(
      page,
      { x: 195, y: expandedTop - 40 },
      { x: 195, y: expandedTop + 35 },
      5,
      80,
    )
    await expect(panel).not.toHaveClass(/lowerPanelUp/u)
    await expect
      .poll(() =>
        panel.evaluate((element) => element.getBoundingClientRect().top),
      )
      .toBeGreaterThan(500)

    const collapsedAgain = await panel.evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    await dispatchTouchSwipe(
      page,
      { x: 195, y: Math.min(825, collapsedAgain + 24) },
      { x: 195, y: Math.min(825, collapsedAgain + 24) - 110 },
    )
    await page.evaluate(() =>
      document.dispatchEvent(new CustomEvent('elytrue:open-comment-editor')),
    )
    await expect(page.locator('#msgText')).toBeVisible()
    const editorBox = await page.locator('#msgText').boundingBox()
    if (!editorBox) throw new Error('Comment editor is missing')
    await dispatchTouchSwipe(
      page,
      { x: editorBox.x + 30, y: editorBox.y + 30 },
      { x: editorBox.x + 30, y: editorBox.y + 100 },
    )
    await expect(panel).toHaveClass(/lowerPanelUp/u)
  })

  test('the collapsed activation zone accepts vertical swipes but protects native surfaces', async ({
    page,
  }) => {
    await prepareComments(page, { lift: false })
    const panel = page.locator('#lowerPanel')

    const collapsedTop = async () =>
      panel.evaluate((element) => element.getBoundingClientRect().top)
    const swipeAbovePanel = async (offset, deltaX = 0, deltaY = -110) => {
      const top = await collapsedTop()
      const start = { x: 24, y: top - offset }
      await dispatchTouchSwipe(page, start, {
        x: start.x + deltaX,
        y: start.y + deltaY,
      })
    }
    const collapse = async () => {
      const top = await collapsedTop()
      await dispatchTouchSwipe(
        page,
        { x: 8, y: top + 12 },
        { x: 8, y: top + 210 },
      )
      await expect(panel).not.toHaveClass(/lowerPanelUp/u)
    }

    await swipeAbovePanel(40, 90, -8)
    await expect(panel).not.toHaveClass(/lowerPanelUp/u)
    await swipeAbovePanel(40, 0, -15)
    await expect(panel).not.toHaveClass(/lowerPanelUp/u)
    await swipeAbovePanel(130)
    await expect(panel).not.toHaveClass(/lowerPanelUp/u)

    await swipeAbovePanel(40)
    await expect(panel).toHaveClass(/lowerPanelUp/u)
    await collapse()
    await swipeAbovePanel(100)
    await expect(panel).toHaveClass(/lowerPanelUp/u)
    await collapse()

    await page.evaluate(() => document.body.classList.add('fullscreen'))
    await swipeAbovePanel(40)
    await expect(panel).not.toHaveClass(/lowerPanelUp/u)
    await page.evaluate(() => document.body.classList.remove('fullscreen'))

    await page.locator('.mainTitleUnder').click()
    await expect(page.locator('#themeSelectorPopup')).toBeVisible()
    await swipeAbovePanel(40)
    await expect(panel).not.toHaveClass(/lowerPanelUp/u)
    await page.locator('#themeSelectorPopup .closeBtn').click()
    await expect(page.locator('#themeSelectorPopup')).toBeHidden()

    for (const surface of ['video', 'image', 'input']) {
      await page.evaluate(
        ({ kind, top }) => {
          const element =
            kind === 'input'
              ? document.createElement('input')
              : document.createElement('div')
          element.dataset.gestureProtectionTest = kind
          if (kind === 'video') element.id = 'videoPlayerLayer'
          if (kind === 'image') element.className = 'img-viewer-overlay'
          Object.assign(element.style, {
            position: 'fixed',
            zIndex: '99999',
            left: '0',
            right: '0',
            top: `${top - 120}px`,
            height: '120px',
            display: 'block',
          })
          document.body.append(element)
        },
        { kind: surface, top: await collapsedTop() },
      )
      await swipeAbovePanel(40)
      await expect(panel).not.toHaveClass(/lowerPanelUp/u)
      await page.evaluate(() =>
        document.querySelector('[data-gesture-protection-test]')?.remove(),
      )
    }
  })

  test('a slow short card drag returns to its exact starting snap point', async ({
    page,
  }) => {
    await prepareComments(page, { lift: false })
    const panel = page.locator('#lowerPanel')
    const collapsedTop = await panel.evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    await dispatchTouchSwipe(
      page,
      { x: 195, y: Math.min(825, collapsedTop + 24) },
      { x: 195, y: Math.min(825, collapsedTop + 24) - 110 },
    )
    await expect(panel).toHaveClass(/lowerPanelUp/u)

    const initial = await snapState(page)
    const startingIndex = 1
    await resetNavigation(page, initial.points[startingIndex].left)
    const box = await page.locator('.commentItem').first().boundingBox()
    if (!box) throw new Error('Comment card is missing')
    const start = { x: box.x + box.width / 2, y: box.y + 100 }
    await expect(page.locator('.commentItem').first()).toHaveCSS(
      'touch-action',
      'pan-y',
    )
    await dispatchTouchSwipe(
      page,
      start,
      { x: start.x - 56, y: start.y + 2 },
      6,
      100,
    )

    await expect(page.locator('#comments')).not.toHaveAttribute(
      'data-seek-animating',
      'true',
    )
    await expect
      .poll(async () => (await snapState(page)).nearest.distance)
      .toBeLessThanOrEqual(1)
    const settled = await snapState(page)
    expect(settled.nearest.index).toBe(startingIndex)
    expect(settled.scrollLeft).toBeCloseTo(
      initial.points[startingIndex].left,
      0,
    )
  })

  test('an ordinary horizontal swipe settles on the next real card', async ({
    page,
  }) => {
    await prepareComments(page, { lift: false })
    const panel = page.locator('#lowerPanel')
    const collapsedTop = await panel.evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    await dispatchTouchSwipe(
      page,
      { x: 195, y: Math.min(825, collapsedTop + 24) },
      { x: 195, y: Math.min(825, collapsedTop + 24) - 110 },
    )
    await expect(panel).toHaveClass(/lowerPanelUp/u)

    const initial = await snapState(page)
    const startingIndex = 1
    await resetNavigation(page, initial.points[startingIndex].left)
    const box = await page.locator('.commentItem').first().boundingBox()
    if (!box) throw new Error('Comment card is missing')
    const start = { x: box.x + box.width / 2, y: box.y + 100 }
    await dispatchTouchSwipe(
      page,
      start,
      { x: start.x - 170, y: start.y + 3 },
      6,
      60,
    )

    await expect
      .poll(async () => (await snapState(page)).nearest.distance)
      .toBeLessThanOrEqual(1)
    const settled = await snapState(page)
    expect(settled.nearest.index).toBe(startingIndex + 1)
    expect(settled.scrollLeft).toBeCloseTo(
      initial.points[startingIndex + 1].left,
      0,
    )
  })

  test('velocity projection sends a fast flick farther than the same slow drag', async ({
    page,
  }) => {
    await prepareComments(page, { lift: false })
    const panel = page.locator('#lowerPanel')
    const collapsedTop = await panel.evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    await dispatchTouchSwipe(
      page,
      { x: 195, y: Math.min(825, collapsedTop + 24) },
      { x: 195, y: Math.min(825, collapsedTop + 24) - 110 },
    )
    await expect(panel).toHaveClass(/lowerPanelUp/u)

    const initial = await snapState(page)
    const startingIndex = 1
    const swipe = async (steps, durationMs) => {
      await resetNavigation(page, initial.points[startingIndex].left)
      const box = await page.locator('.commentItem').first().boundingBox()
      if (!box) throw new Error('Comment card is missing')
      const start = { x: box.x + box.width / 2, y: box.y + 100 }
      await dispatchTouchSwipe(
        page,
        start,
        { x: start.x - 120, y: start.y + 2 },
        steps,
        durationMs / steps,
        'touchEnd',
        durationMs,
      )
      await expect
        .poll(async () => (await snapState(page)).nearest.distance)
        .toBeLessThanOrEqual(1)
      return (await snapState(page)).nearest.index
    }

    const slowTarget = await swipe(6, 900)
    const fastTarget = await swipe(2, 24)
    expect(slowTarget).toBe(startingIndex)
    expect(fastTarget).toBeGreaterThan(slowTarget)
    expect(fastTarget - startingIndex).toBeGreaterThan(1)
  })

  test('touch cancel snaps to the nearest card and fullscreen keeps horizontal touch native', async ({
    page,
  }) => {
    await prepareComments(page, { lift: false })
    const panel = page.locator('#lowerPanel')
    const collapsedTop = await panel.evaluate(
      (element) => element.getBoundingClientRect().top,
    )
    await dispatchTouchSwipe(
      page,
      { x: 195, y: Math.min(825, collapsedTop + 24) },
      { x: 195, y: Math.min(825, collapsedTop + 24) - 110 },
    )
    await expect(panel).toHaveClass(/lowerPanelUp/u)

    const initial = await snapState(page)
    await resetNavigation(page, initial.points[1].left)
    const box = await page.locator('.commentItem').first().boundingBox()
    if (!box) throw new Error('Comment card is missing')
    const start = { x: box.x + box.width / 2, y: box.y + 100 }
    await dispatchTouchSwipe(
      page,
      start,
      { x: start.x - 190, y: start.y },
      5,
      18,
      'touchCancel',
    )
    await expect
      .poll(async () => (await snapState(page)).nearest.distance)
      .toBeLessThanOrEqual(1)
    await expect(page.locator('#comments')).not.toHaveAttribute(
      'data-seek-animating',
      'true',
    )
    expect(
      await page.locator('#comments').evaluate((element) => ({
        transform: element.style.transform,
        transition: element.style.transition,
      })),
    ).toEqual({ transform: '', transition: '' })

    await page.evaluate(() => document.body.classList.add('fullscreen'))
    const beforeFullscreenSwipe = await page
      .locator('#comments')
      .evaluate((element) => element.scrollLeft)
    const fullscreenBox = await page
      .locator('.commentItem')
      .first()
      .boundingBox()
    if (!fullscreenBox) throw new Error('Fullscreen comment card is missing')
    await dispatchTouchSwipe(
      page,
      {
        x: fullscreenBox.x + fullscreenBox.width / 2,
        y: fullscreenBox.y + 100,
      },
      {
        x: fullscreenBox.x + fullscreenBox.width / 2 - 150,
        y: fullscreenBox.y + 102,
      },
    )
    await expect(page.locator('#comments')).not.toHaveAttribute(
      'data-seek-animating',
      'true',
    )
    expect(
      await page.locator('#comments').evaluate((element) => element.scrollLeft),
    ).toBe(beforeFullscreenSwipe)
  })
})

for (const viewport of [
  { width: 1680, height: 896 },
  { width: 390, height: 844 },
  { width: 430, height: 932 },
]) {
  test(`background credit keeps its viewport bottom anchor at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport)
    await page.addInitScript(() => {
      window.__backgroundCreditTopWrites = 0
      const nativeSetProperty = CSSStyleDeclaration.prototype.setProperty
      CSSStyleDeclaration.prototype.setProperty = function (
        property,
        value,
        priority,
      ) {
        if (property === '--background-credit-top')
          window.__backgroundCreditTopWrites += 1
        return nativeSetProperty.call(this, property, value, priority)
      }
    })
    await prepareComments(page, { lift: false })
    const panel = page.locator('#lowerPanel')
    const todayText = page.locator('.todayCommentText')
    await expect(panel).not.toHaveClass(/lowerPanelUp/u)
    await expect(todayText).toBeVisible()
    await expect(page.locator('.backgroundCredit.visible')).toBeVisible()

    const initial = await expectFixedBackgroundCreditAnchor(page)

    await page.evaluate(() => {
      const languageStyles = document.getElementById('langCSS')
      if (!languageStyles) throw new Error('Language stylesheet is missing')
      languageStyles.textContent =
        '.ui { display: none !important; } .ui.en { display: inline !important; }'
    })
    await expect(todayText.locator('.ui.en')).toBeVisible()
    await waitForTwoAnimationFrames(page)
    const afterLanguage = await expectFixedBackgroundCreditAnchor(page)
    expect(afterLanguage.actualBottom).toBeCloseTo(initial.actualBottom, 1)

    await page.locator('#todayCommentCount').evaluate((element) => {
      element.textContent = '123456789'
    })
    await page.evaluate(() =>
      document.fonts.dispatchEvent(new Event('loadingdone')),
    )
    await waitForTwoAnimationFrames(page)
    const afterCountAndFonts = await expectFixedBackgroundCreditAnchor(page)
    expect(afterCountAndFonts.actualBottom).toBeCloseTo(initial.actualBottom, 1)

    await page.mouse.move(Math.min(viewport.width - 1, 100), 100)
    await page.mouse.wheel(0, 500)
    await expect(panel).toHaveClass(/lowerPanelUp/u)
    const expanded = await expectFixedBackgroundCreditAnchor(page)
    expect(expanded.actualBottom).toBeCloseTo(initial.actualBottom, 1)

    await page.mouse.wheel(0, -500)
    await expect(panel).toHaveClass(/lowerPanelDown/u)
    await page.waitForTimeout(550)
    const collapsed = await expectFixedBackgroundCreditAnchor(page)
    expect(collapsed.actualBottom).toBeCloseTo(initial.actualBottom, 1)

    const resizedViewport =
      viewport.width <= 430
        ? { width: viewport.height, height: viewport.width }
        : { width: viewport.width, height: viewport.height + 64 }
    await page.setViewportSize(resizedViewport)
    await page.evaluate(() =>
      window.dispatchEvent(new Event('orientationchange')),
    )
    await waitForTwoAnimationFrames(page)
    const resized = await expectFixedBackgroundCreditAnchor(page)
    expect(resized.actualBottom).not.toBeCloseTo(initial.actualBottom, 0)
    expect(await page.evaluate(() => window.__backgroundCreditTopWrites)).toBe(
      0,
    )
  })
}

test('newer and older pagination preserve the current element before continued snapping', async ({
  page,
}) => {
  let releaseNewer
  let markNewerRequested
  const newerGate = new Promise((resolve) => {
    releaseNewer = resolve
  })
  const newerRequested = new Promise((resolve) => {
    markNewerRequested = resolve
  })
  const middle = Array.from({ length: 7 }, (_, index) =>
    commentPayload(60 - index),
  )
  const newer = Array.from({ length: 6 }, (_, index) =>
    commentPayload(70 - index),
  )
  const older = Array.from({ length: 6 }, (_, index) =>
    commentPayload(52 - index),
  )
  const initial = Array.from({ length: 8 }, (_, index) =>
    commentPayload(100 - index),
  )

  await prepareComments(page, {
    items: initial,
    showTimeline: true,
    listHandler: async (route) => {
      const query = new URL(route.request().url()).searchParams
      if (query.has('time'))
        return fulfillComments(route, middle, { hasMore: true })
      if (query.get('direction') === 'after') {
        markNewerRequested()
        await newerGate
        return fulfillComments(route, newer, { hasMore: false })
      }
      return fulfillComments(route, older, { hasMore: false })
    },
  })
  await page.locator('#timeline span').dispatchEvent('click')
  await expect(page.locator('#comments > .commentItem')).toHaveCount(
    middle.length,
  )
  const middleState = await snapState(page)
  await resetNavigation(page, middleState.points[2].left)
  await resetNavigation(page, 0)
  await newerRequested
  const beforeNewer = await snapState(page)
  releaseNewer()
  await expect(page.locator('#comments > .commentItem')).toHaveCount(
    middle.length + newer.length,
  )
  const afterNewer = await snapState(page)
  expect(afterNewer.nearest.id).toBe(beforeNewer.nearest.id)
  expect(afterNewer.nearest.distance).toBeLessThanOrEqual(1)

  await resetNavigation(page, afterNewer.maximum)
  const beforeOlder = await snapState(page)
  await expect(page.locator('#comments > .commentItem')).toHaveCount(
    middle.length + newer.length + older.length,
  )
  const afterOlder = await snapState(page)
  expect(afterOlder.nearest.id).toBe(beforeOlder.nearest.id)

  const continued = await recordNavigation(page, 'wheel')
  const final = await snapState(page)
  expect(final.nearest.distance).toBeLessThanOrEqual(1)
  expect(continued.final).toBeCloseTo(final.scrollLeft, 0)
  await expect(page.getByRole('button', { name: '上一页留言' })).toBeVisible()
})
