import { getStore } from '@edgeone/pages-blob'

export const FAST_HANDLER_BUDGET_MS = 300
export const FAST_READ_BUDGET_MS = 285
export const FAST_HEDGE_DELAY_MS = 140
export const FAST_PREVIOUS_GRACE_MS = 20

const CURRENT_KEY = 'views/comments/latest.json'
const PREVIOUS_KEY = 'views/comments/latest-previous.json'
const SUCCESS_CACHE =
  'public, max-age=0, s-maxage=10, stale-while-revalidate=30'

function isCard(value) {
  return Boolean(
    value &&
    Number.isSafeInteger(value.id) &&
    Number.isSafeInteger(value.number) &&
    value.number > 0 &&
    (typeof value.uid === 'string' || value.uid === null) &&
    typeof value.sender === 'string' &&
    typeof value.avatar === 'string' &&
    typeof value.comment === 'string' &&
    typeof value.image === 'string' &&
    Number.isFinite(value.time) &&
    Number.isFinite(value.likes),
  )
}

export function isFastCommentSnapshot(value) {
  return Boolean(
    value &&
    value.version === 1 &&
    Array.isArray(value.items) &&
    value.items.length <= 12 &&
    value.items.every(isCard) &&
    Number.isFinite(value.generatedAt) &&
    Number.isSafeInteger(value.todayCount) &&
    value.todayCount >= 0 &&
    (value.snapshotRevision === undefined ||
      (Number.isSafeInteger(value.snapshotRevision) &&
        value.snapshotRevision > 0)),
  )
}

function preferred(left, right) {
  if (!left?.snapshot) return right
  if (!right?.snapshot) return left
  const leftRevision = left.snapshot.snapshotRevision
  const rightRevision = right.snapshot.snapshotRevision
  if (
    Number.isSafeInteger(leftRevision) &&
    Number.isSafeInteger(rightRevision)
  ) {
    if (leftRevision !== rightRevision) {
      return leftRevision > rightRevision ? left : right
    }
  } else if (Number.isSafeInteger(leftRevision)) return left
  else if (Number.isSafeInteger(rightRevision)) return right
  return left.source === 'current' ? left : right
}

function delay(milliseconds) {
  return new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, milliseconds)),
  )
}

async function settleBefore(promise, deadline, now, sleep) {
  const remaining = deadline - now()
  if (remaining <= 0) return { timeout: true }
  return Promise.race([
    promise.then((value) => ({ timeout: false, value })),
    sleep(remaining).then(() => ({ timeout: true })),
  ])
}

function timingHeader(outcomes, startedAt, now, phases = {}) {
  const values = []
  for (const source of ['current', 'previous']) {
    const outcome = outcomes[source]
    if (outcome) values.push(`${source};dur=${outcome.duration}`)
  }
  for (const [name, duration] of Object.entries(phases)) {
    values.push(`${name};dur=${Math.max(0, duration)}`)
  }
  values.push(`total;dur=${Math.max(0, now() - startedAt)}`)
  return values.join(', ')
}

function jsonResponse(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })
}

function errorResponse(status, message, timing) {
  return jsonResponse(
    { code: status, message, data: null },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'Server-Timing': timing,
      },
    },
  )
}

function pageFromSnapshot(snapshot, count) {
  const items = snapshot.items.slice(0, count)
  const hasMore = snapshot.items.length > count || Boolean(snapshot.hasMore)
  return {
    items,
    hasMore,
    ...(hasMore && items.length > 0 ? { nextCursor: items.at(-1).id } : {}),
    todayCount: snapshot.todayCount,
    snapshotGeneratedAt: snapshot.generatedAt,
    ...(Number.isSafeInteger(snapshot.snapshotRevision)
      ? { snapshotRevision: snapshot.snapshotRevision }
      : {}),
  }
}

export function createPublicFastHandler({
  storeFactory = () => getStore('elytrue-data'),
  now = () => Date.now(),
  sleep = delay,
  hedgeDelayMs = FAST_HEDGE_DELAY_MS,
  graceMs = FAST_PREVIOUS_GRACE_MS,
  readBudgetMs = FAST_READ_BUDGET_MS,
  handlerBudgetMs = FAST_HANDLER_BUDGET_MS,
} = {}) {
  return async function publicFast(context) {
    const startedAt = now()
    const request = context.request
    const url = new URL(request.url)
    const outcomes = {}
    if (request.method !== 'GET') {
      return errorResponse(
        405,
        '请求方法不允许',
        timingHeader(outcomes, startedAt, now),
      )
    }
    if ([...url.searchParams.keys()].some((key) => key !== 'count')) {
      return errorResponse(
        400,
        '公共首屏留言参数无效',
        timingHeader(outcomes, startedAt, now),
      )
    }
    const count = Number(url.searchParams.get('count') || 10)
    if (!Number.isSafeInteger(count) || count < 1 || count > 12) {
      return errorResponse(
        400,
        '留言数量无效',
        timingHeader(outcomes, startedAt, now),
      )
    }

    const store = storeFactory()
    const handlerDeadline = startedAt + handlerBudgetMs
    const readDeadline = Math.min(
      startedAt + readBudgetMs,
      handlerDeadline - 15,
    )
    const read = (source, key) => {
      const readStarted = now()
      return store
        .get(key, { type: 'json', consistency: 'eventual' })
        .then(
          (snapshot) => ({
            source,
            status: isFastCommentSnapshot(snapshot) ? 'valid' : 'invalid',
            ...(isFastCommentSnapshot(snapshot) ? { snapshot } : {}),
            duration: Math.max(0, now() - readStarted),
          }),
          () => ({
            source,
            status: 'invalid',
            duration: Math.max(0, now() - readStarted),
          }),
        )
        .then((outcome) => {
          outcomes[source] = outcome
          return outcome
        })
    }

    const currentPromise = read('current', CURRENT_KEY)
    const hedgeResult = await settleBefore(
      currentPromise,
      Math.min(startedAt + hedgeDelayMs, readDeadline),
      now,
      sleep,
    )
    let selected
    if (!hedgeResult.timeout) {
      if (hedgeResult.value.status === 'valid') selected = hedgeResult.value
      else {
        const previousResult = await settleBefore(
          read('previous', PREVIOUS_KEY),
          readDeadline,
          now,
          sleep,
        )
        if (
          !previousResult.timeout &&
          previousResult.value.status === 'valid'
        ) {
          selected = previousResult.value
        } else {
          const timing = timingHeader(outcomes, startedAt, now)
          return errorResponse(
            previousResult.timeout ? 504 : 503,
            previousResult.timeout ? '公共留言读取超时' : '公共留言暂时不可用',
            timing,
          )
        }
      }
    } else {
      const previousPromise = read('previous', PREVIOUS_KEY)
      const first = await settleBefore(
        Promise.race([currentPromise, previousPromise]),
        readDeadline,
        now,
        sleep,
      )
      if (first.timeout) {
        return errorResponse(
          504,
          '公共留言读取超时',
          timingHeader(outcomes, startedAt, now),
        )
      }
      if (first.value.source === 'current') {
        if (first.value.status === 'valid') {
          await Promise.resolve()
          selected = preferred(first.value, outcomes.previous)
        } else {
          const previousResult = await settleBefore(
            previousPromise,
            readDeadline,
            now,
            sleep,
          )
          if (
            !previousResult.timeout &&
            previousResult.value.status === 'valid'
          ) {
            selected = previousResult.value
          } else {
            return errorResponse(
              previousResult.timeout ? 504 : 503,
              previousResult.timeout
                ? '公共留言读取超时'
                : '公共留言暂时不可用',
              timingHeader(outcomes, startedAt, now),
            )
          }
        }
      } else if (first.value.status !== 'valid') {
        const currentResult = await settleBefore(
          currentPromise,
          readDeadline,
          now,
          sleep,
        )
        if (!currentResult.timeout && currentResult.value.status === 'valid') {
          selected = currentResult.value
        } else {
          return errorResponse(
            currentResult.timeout ? 504 : 503,
            currentResult.timeout ? '公共留言读取超时' : '公共留言暂时不可用',
            timingHeader(outcomes, startedAt, now),
          )
        }
      } else if (outcomes.current?.status === 'invalid') {
        selected = first.value
      } else {
        const currentResult = await settleBefore(
          currentPromise,
          Math.min(now() + graceMs, readDeadline),
          now,
          sleep,
        )
        selected =
          !currentResult.timeout && currentResult.value.status === 'valid'
            ? preferred(currentResult.value, first.value)
            : first.value
      }
    }

    const selectionCompletedAt = now()
    if (selectionCompletedAt >= handlerDeadline) {
      return errorResponse(
        504,
        '公共留言读取超时',
        timingHeader(outcomes, startedAt, now),
      )
    }
    const serializationStartedAt = now()
    const response = jsonResponse(
      {
        code: 1,
        message: 'OK',
        data: pageFromSnapshot(selected.snapshot, count),
      },
      {
        headers: {
          'Cache-Control': SUCCESS_CACHE,
          'X-Elytrue-Snapshot-Source': selected.source,
        },
      },
    )
    const completedAt = now()
    const timing = timingHeader(outcomes, startedAt, now, {
      selection: selectionCompletedAt - startedAt,
      serialization: completedAt - serializationStartedAt,
    })
    if (completedAt > handlerDeadline) {
      return errorResponse(504, '公共留言读取超时', timing)
    }
    response.headers.set('Server-Timing', timing)
    return response
  }
}

export const onRequest = createPublicFastHandler()
