import { elementFromHtml } from '../../lib/dom'

export function addPullDownRefresh(
  el: HTMLElement,
  refreshAction: () => Promise<unknown> | unknown,
  enabled?: () => boolean,
) {
  let lastTouchY: number | null = null
  let pullRefreshHeight: number | null = null
  let removeDelayTimeout: number | null = null
  let pendingRemove = false

  function createPullRefreshEl(height: number) {
    el.prepend(
      elementFromHtml(`
            <div class="pullRefresh" style="height: ${height}px">
                <div class="loadingCircle"></div>
            </div>
        `),
    )
  }

  function getPullRefreshEl() {
    return el.querySelector('.pullRefresh') as HTMLDivElement | null
  }

  function removePullRefreshEl(delay?: number) {
    const pullRefreshEl = getPullRefreshEl()
    if (!pullRefreshEl) return

    if (removeDelayTimeout != null) clearTimeout(removeDelayTimeout)
    removeDelayTimeout = setTimeout(() => {
      pullRefreshEl.style.height = '0px'
      pullRefreshEl.style.opacity = '0'
      pullRefreshEl.style.transition = 'all 0.2s'

      if (!pendingRemove) {
        pendingRemove = true
        setTimeout(() => {
          pendingRemove = false
          pullRefreshEl.remove()
        }, 200)
      }
    }, delay)
  }

  function touchstartHandler(e: TouchEvent) {
    // console.log('touch start')
    lastTouchY = e.touches[0].clientY
    const pullRefreshEl = getPullRefreshEl()
    if (!pullRefreshEl || pendingRemove) return

    pullRefreshEl.style.opacity = '1'
    pullRefreshEl.style.transition = 'opacity 0.2s'
    pullRefreshHeight = pullRefreshEl.getBoundingClientRect().height
  }

  function touchMoveHandler(e: TouchEvent) {
    if (enabled && !enabled()) return

    const currentTouchY = e.touches[0].clientY
    /**
     * `> 0`: swipe up
     * `< 0`: swipe down
     */
    const deltaY = lastTouchY != null ? lastTouchY - currentTouchY : 0
    // console.log(deltaY)
    lastTouchY = currentTouchY

    const pullRefreshEl = getPullRefreshEl()

    if (pullRefreshHeight == null || pullRefreshEl == null) {
      if (deltaY < 0 && el.scrollTop < 1) {
        pullRefreshHeight = 0 - deltaY
        createPullRefreshEl(pullRefreshHeight)
      }
    } else if (pendingRemove) {
    } else {
      if (deltaY > 0 && pullRefreshHeight > 1) el.scrollTop = 0
      if (el.scrollTop < 1) {
        pullRefreshHeight -= deltaY
        pullRefreshEl.style.height = pullRefreshHeight * 0.5 + 'px'
      }
    }
  }

  function touchendHandler() {
    const pullRefreshEl = getPullRefreshEl()
    if (!pullRefreshEl || pendingRemove) return

    const circleHeight =
      (pullRefreshEl.querySelector('.loadingCircle') as HTMLDivElement)
        .offsetHeight * 1.75
    if (pullRefreshHeight! * 0.5 > circleHeight) {
      pullRefreshEl.style.height = circleHeight + 'px'
      pullRefreshEl.style.transition = 'all 0.2s'

      // console.log('trigger pull down refresh')
      const actionResult = refreshAction()
      if (actionResult instanceof Promise) {
        actionResult.finally(() => removePullRefreshEl(300))
      } else {
        removePullRefreshEl(500)
      }
    } else {
      removePullRefreshEl()
    }
  }

  if ('prepend' in HTMLElement.prototype) {
    el.addEventListener('touchmove', touchMoveHandler)
    el.addEventListener('touchstart', touchstartHandler)
    el.addEventListener('touchend', touchendHandler)
  } else {
    console.warn(
      'Your browser does not support `HTMLElement.prepend`, pull down refresh will not work',
    )
  }
}
