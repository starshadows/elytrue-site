<template>
    <div v-for="(item, index) in popups" :key="item.id" :class="{ popupContainer: true, closing: item.closing }">
        <div class="popupBG" @click="close(item.id)"></div>
        <div class="popupItem">
            <component :ref="`popup-${index}`" :is="item.component" v-bind="item.props" @close="close(item.id)"></component>
            <button class="closeBtn" @click="close(item.id)"></button>
        </div>
    </div>
</template>

<script lang="ts">
import type { ComponentPublicInstance } from 'vue'
import { logErr } from '../..'

interface Popup {
    id: number
    component: string
    props?: object
    closing?: boolean
}

export default {
    data() {
        return {
            popups: [] as Popup[],
            count: 0,
        }
    },

    methods: {
        show(component: string, props?: object) {
            if (component in this.$.appContext.components) {
                this.popups.push({ component, props, id: this.count++ })
            } else {
                logErr(undefined, `Cannot find a popup named "${component}"`)
            }
        },

        close(id?: number) {
            if (id != null) {
                const popupToClose = this.popups.find(x => x.id == id)
                if (!popupToClose) return
                popupToClose.closing = true
                setTimeout(() => {
                    this.popups = this.popups.filter(x => x != popupToClose)
                }, 150);
            } else {
                const popupsToClose = [...this.popups]
                popupsToClose.forEach(x => x.closing = true)
                setTimeout(() => {
                    this.popups = this.popups.filter(x => !popupsToClose.includes(x))
                }, 150);
            }
        },

        getAllPopups() {
            const popups = []
            for (const key in this.$refs) {
                const value = this.$refs[key] as ComponentPublicInstance[] | null
                if (value && value.length && key.startsWith('popup-')) popups.push(value[0])
            }
            return popups
        },
    },
}
</script>

<style></style>