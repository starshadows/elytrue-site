import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { BACKGROUNDS } from '../../src/config/assets'
import {
  commentBackground,
  resetCommentBackgroundsForTest,
} from '../../src/features/comments/comment-backgrounds'

const originalWindow = globalThis.window

afterEach(() => {
  resetCommentBackgroundsForTest()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  })
})

test('assigns visit-stable portrait backgrounds without repeating the previous five', () => {
  const portraits: string[] = BACKGROUNDS.filter(
    ({ layout }) => layout === 'portrait',
  ).map(({ preview }) => preview)
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __ELY_VISIT_ASSETS__: {
        backgroundByLayout: {},
        commentBackgrounds: portraits,
      },
    },
  })

  const selected = Array.from({ length: 30 }, (_, index) =>
    commentBackground(`comment-${index}`),
  )
  selected.forEach((source, index) => {
    assert.ok(portraits.includes(source))
    assert.equal(
      selected.slice(Math.max(0, index - 5), index).includes(source),
      false,
    )
  })
  assert.equal(commentBackground('comment-0'), selected[0])
})
