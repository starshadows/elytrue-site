<template>
  <div
    v-show="viewerState.showing"
    :class="{ 'img-viewer-overlay': true, closing: viewerState.pendingClose }"
    ref="overlay"
    @mousedown.prevent="mouseDownHandler"
    @mouseup="mouseUpHandler"
    @mousemove.prevent="mouseMoveHandler"
    @mouseleave="mouseLeaveHandler"
    @wheel="mouseWheelHandler"
    @touchstart="touchStartHandler"
    @touchmove.prevent="touchMoveHandler"
    @touchend="touchEndHandler"
  >
    <div class="img-viewer-wrapper" ref="wrapper">
      <img
        ref="viewer"
        :src="viewerState.source"
        draggable="false"
        style="transform: translateX(0px) translateY(0px) scale(1)"
      />
    </div>
  </div>
</template>

<script lang="ts">
import { logFrontendError } from '../../app/app-events'
import ImgViewer from './index'
import { setOneTimeStyles } from '../../lib/dom'
import {
  calcNewOffset,
  createPinchZoomController,
  createPointFromTouch,
  type Point,
} from './zoom'

export default {
  mounted() {
    try {
      this.elements.overlay = this.$refs.overlay as HTMLDivElement
      this.elements.wrapper = this.$refs.wrapper as HTMLDivElement
      this.elements.viewer = this.$refs.viewer as HTMLImageElement
    } catch (error) {
      logFrontendError(error, 'Failed to init image viewer')
    }
  },
  data() {
    return {
      elements: {
        overlay: {} as HTMLDivElement,
        wrapper: {} as HTMLDivElement,
        viewer: {} as HTMLImageElement,
      },

      imgViewerOffsetX: 0,
      imgViewerOffsetY: 0,
      imgViewerScale: 1,
      imgViewerMouseMoved: false,

      lastTouchPoint: null as Point | null,
      pinchZoomController: null as ReturnType<
        typeof createPinchZoomController
      > | null,

      viewerState: ImgViewer.state,
    }
  },
  methods: {
    view(src: string) {
      ImgViewer.view(src)

      this.imgViewerOffsetX = 0
      this.imgViewerOffsetY = 0
      this.imgViewerScale = 1
      this.elements.viewer.style.transform =
        'translateX(0px) translateY(0px) scale(1)'
      this.elements.viewer.style.removeProperty('image-rendering')
    },

    close() {
      ImgViewer.close()
      setOneTimeStyles(this.elements.overlay, { animation: 'none' })
      setOneTimeStyles(this.elements.wrapper, { animation: 'none' })
    },

    isOpen() {
      return ImgViewer.isOpen()
    },

    normalizePosition() {
      const displayWidth = this.elements.viewer.width * this.imgViewerScale
      const displayHeight = this.elements.viewer.height * this.imgViewerScale

      if (displayWidth && displayHeight) {
        // make sure non-zero
        const top =
          (window.innerHeight - displayHeight) / 2 + this.imgViewerOffsetY
        const bottom =
          (window.innerHeight - displayHeight) / 2 - this.imgViewerOffsetY
        const left =
          (window.innerWidth - displayWidth) / 2 + this.imgViewerOffsetX
        const right =
          (window.innerWidth - displayWidth) / 2 - this.imgViewerOffsetX
        // console.log(top, left, bottom, right)

        if (displayHeight <= window.innerHeight) this.imgViewerOffsetY = 0
        else {
          if (top > 0)
            this.imgViewerOffsetY = 0 - (window.innerHeight - displayHeight) / 2
          else if (bottom > 0)
            this.imgViewerOffsetY = (window.innerHeight - displayHeight) / 2
        }

        if (displayWidth <= window.innerWidth) this.imgViewerOffsetX = 0
        else {
          if (left > 0)
            this.imgViewerOffsetX = 0 - (window.innerWidth - displayWidth) / 2
          else if (right > 0)
            this.imgViewerOffsetX = (window.innerWidth - displayWidth) / 2
        }
      }

      if (this.imgViewerScale < 1) {
        this.imgViewerScale = 1
      }

      this.applyPosition()
    },

    applyPosition(x?: number, y?: number, scale?: number) {
      scale ??= this.imgViewerScale
      this.elements.viewer.style.transform = `translateX(${x ?? this.imgViewerOffsetX}px) translateY(${y ?? this.imgViewerOffsetY}px) scale(${scale})`
      this.updatePixelInterpolation(scale)
    },

    disableTransition() {
      this.elements.viewer.style.transition = 'none'
    },

    enableTransition() {
      this.elements.viewer.style.removeProperty('transition')
    },

    updatePixelInterpolation(scale?: number) {
      const pixelRatio = (() => {
        try {
          const actualWidth =
            this.elements.viewer.width * (scale ?? this.imgViewerScale) //* window.devicePixelRatio
          const naturalWidth = this.elements.viewer.naturalWidth
          // check for zeros
          return actualWidth && naturalWidth ? actualWidth / naturalWidth : 1
        } catch (error) {
          logFrontendError(undefined, 'Failed to get image display pixel ratio')
          return 1
        }
      })()

      if (pixelRatio > 2) {
        this.elements.viewer.style.imageRendering = 'pixelated'
      } else {
        this.elements.viewer.style.removeProperty('image-rendering')
      }
    },

    // mouse handlers
    //
    mouseDownHandler(e: MouseEvent) {
      if (e.button == 0) {
        this.imgViewerMouseMoved = false
        this.disableTransition()
      }
    },

    mouseUpHandler(e: MouseEvent) {
      if (e.button == 0) {
        if (!this.imgViewerMouseMoved) {
          this.close()
        }
        this.enableTransition()
        this.normalizePosition()
      }
    },

    mouseMoveHandler(e: MouseEvent) {
      if (e.buttons == 1) {
        this.disableTransition()

        this.imgViewerOffsetX += e.movementX
        this.imgViewerOffsetY += e.movementY
        if (e.movementX != 0 || e.movementY != 0) {
          this.imgViewerMouseMoved = true
        }
        //console.log(this.imgViewerOffsetX, this.imgViewerOffsetY)
        this.applyPosition()
      }
    },

    mouseLeaveHandler() {
      this.enableTransition()
      this.normalizePosition()
    },

    mouseWheelHandler(e: WheelEvent) {
      e.preventDefault()

      const scaleMultiplier: number = (() => {
        if (e.deltaMode == WheelEvent.DOM_DELTA_PIXEL) {
          // trackpad zoom
          if (e.ctrlKey && Math.abs(e.deltaY) < 30) {
            return (100 - e.deltaY) / 100
          }
          // mouse wheel + pixels
          if (e.deltaY < 0) {
            return (1000 - e.deltaY) / 1000
          } else {
            return 1000 / (1000 + e.deltaY)
          }
        }
        // mouse wheel + lines / pages
        return e.deltaY < 0 ? 11 / 10 : 10 / 11
      })()
      this.imgViewerScale *= scaleMultiplier

      var mouseOffsetX = e.clientX - window.innerWidth / 2
      var mouseOffsetY = e.clientY - window.innerHeight / 2
      // console.log(mouseOffsetX, mouseOffsetY)

      this.imgViewerOffsetX +=
        (scaleMultiplier - 1) * (this.imgViewerOffsetX - mouseOffsetX)
      this.imgViewerOffsetY +=
        (scaleMultiplier - 1) * (this.imgViewerOffsetY - mouseOffsetY)

      this.normalizePosition()

      // console.log('mode:', e.deltaMode, 'X:', e.deltaX, 'Y:', e.deltaY, 'ctrl:', e.ctrlKey, 'scale:', scaleMultiplier)
    },

    // touch handlers
    //
    touchStartHandler(e: TouchEvent) {
      this.disableTransition()
      if (e.touches.length == 1) {
        const touch = e.touches.item(0)
        if (touch) this.lastTouchPoint = createPointFromTouch(touch)
      } else if (e.touches.length == 2) {
        const first = e.touches.item(0)
        const second = e.touches.item(1)
        if (first && second) {
          this.pinchZoomController = createPinchZoomController(first, second)
        }
      }
    },

    touchMoveHandler(e: TouchEvent) {
      this.disableTransition()
      if (e.touches.length == 1) {
        if (!this.lastTouchPoint) return
        const touch = e.touches.item(0)
        if (!touch) return
        const newPoint = createPointFromTouch(touch)

        const vector = newPoint.subtract(this.lastTouchPoint)
        this.imgViewerOffsetX += vector.x
        this.imgViewerOffsetY += vector.y
        this.applyPosition()

        this.lastTouchPoint = newPoint
      } else if (e.touches.length == 2) {
        if (!this.pinchZoomController) return
        const first = e.touches.item(0)
        const second = e.touches.item(1)
        if (!first || !second) return
        this.pinchZoomController.calcZoom(first, second)

        let { x, y } = calcNewOffset(
          this.imgViewerOffsetX,
          this.imgViewerOffsetY,
          this.pinchZoomController.scale,
          this.pinchZoomController.startMidPoint,
        )
        x += this.pinchZoomController.x
        y += this.pinchZoomController.y

        const scale = this.imgViewerScale * this.pinchZoomController.scale

        this.applyPosition(x, y, scale)
      }
      // 3+ fingers not supported yet
    },

    touchEndHandler(e: TouchEvent) {
      if (e.touches.length == 0) {
        this.enableTransition()
        this.normalizePosition()
      } else if (e.touches.length == 1 || e.touches.length == 2) {
        const first = e.touches.item(0)
        if (!first) return
        this.lastTouchPoint = createPointFromTouch(first)

        if (!this.pinchZoomController) return

        let { x, y } = calcNewOffset(
          this.imgViewerOffsetX,
          this.imgViewerOffsetY,
          this.pinchZoomController.scale,
          this.pinchZoomController.startMidPoint,
        )
        x += this.pinchZoomController.x
        y += this.pinchZoomController.y

        this.imgViewerOffsetX = x
        this.imgViewerOffsetY = y
        this.imgViewerScale *= this.pinchZoomController.scale

        this.applyPosition()

        // ensure smooth transition from 3+ fingers to 2-finger
        if (e.touches.length == 2) {
          const second = e.touches.item(1)
          if (second) {
            this.pinchZoomController = createPinchZoomController(first, second)
          }
        }
      }
    },
  },
}
</script>

<style scoped lang="scss">
.img-viewer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  cursor: grab;
  user-select: none;
  animation: fadein 0.3s;

  .img-viewer-wrapper {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: showImgView 0.3s;

    img {
      /* width: 100%;
            height: 100%; */
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      /*pointer-events: none;*/
      transition: transform 0.2s;
    }
  }

  &.closing {
    pointer-events: none;

    &,
    .img-viewer-wrapper {
      animation-duration: 0.15s;
      animation-direction: reverse;
      animation-fill-mode: forwards;
      animation-timing-function: cubic-bezier(0.2, 0, 1, 1);
    }

    .lowend & {
      display: none !important;
    }
  }

  @keyframes showImgView {
    from {
      transform: scale(0.9);
      opacity: 0;
    }

    to {
      transform: scale(1);
      opacity: 1;
    }
  }
}
</style>
