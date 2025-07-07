<template>
    <div v-for="item in msgs" :key="item.id" :ref="`msg-${item.id}`" :class="{ 'float-msg': true, [item.type]: true, 'persist': item.persist, 'closing': item.closing }" @touchstart="item.touchstartHandler" @touchmove.prevent="item.touchmoveHandler" @touchend="item.touchendHandler">
        <i v-if="item.type == 'info'">💡</i>
        <i v-if="item.type == 'success'">✅</i>
        <i v-if="item.type == 'warn'">⚠️</i>
        <i v-if="item.type == 'error'">❌</i>
        <span v-html="item.msg"></span>
        <i v-if="item.persist" class="closeBtn" @click="item.close()"></i>
    </div>
</template>

<script lang="ts">
interface MsgPublic {
    type: 'info' | 'success' | 'warn' | 'error'
    msg: string
    persist?: boolean
    timeout?: number
}

interface MsgPrivate extends MsgPublic {
    id: number
    readonly el: HTMLDivElement
    close: () => void
    closing?: boolean
    touchstartHandler: (e: TouchEvent) => void
    touchmoveHandler: (e: TouchEvent) => void
    touchendHandler: (e: TouchEvent) => void
}

export default {
    data() {
        return {
            count: 0,
            msgs: [] as MsgPrivate[],
        }
    },

    methods: {
        show(msg: MsgPublic | string) {
            const id = this.count++

            let el: HTMLDivElement | undefined
            const getEl = () => {
                if (el) return el
                else {
                    el = (this.$refs[`msg-${id}`] as HTMLDivElement[])[0]
                    return el
                }
            }

            let startX: number
            let startTime: number
            let swipeX: number

            this.msgs.push({
                ...(typeof msg == 'string' ? { type: 'info', msg: msg } : msg),
                id,

                get el() {
                    return getEl()
                },

                close: () => {
                    self.closing = true

                    const elHeight = self.el.getBoundingClientRect().height
                    setTimeout(() => {
                        self.el.style.marginBottom = `-${elHeight}px`
                    }, 200);

                    setTimeout(() => {
                        this.msgs = this.msgs.filter(x => x.id != id)
                    }, 500);
                },

                touchstartHandler: e => {
                    startX = e.touches[0].clientX
                    startTime = e.timeStamp
                    swipeX = 0
                },
                touchmoveHandler: e => {
                    swipeX = e.touches[0].clientX - startX
                    self.el.style.transform = `translate(${swipeX}px)`
                    self.el.style.opacity = (1 - Math.abs(swipeX) / self.el.clientWidth).toString()
                },
                touchendHandler: e => {
                    const swipeSpeed = Math.abs(swipeX) / (e.timeStamp - startTime)
                    // console.log(swipeSpeed)
                    if (Math.abs(swipeX) > self.el.clientWidth / 2 || swipeSpeed > 0.5) {
                        this.$nextTick(() => {
                            self.el.style.transform = `translate(${swipeX < 0 ? '-' : ''}100%)`
                            self.el.style.opacity = '0'
                            self.el.style.animation = 'none'
                        })
                        self.close()
                    } else {
                        self.el.style.removeProperty('transform')
                        self.el.style.removeProperty('opacity')
                        if (swipeX) {
                            self.el.style.transition = 'transform 0.2s, opacity 0.2s'
                            setTimeout(() => {
                                self.el.style.removeProperty('transition')
                            }, 200);
                        }
                    }
                },
            })

            const self = this.msgs.find(x => x.id == id)!

            if (!self.persist) {
                setTimeout(() => {
                    self.close()
                }, self.timeout || 4000);
            }
        },

        close(id: number) {
            this.msgs.find(x => x.id == id)?.close()
        },
    }
}
</script>

<style>
#floatMsgs {
    top: 15%;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    flex-flow: column;
    pointer-events: none;
}
</style>

<style scoped lang="scss">
.float-msg {
    margin: 0 0 0.75rem;
    padding: 0.5rem 0.75rem;
    background-color: rgba(255, 255, 255, 0.7);
    backdrop-filter: blur(0.5rem);
    border-radius: 0.5rem;
    box-sizing: border-box;
    max-width: 80vw;
    display: flex;
    flex-flow: row;
    gap: 0.5rem;
    align-items: center;
    box-shadow: 0 0.125rem 0.5rem 0 rgba(0, 0, 0, 0.5);
    animation: floatMsgFlyin 0.3s;

    &.success {
        background-color: rgba(200, 255, 200, 0.75);
    }

    &.warn {
        background-color: rgba(255, 255, 200, 0.75);
    }

    &.error {
        background-color: rgba(255, 200, 200, 0.75);
    }

    &.persist {
        pointer-events: all;
    }

    &.closing {
        animation: floatMsgClose 0.2s forwards;
        transition: margin-bottom 0.3s cubic-bezier(0.15, 0.7, 0.2, 0.9), transform 0.2s, opacity 0.2s;
        pointer-events: none;
    }

    .lowend &.closing {
        display: none;
    }

    &>i {
        user-select: none;
        font-style: normal;
        flex-shrink: 0;
    }

    &>span {
        min-width: 0;
    }

    & .closeBtn {
        display: block;
        width: 0.825em;
        height: 0.825em;
        line-height: 0.625em;
        font-size: 1.6rem;
        font-family: Arial;
        box-sizing: border-box;
        padding: 0.125em;
        border: none;
        background-color: rgba(0, 0, 0, 0.1);
        border-radius: 100%;
    }

    & .closeBtn::after {
        content: "\00D7";
    }

    & .closeBtn:hover {
        background-color: rgba(0, 0, 0, 0.3);
    }

    & .closeBtn:active {
        background-color: rgba(0, 0, 0, 0.5);
    }

    @keyframes floatMsgFlyin {
        from {
            opacity: 0;
            transform: translateY(-50%);
        }

        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    @keyframes floatMsgClose {
        from {
            opacity: 1;
            transform: scale(1);
        }

        to {
            opacity: 0;
            transform: scale(0.9);
        }
    }
}
</style>