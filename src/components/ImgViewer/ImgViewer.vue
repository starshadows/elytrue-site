<template>
    <div v-show="showing" :class="{ 'img-viewer-overlay': true, 'closing': pendingClose }" ref="overlay" @mousedown="mouseDownHandler" @mouseup="mouseUpHandler" @mousemove="mouseMoveHandler" @mouseleave="mouseLeaveHandler" @wheel="mouseWheelHandler">
        <div class="img-viewer-wrapper" ref="wrapper">
            <img ref="viewer" draggable="false" style="transform: translateX(0px) translateY(0px) scale(1)">
        </div>
    </div>
</template>

<script lang="ts">
import { setOneTimeCSS } from '../..'
import { logErr } from '../..'

export default {
    mounted() {
        try {
            this.elements.overlay = this.$refs.overlay as HTMLDivElement
            this.elements.wrapper = this.$refs.wrapper as HTMLDivElement
            this.elements.viewer = this.$refs.viewer as HTMLImageElement
            this.viewportContent = this.elements.viewport.content
        } catch (error) {
            logErr(error, 'Failed to init image viewer')
        }
    },
    data() {
        return {
            elements: {
                overlay: {} as HTMLDivElement,
                wrapper: {} as HTMLDivElement,
                viewer: {} as HTMLImageElement,
                viewport: document.querySelector('meta[name=viewport]') as HTMLMetaElement,
            },

            viewportContent: '',
            imgViewerOffsetX: 0,
            imgViewerOffsetY: 0,
            imgViewerScale: 1,
            imgViewerMouseMoved: false,

            showing: false,
            pendingClose: false,
        }
    },
    methods: {
        view(src: string) {
            this.elements.viewer.src = src
            this.showing = true
            this.pendingClose = false
            this.elements.viewport.setAttribute('content', this.viewportContent.replace(', maximum-scale=1.0', ''))
            window.location.hash = 'view-img'

            this.imgViewerOffsetX = 0
            this.imgViewerOffsetY = 0
            this.imgViewerScale = 1
            this.elements.viewer.style.transform = 'translateX(0px) translateY(0px) scale(1)'
            this.elements.viewer.style.removeProperty('image-rendering')
        },

        close() {
            if (location.hash == '#view-img') {
                history.back()
                return
            }

            this.pendingClose = true
            setOneTimeCSS(this.elements.overlay, { animation: 'none' })
            setOneTimeCSS(this.elements.wrapper, { animation: 'none' })
            setTimeout(() => {
                if (this.pendingClose) {
                    this.showing = false
                }
            }, 200);
            this.elements.viewport.setAttribute('content', this.viewportContent);
        },

        isOpen() {
            return this.showing == true && this.pendingClose == false
        },

        normalizePosition() {
            const displayWidth = this.elements.viewer.width * this.imgViewerScale
            const displayHeight = this.elements.viewer.height * this.imgViewerScale

            if (displayWidth && displayHeight) { // make sure non-zero
                const top = (window.innerHeight - displayHeight) / 2 + this.imgViewerOffsetY
                const bottom = (window.innerHeight - displayHeight) / 2 - this.imgViewerOffsetY
                const left = (window.innerWidth - displayWidth) / 2 + this.imgViewerOffsetX
                const right = (window.innerWidth - displayWidth) / 2 - this.imgViewerOffsetX
                // console.log(top, left, bottom, right)

                if (displayHeight <= window.innerHeight) this.imgViewerOffsetY = 0
                else {
                    if (top > 0) this.imgViewerOffsetY = 0 - (window.innerHeight - displayHeight) / 2
                    else if (bottom > 0) this.imgViewerOffsetY = (window.innerHeight - displayHeight) / 2
                }

                if (displayWidth <= window.innerWidth) this.imgViewerOffsetX = 0
                else {
                    if (left > 0) this.imgViewerOffsetX = 0 - (window.innerWidth - displayWidth) / 2
                    else if (right > 0) this.imgViewerOffsetX = (window.innerWidth - displayWidth) / 2
                }
            }

            this.applyPosition()
        },

        applyPosition() {
            this.elements.viewer.style.transform = `translateX(${this.imgViewerOffsetX}px) translateY(${this.imgViewerOffsetY}px) scale(${this.imgViewerScale})`
        },

        getPixelRatio() {
            try {
                const actualWidth = this.elements.viewer.width * this.imgViewerScale //* window.devicePixelRatio
                const naturalWidth = this.elements.viewer.naturalWidth
                // check for zeros
                return (actualWidth && naturalWidth) ? (actualWidth / naturalWidth) : 1
            } catch (error) {
                console.log('Failed to get image display pixel ratio')
                return 1
            }
        },

        mouseDownHandler(e: MouseEvent) {
            if (e.button == 0) {
                this.imgViewerMouseMoved = false
                this.elements.viewer.style.transition = 'none'
            }
        },

        mouseUpHandler(e: MouseEvent) {
            if (e.button == 0) {
                if (!this.imgViewerMouseMoved) {
                    this.close()
                }
                this.elements.viewer.style.removeProperty('transition')
                this.normalizePosition()
            }
        },

        mouseMoveHandler(e: MouseEvent) {
            if (e.buttons == 1) {
                this.elements.viewer.style.transition = 'none'

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
            this.elements.viewer.style.removeProperty('transition')
            this.normalizePosition()
        },

        mouseWheelHandler(e: WheelEvent) {
            e.preventDefault()
            let scaleMultiplier = 1
            if (e.deltaY < 0) {
                scaleMultiplier = (1000 - e.deltaY) / 1000
                //this.imgViewerScale *= 11 / 10
            } else {
                scaleMultiplier = 1000 / (1000 + e.deltaY)
                //this.imgViewerScale *= 10 / 11
            }
            this.imgViewerScale *= scaleMultiplier

            var mouseOffsetX = e.clientX - (window.innerWidth / 2)
            var mouseOffsetY = e.clientY - (window.innerHeight / 2)
            // console.log(mouseOffsetX, mouseOffsetY)

            this.imgViewerOffsetX += (scaleMultiplier - 1) * (this.imgViewerOffsetX - mouseOffsetX)
            this.imgViewerOffsetY += (scaleMultiplier - 1) * (this.imgViewerOffsetY - mouseOffsetY)

            if (this.imgViewerScale < 1) {
                this.imgViewerScale = 1
            }
            // console.log(this.imgViewerScale)

            this.normalizePosition()

            if (this.getPixelRatio() > 2) {
                this.elements.viewer.style.imageRendering = 'pixelated'
            } else {
                this.elements.viewer.style.removeProperty('image-rendering')
            }
        }
    }
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