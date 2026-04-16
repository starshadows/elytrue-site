const fpsCallbacks: Array<(fps: number) => any> = []

let lastFrameTimestamp: number | undefined = undefined

const animationFrameCallback: FrameRequestCallback = timestamp => {
    requestAnimationFrame(animationFrameCallback)
    if (lastFrameTimestamp != undefined) {
        const fps = 1000 / (timestamp - lastFrameTimestamp)
        fpsCallbacks.forEach(f => f(fps))
    }
    lastFrameTimestamp = timestamp
}

requestAnimationFrame(animationFrameCallback)

export const GallerySwipeHorizontal = 1
export const GallerySwipeVertical = 2

export interface GallerySwipeSettings {
    direction: typeof GallerySwipeHorizontal | typeof GallerySwipeVertical // TODO: vertical not implemented
    maxItemDelta: number
    getItemSize?: () => number
    getStopPosition?: (itemDelta: number) => number
}

export class GallerySwipeController {
    element: HTMLElement
    options: GallerySwipeSettings = {
        direction: GallerySwipeHorizontal,
        maxItemDelta: Infinity,
    }

    private _touchStartX: number | undefined = undefined
    private _touchStartY: number | undefined = undefined
    private _touchStartTime: number | undefined = undefined

    private _lastTouchX: number | undefined = undefined
    private _lastTouchY: number | undefined = undefined
    private _lastTouchTime: number | undefined = undefined

    private _last2TouchX: number | undefined = undefined
    private _last2TouchY: number | undefined = undefined
    private _last2TouchTime: number | undefined = undefined

    private _currentTouchSwipeDirectionCorrect = false

    stopPosition: number | undefined = undefined

    constructor(element: HTMLElement, options?: Partial<GallerySwipeSettings>) {
        this.element = element
        if (options) {
            Object.assign(this.options, options)
        }

        fpsCallbacks.push(this._animateScroll)

        this.enable()
    }

    enable() {
        this.element.addEventListener('touchstart', this._touchStartHandler, { passive: false })
        this.element.addEventListener('touchmove', this._touchMoveHandler, { passive: false })
        this.element.addEventListener('touchend', this._touchEndHandler)
        this.element.addEventListener('touchcancel', this._touchEndHandler)
    }

    disable() {
        this.element.removeEventListener('touchstart', this._touchStartHandler)
        this.element.removeEventListener('touchmove', this._touchMoveHandler)
        this.element.removeEventListener('touchend', this._touchEndHandler)
        this.element.removeEventListener('touchcancel', this._touchEndHandler)
    }

    private _touchStartHandler = (e: TouchEvent) => {
        // console.log('touch start')

        const touch = e.touches[0]
        this._touchStartX = touch.clientX
        this._touchStartY = touch.clientY
        this._touchStartTime = e.timeStamp

        this._lastTouchX = undefined
        this._lastTouchY = undefined
        this._lastTouchTime = undefined

        this._last2TouchX = undefined
        this._last2TouchY = undefined
        this._last2TouchTime = undefined

        this._currentTouchSwipeDirectionCorrect = false
    }

    private _touchMoveHandler = (e: TouchEvent) => {
        this.stopOngoingScroll()

        // console.log('cancelable:', e.cancelable)

        let touchPrevented = false
        if (this.elementScrollable) {
            if (e.cancelable) {
                e.preventDefault()
                touchPrevented = true
            } else {
                console.warn('Failed to prevent touch move')
            }
        }

        const touch = e.touches[0]
        // console.log(touch.clientX, touch.clientY)

        const { deltaX, deltaY } = (() => {
            if (this._lastTouchX == undefined || this._lastTouchY == undefined) {
                return { deltaX: undefined, deltaY: undefined }
            }
            return {
                deltaX: touch.clientX - this._lastTouchX,
                deltaY: touch.clientY - this._lastTouchY
            }
        })()

        // console.log(deltaX, deltaY)

        if ((deltaX == undefined && deltaY == undefined) && // first touch
            (this._touchStartX != undefined && this._touchStartY != undefined)
        ) {
            const XYdiff = Math.abs(touch.clientX - this._touchStartX) - Math.abs(touch.clientY - this._touchStartY)
            if ((XYdiff > 0 && this.isDirectionHorizontal) ||
                (XYdiff < 0 && !this.isDirectionHorizontal)
            ) {
                this._currentTouchSwipeDirectionCorrect = true
            }
        }

        if (touchPrevented) {
            if (this._currentTouchSwipeDirectionCorrect) {
                if (deltaX != undefined) {
                    this.currentPosition -= deltaX // scroll the root element
                }
            } else if (deltaY != undefined) {
                let target = e.target

                while (target != this.element) {
                    if (!(target instanceof HTMLElement)) continue
                    // console.log(target)

                    if (target.scrollHeight <= target.clientHeight + 1) {
                        target = target.parentElement // try the parent of child not scrollable
                        continue
                    }

                    target.scrollTop -= deltaY // scroll the child element
                    break
                }
            }
        }

        this._last2TouchX = this._lastTouchX
        this._last2TouchY = this._lastTouchY
        this._last2TouchTime = this._lastTouchTime

        this._lastTouchX = touch.clientX
        this._lastTouchY = touch.clientY
        this._lastTouchTime = e.timeStamp
    }

    private _touchEndHandler = () => {
        // console.log('touch end')

        if (this._currentTouchSwipeDirectionCorrect && this.options.getStopPosition) {
            let totalTouchDelta: number | undefined = undefined
            let totalTouchTime: number | undefined = undefined
            let lastTouchDelta: number | undefined = undefined
            let lastTouchTime: number | undefined = undefined

            if (this.isDirectionHorizontal) {
                if (this._touchStartX != undefined && this._lastTouchX != undefined) {
                    totalTouchDelta = this._lastTouchX - this._touchStartX
                }
                if (this._lastTouchX != undefined && this._last2TouchX != undefined) {
                    lastTouchDelta = this._lastTouchX - this._last2TouchX
                }
            } else {
                if (this._touchStartY != undefined && this._lastTouchY != undefined) {
                    totalTouchDelta = this._touchStartY - this._lastTouchY
                }
                if (this._lastTouchY != undefined && this._last2TouchY != undefined) {
                    lastTouchDelta = this._lastTouchY - this._last2TouchY
                }
            }

            if (this._touchStartTime != undefined && this._lastTouchTime != undefined) {
                totalTouchTime = this._lastTouchTime - this._touchStartTime
            }
            if (this._lastTouchTime != undefined && this._last2TouchTime != undefined) {
                lastTouchTime = this._lastTouchTime - this._last2TouchTime
            }

            if (totalTouchDelta && totalTouchTime && lastTouchDelta && lastTouchTime) {
                const totalTouchSpeed = totalTouchDelta / totalTouchTime
                const lastTouchSpeed = lastTouchDelta / lastTouchTime
                // console.log(totalTouchSpeed, lastTouchSpeed)

                let touchSpeed
                if (this.options.getItemSize && (Math.abs(totalTouchDelta) / this.options.getItemSize() < 0.33)) {
                    touchSpeed = totalTouchSpeed
                } else if (totalTouchSpeed / lastTouchSpeed > 2) {
                    touchSpeed = lastTouchSpeed
                } else if (totalTouchSpeed / lastTouchSpeed < 0.5) {
                    touchSpeed = totalTouchSpeed
                } else {
                    touchSpeed = (totalTouchSpeed + lastTouchSpeed) / 2
                }

                let itemDelta = -touchSpeed * 750
                if (this.options.getItemSize) {
                    itemDelta /= this.options.getItemSize()
                } else {
                    itemDelta /= (this.isDirectionHorizontal ? window.innerWidth : window.innerHeight)
                }
                // console.log(itemDelta)

                if (itemDelta > this.options.maxItemDelta) itemDelta = this.options.maxItemDelta
                itemDelta = Math.round(itemDelta)

                this.stopPosition = this.options.getStopPosition(itemDelta)

                if (this.stopPosition < 0) {
                    this.stopPosition = 0
                } else if (this.stopPosition > this.maxScrollPosition) {
                    this.stopPosition = this.maxScrollPosition
                }
            }
        }

        this._lastTouchX = undefined
        this._lastTouchY = undefined
        this._currentTouchSwipeDirectionCorrect = false
    }

    private _animateScroll = (fps: number) => {
        if (this.stopPosition == undefined) return

        const remaining = this.stopPosition - this.currentPosition

        let scrollDelta = remaining / (5 * fps / 60)
        if (Math.abs(scrollDelta) < 1) {
            scrollDelta = scrollDelta > 0 ? 1 : -1
        }

        this.currentPosition += scrollDelta

        const newRemaining = this.stopPosition - this.currentPosition
        if (newRemaining == remaining || Math.abs(newRemaining) < 1) {
            this.stopPosition = undefined
        }
    }

    stopOngoingScroll() {
        this.stopPosition = undefined
    }

    get isDirectionHorizontal(): boolean {
        return this.options.direction == GallerySwipeHorizontal
    }

    get currentPosition(): number {
        if (this.isDirectionHorizontal) {
            return this.element.scrollLeft
        } else {
            return this.element.scrollTop
        }
    }

    set currentPosition(value) {
        if (this.isDirectionHorizontal) {
            this.element.scrollLeft = value
        } else {
            this.element.scrollTop = value
        }
    }

    get elementScrollable(): boolean {
        return this.maxScrollPosition > 0
    }

    get maxScrollPosition(): number {
        if (this.isDirectionHorizontal) {
            return this.element.scrollWidth - this.element.clientWidth
        } else {
            return this.element.scrollHeight - this.element.clientHeight
        }
    }
}
