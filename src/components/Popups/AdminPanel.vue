<template>
    <div class="adminPanel">
        <h2><span class="ui zh">留言管理</span><span class="ui en">Moderation</span></h2>

        <p class="usage" v-if="usage">
            <span class="ui zh">图片累计记录：</span><span class="ui en">Recorded uploads: </span>
            {{ formatBytes(usage.uploadedBytes || 0) }}
            <strong v-if="usage.warning"><span class="ui zh">（已到警戒线）</span><span class="ui en"> (warning)</span></strong>
        </p>

        <div v-if="loading" class="empty"><span class="ui zh">正在加载…</span><span class="ui en">Loading…</span></div>
        <div v-else-if="reports.length == 0" class="empty"><span class="ui zh">暂无举报</span><span class="ui en">No reports</span></div>

        <article v-for="report in reports" :key="report.id || `${report.commentId}-${report.userId}`">
            <header>
                <b>#{{ report.commentId }}</b>
                <time>{{ new Date(report.createdAt).toLocaleString() }}</time>
            </header>
            <p>{{ report.reason }}</p>
            <div>
                <button @click="moderate(report.commentId, 'hide')"><span class="ui zh">隐藏</span><span class="ui en">Hide</span></button>
                <button @click="moderate(report.commentId, 'restore')"><span class="ui zh">恢复</span><span class="ui en">Restore</span></button>
                <button class="danger" @click="moderate(report.commentId, 'delete')"><span class="ui zh">删除</span><span class="ui en">Delete</span></button>
            </div>
        </article>
    </div>
</template>

<script lang="ts">
// @ts-nocheck

export default {
    data: () => ({
        loading: true,
        reports: [],
        usage: null,
    }),

    methods: {
        formatBytes(value) {
            if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
            return `${(value / 1024 / 1024).toFixed(1)} MiB`
        },

        load() {
            this.loading = true
            Promise.all([
                XHR.get('admin/reports'),
                XHR.get('admin/usage'),
            ]).then(([reports, usage]) => {
                this.reports = reports || []
                this.usage = usage
            }).finally(() => {
                this.loading = false
            })
        },

        moderate(commentId, action) {
            if (action == 'delete' && !window.confirm(`确定删除留言 #${commentId}？`)) return
            XHR.post('admin/comments/moderate', { commentId, action }).then(r => {
                if (r.code == 1) {
                    FloatMsgs.show({ type: 'success', msg: '<span class="ui zh">管理操作已完成</span><span class="ui en">Moderation completed</span>' })
                    this.load()
                }
            })
        },
    },

    mounted() {
        this.load()
    },
}
</script>

<style scoped>
.adminPanel {
    width: min(40rem, 82vw);
    max-height: 75vh;
    overflow: auto;
}

.usage,
.empty {
    text-align: center;
}

article {
    margin: 0.8rem 0;
    padding: 0.85rem;
    border-radius: 0.8rem;
    background: rgb(255 255 255 / 55%);
}

article header,
article > div {
    display: flex;
    justify-content: space-between;
    gap: 0.6rem;
}

article time {
    opacity: 0.65;
}

article button {
    flex: 1;
}

.danger {
    color: #a5163a;
}
</style>
