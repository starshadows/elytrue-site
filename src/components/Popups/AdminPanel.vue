<template>
  <div class="adminPanel">
    <h2>
      <span class="ui zh">留言管理</span><span class="ui en">Moderation</span>
    </h2>

    <p class="numbering-note">
      <span class="ui zh"
        >公开编号用于回复和跳转；删除后保留编号，避免旧链接指向其他留言。</span
      >
      <span class="ui en"
        >Public numbers remain reserved after deletion so old links cannot point
        to another message.</span
      >
    </p>

    <p class="usage" v-if="usage">
      <span class="ui zh">图片累计记录：</span
      ><span class="ui en">Recorded uploads: </span>
      {{ formatBytes(usage.uploadedBytes || 0) }}
      <strong v-if="usage.warning"
        ><span class="ui zh">（已到警戒线）</span
        ><span class="ui en"> (warning)</span></strong
      >
    </p>

    <div v-if="loading" class="empty">
      <span class="ui zh">正在加载…</span><span class="ui en">Loading…</span>
    </div>
    <div v-else-if="reports.length == 0" class="empty">
      <span class="ui zh">暂无举报</span><span class="ui en">No reports</span>
    </div>

    <article
      v-for="report in reports"
      :key="report.id || `${report.commentId}-${report.userId}`"
    >
      <header>
        <b v-if="report.displayId">
          #{{ report.displayId }}
          <small v-if="report.deleted">
            <span class="ui zh">（已删除，编号保留）</span
            ><span class="ui en"> (deleted, number reserved)</span>
          </small>
        </b>
        <b v-else>
          <span class="ui zh">{{
            report.deleted ? '已删除留言' : '旧版留言'
          }}</span>
          <span class="ui en">{{
            report.deleted ? 'Deleted message' : 'Legacy message'
          }}</span>
        </b>
        <time>{{ new Date(report.createdAt).toLocaleString() }}</time>
      </header>
      <p>{{ report.reason }}</p>
      <p v-if="report.selfReport" class="self-report">
        <span class="ui zh">留言作者自举报</span>
        <span class="ui en">Self-report by the author</span>
      </p>
      <div v-if="!report.deleted">
        <button @click="moderate(report, 'hide')">
          <span class="ui zh">隐藏</span><span class="ui en">Hide</span>
        </button>
        <button @click="moderate(report, 'restore')">
          <span class="ui zh">恢复</span><span class="ui en">Restore</span>
        </button>
        <button class="danger" @click="moderate(report, 'delete')">
          <span class="ui zh">删除</span><span class="ui en">Delete</span>
        </button>
      </div>
      <p v-else class="deleted-note">
        <span class="ui zh">留言正文已删除；举报记录保留用于审计。</span>
        <span class="ui en"
          >The message was deleted; its report remains for audit history.</span
        >
      </p>
    </article>
  </div>
</template>

<script lang="ts">
import XHR from '../../net/xhr'
import FloatMsgs from '../FloatMsgs'

interface Report {
  id?: string
  commentId: number
  userId: string
  displayId?: number | null
  deleted?: boolean
  selfReport?: boolean
  createdAt: number
  reason: string
}

interface Usage {
  uploadedBytes: number
  warning?: boolean
}

export default {
  data: () => ({
    loading: true,
    reports: [] as Report[],
    usage: null as Usage | null,
  }),

  methods: {
    formatBytes(value: number) {
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
      return `${(value / 1024 / 1024).toFixed(1)} MiB`
    },

    load() {
      this.loading = true
      Promise.all([
        XHR.get<Report[]>('admin/reports'),
        XHR.get<Usage>('admin/usage'),
      ])
        .then(([reports, usage]) => {
          this.reports = reports || []
          this.usage = usage
        })
        .finally(() => {
          this.loading = false
        })
    },

    moderate(report: Report, action: 'hide' | 'restore' | 'delete') {
      const label = report.displayId ? `#${report.displayId}` : '该留言'
      if (action == 'delete' && !window.confirm(`确定删除留言 ${label}？`))
        return
      XHR.post('admin/comments/moderate', {
        commentId: report.commentId,
        action,
      }).then((r) => {
        if (r.code == 1) {
          FloatMsgs.show({
            type: 'success',
            msg: '<span class="ui zh">管理操作已完成</span><span class="ui en">Moderation completed</span>',
          })
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
.numbering-note,
.empty {
  text-align: center;
}

.numbering-note,
.deleted-note {
  opacity: 0.72;
  font-size: 0.85em;
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

article small {
  font-weight: normal;
}

article button {
  flex: 1;
}

.danger {
  color: #a5163a;
}
</style>
