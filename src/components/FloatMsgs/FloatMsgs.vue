<template>
    <div v-for="item in msgs" :key="item.id" :ref="`msg-${item.id}`" :class="[item.type, item.persist ? 'persist' : '', item.closing ? 'closing' : '']">
        <i v-if="item.type == 'info'">💡</i>
        <i v-if="item.type == 'success'">✅</i>
        <i v-if="item.type == 'warn'">⚠️</i>
        <i v-if="item.type == 'error'">❌</i>
        <span v-html="item.msg"></span>
        <i v-if="item.persist" class="closeBtn" @click="close(item.id)"></i>
    </div>
</template>

<script lang="ts">
import { logErr } from '../..'

interface MsgPublic {
    type: 'info' | 'success' | 'warn' | 'error'
    msg: string
    persist?: boolean
    timeout?: number
}

interface MsgPrivate extends MsgPublic {
    id: number
    closing?: boolean
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
            if (typeof msg == 'string') {
                msg = {
                    type: 'info',
                    msg: msg
                }
            }
            const msgAdd = { ...msg, id: this.count++ } as MsgPrivate
            this.msgs.push(msgAdd)
            if (!msgAdd.persist) {
                setTimeout(() => {
                    this.close(msgAdd.id)
                }, msgAdd.timeout || 4000);
            }
        },

        close(id: number) {
            const msgToClose = this.msgs.find(x => x.id == id)
            if (!msgToClose) return

            msgToClose.closing = true

            try {
                const el = (this.$refs[`msg-${id}`] as HTMLDivElement[])[0]
                const elHeight = el.getBoundingClientRect().height
                setTimeout(() => {
                    el.style.marginBottom = `-${elHeight}px`
                }, 200);
            } catch (error) {
                logErr(error, 'Failed to access FloatMsgs $refs')
            }

            setTimeout(() => {
                this.msgs = this.msgs.filter(x => x != msgToClose)
            }, 500);
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

#floatMsgs>div {
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
}

#floatMsgs>div.success {
    background-color: rgba(200, 255, 200, 0.75);
}

#floatMsgs>div.warn {
    background-color: rgba(255, 255, 200, 0.75);
}

#floatMsgs>div.error {
    background-color: rgba(255, 200, 200, 0.75);
}

#floatMsgs>div.persist {
    pointer-events: all;
}

#floatMsgs>div.closing {
    animation: floatMsgClose 0.2s forwards;
    transition: margin-bottom 0.3s cubic-bezier(0.15, 0.7, 0.2, 0.9);
    pointer-events: none;
}

.lowend #floatMsgs>div.closing {
    display: none;
}

#floatMsgs>div>i {
    user-select: none;
    font-style: normal;
    flex-shrink: 0;
}

#floatMsgs>div>span {
    min-width: 0;
}

#floatMsgs .closeBtn {
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

#floatMsgs .closeBtn::after {
    content: "\00D7";
}

#floatMsgs .closeBtn:hover {
    background-color: rgba(0, 0, 0, 0.3);
}

#floatMsgs .closeBtn:active {
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
</style>