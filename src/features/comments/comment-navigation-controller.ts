const ANIMATION_TIME_CONSTANT_MS = 75
const SNAP_EPSILON_PX = 0.5

interface CommentSnapPoint {
  readonly element: HTMLElement
  readonly left: number
}

export interface CommentNavigationController {
  readonly isAnimating: boolean
  cancel(snapToNearest?: boolean): void
  destroy(): void
  dragToOffset(offset: number): void
  reconcileLayout(): void
  seekByItems(delta: -1 | 1): void
  settleToProjectedOffset(offset: number): void
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

class CommentNavigationControllerImpl implements CommentNavigationController {
  private readonly container: HTMLElement
  private readonly browserWindow: Window
  private animationFrame: number | undefined
  private animationActive = false
  private previousFrameTime: number | undefined
  private targetElement: HTMLElement | undefined
  private targetLeft = 0
  private destroyed = false

  constructor(container: HTMLElement) {
    const browserWindow = container.ownerDocument.defaultView
    if (!browserWindow) throw new Error('Comment navigation requires a window')
    this.container = container
    this.browserWindow = browserWindow
  }

  get isAnimating(): boolean {
    return this.animationActive
  }

  seekByItems(delta: -1 | 1): void {
    if (this.destroyed) return
    const points = this.getSnapPoints()
    if (!points.length) return

    let currentIndex = -1
    if (this.isAnimating && this.targetElement) {
      currentIndex = points.findIndex(
        (point) => point.element === this.targetElement,
      )
    }
    if (currentIndex < 0) {
      currentIndex = this.nearestPointIndex(
        points,
        this.isAnimating ? this.targetLeft : this.container.scrollLeft,
      )
    }

    const targetIndex = clamp(currentIndex + delta, 0, points.length - 1)
    const target = points[targetIndex]
    if (!target) return
    this.moveToPoint(target)
  }

  dragToOffset(offset: number): void {
    if (this.destroyed) return
    this.cancel(false)
    this.container.scrollLeft = clamp(offset, 0, this.maximumScrollLeft())
  }

  settleToProjectedOffset(offset: number): void {
    if (this.destroyed) return
    const points = this.getSnapPoints()
    const target = points[this.nearestPointIndex(points, offset)]
    if (!target) return
    this.moveToPoint(target)
  }

  reconcileLayout(): void {
    if (this.destroyed || !this.isAnimating || !this.targetElement) return
    const target = this.snapPointFor(this.targetElement)
    if (!target) {
      this.cancel(true)
      return
    }
    this.targetLeft = target.left
  }

  cancel(snapToNearest = false): void {
    if (this.animationFrame !== undefined) {
      this.browserWindow.cancelAnimationFrame(this.animationFrame)
      this.animationFrame = undefined
    }
    this.animationActive = false
    this.previousFrameTime = undefined
    delete this.container.dataset.seekAnimating
    if (snapToNearest) {
      const points = this.getSnapPoints()
      const target =
        points[this.nearestPointIndex(points, this.container.scrollLeft)]
      if (target) this.container.scrollLeft = target.left
    }
    this.targetElement = undefined
  }

  destroy(): void {
    this.cancel(false)
    this.destroyed = true
  }

  private moveToPoint(target: CommentSnapPoint): void {
    this.targetElement = target.element
    this.targetLeft = target.left

    if (
      this.browserWindow.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      this.cancel(false)
      this.container.scrollLeft = target.left
      return
    }
    this.startAnimation()
  }

  private startAnimation(): void {
    if (this.animationFrame !== undefined) return
    this.animationActive = true
    this.container.dataset.seekAnimating = 'true'
    this.animationFrame = this.browserWindow.requestAnimationFrame(
      this.animateFrame,
    )
  }

  private readonly animateFrame = (timestamp: number): void => {
    this.animationFrame = undefined
    if (this.destroyed) return

    const elapsed =
      this.previousFrameTime === undefined
        ? 1000 / 60
        : clamp(timestamp - this.previousFrameTime, 1, 64)
    this.previousFrameTime = timestamp
    const distance = this.targetLeft - this.container.scrollLeft

    if (Math.abs(distance) <= SNAP_EPSILON_PX) {
      this.finishAnimation()
      return
    }

    const previous = this.container.scrollLeft
    const progress = 1 - Math.exp(-elapsed / ANIMATION_TIME_CONSTANT_MS)
    this.container.scrollLeft = previous + distance * progress
    if (this.container.scrollLeft === previous) {
      this.finishAnimation()
      return
    }
    this.animationFrame = this.browserWindow.requestAnimationFrame(
      this.animateFrame,
    )
  }

  private finishAnimation(): void {
    this.container.scrollLeft = this.targetLeft
    this.animationFrame = undefined
    this.animationActive = false
    this.previousFrameTime = undefined
    delete this.container.dataset.seekAnimating
  }

  private getSnapPoints(): CommentSnapPoint[] {
    const raw = Array.from(this.container.children)
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement &&
          element.classList.contains('commentBox') &&
          this.browserWindow.getComputedStyle(element).display !== 'none',
      )
      .map((element) => this.snapPointFor(element))
      .filter((point): point is CommentSnapPoint => Boolean(point))
      .sort((left, right) => left.left - right.left)

    const points: CommentSnapPoint[] = []
    for (const point of raw) {
      const previous = points.at(-1)
      if (previous && Math.abs(previous.left - point.left) <= SNAP_EPSILON_PX) {
        points[points.length - 1] = point
      } else {
        points.push(point)
      }
    }
    return points
  }

  private snapPointFor(element: HTMLElement): CommentSnapPoint | undefined {
    if (
      !element.isConnected ||
      element.parentElement !== this.container ||
      this.browserWindow.getComputedStyle(element).display === 'none'
    ) {
      return undefined
    }
    const containerRect = this.container.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    const style = this.browserWindow.getComputedStyle(this.container)
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
    const contentLeft =
      containerRect.left + this.container.clientLeft + paddingLeft
    const maximum = this.maximumScrollLeft()
    return {
      element,
      left: clamp(
        this.container.scrollLeft + elementRect.left - contentLeft,
        0,
        maximum,
      ),
    }
  }

  private maximumScrollLeft(): number {
    return Math.max(0, this.container.scrollWidth - this.container.clientWidth)
  }

  private nearestPointIndex(
    points: readonly CommentSnapPoint[],
    offset: number,
  ): number {
    if (!points.length) return -1
    let nearest = 0
    let nearestDistance = Number.POSITIVE_INFINITY
    points.forEach((point, index) => {
      const distance = Math.abs(point.left - offset)
      if (distance < nearestDistance) {
        nearest = index
        nearestDistance = distance
      }
    })
    return nearest
  }
}

export function createCommentNavigationController(
  container: HTMLElement,
): CommentNavigationController {
  return new CommentNavigationControllerImpl(container)
}
