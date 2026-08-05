# 回滚清单

## 何时回滚

出现持续 5xx、登录或 CSRF 普遍失败、API 被 SPA fallback 替代、静态资源大面积 404、Functions 与页面版本不一致、留言/图片写入一致性异常，或无法在短时间内安全定位的用户可见回归时，应回滚到最后一个已知正常部署。

单个可重试请求失败、只读审计报告差异或 repair marker 本身不等于必须立即回滚；先停止相关写入并判断影响范围。不要用生产数据修复代替应用回滚。

## 选择版本并回滚 EdgeOne

1. 在 GitHub Actions 中找到 `verify`、`server-node20` 和 `e2e` 均通过的最近提交，记录完整 SHA。
2. 对照该部署当时的 `/api/health` `version`、`buildTime` 和 `commitTime`，确认它是最后一个已知正常版本。
3. 在 EdgeOne Makers 项目的部署历史中选择对应 Git 提交并使用平台回滚/重新部署能力。不要本地覆盖 `dist`，不要 force push 或重写 Git 历史。
4. 等待静态资源和 Cloud Functions 同一次部署完成，再检查页面入口引用的 hash 资源与 `/api/health` 版本一致。

EdgeOne 具体项目绑定和运行时约束见 [EdgeOne 运维清单](EDGEONE_SETUP.md)。

## 代码与 Blob 数据边界

代码回滚不等于 Blob 数据回滚。正常回滚不得自动删除、覆盖或重新序列化历史 Blob，也不得复用留言编号、清除墓碑或重建索引。

- 图片 operation 以 alias 和物理 Blob inventory 为恢复依据。`usage/uploads.json` 是可重建缓存；`usage-repair-needed` 表示扣减结果存在不确定性，不得盲目重复扣减。
- `likes/{id}/{uid}.json` 是点赞事实；计数缓存和 `repairs/comment-like-count/*` 只能通过事实审计后修复。
- `recovery-key-claims/*` 可能是仍在执行的用户写入认领；写流量未停止或版本未判定时不得删除。
- 留言删除 repair marker、编号 tombstone 和日期“曾发布”索引都属于历史一致性合同，不能因回滚清理。

以下命令默认只读：

```powershell
npm run audit:uploads
npm run audit:comment-likes
npm run repair:user-claims
node scripts/check-duplicate-users.mjs
node scripts/rebuild-comment-indexes.mjs
node scripts/rebuild-usage.mjs
```

写入修复必须先暂停对应生产写流量、完成并验证全量备份，再使用脚本要求的显式确认参数：

```powershell
npm run audit:comment-likes -- --fix --confirm-production-repair
npm run repair:user-claims -- --fix --confirm-production-repair
node scripts/rebuild-usage.mjs --fix --confirm-production-migration
node scripts/rebuild-comment-indexes.mjs --fix --confirm-production-migration
```

重复用户修复还要求 `ELYTRUE_APP_SECRET`；未完成审计和备份时不得设置修复参数。数据状态不确定时先导出备份、保留 operation/repair marker，并由人工逐项判断。

## 回滚后验证

- `GET /api/health` 返回目标版本、构建时间和提交时间。
- HTML 入口引用的 JS/CSS hash 在当前部署存在，静态资源与 Functions 版本一致。
- 桌面和移动页面、背景、字体、图标、音乐与原图可访问。
- 登录、会话刷新、CSRF、退出和账号恢复没有普遍错误。
- 留言列表、发布、回复、点赞、举报、编号跳转和用户主页分页正常。
- 头像、留言图上传/读取正常，未新增异常 operation 或 usage 偏差。
- HTML/API/图片缓存和安全头正确，日志中没有凭据或用户敏感信息。
- 回滚期间未执行自动数据删除、历史 Blob 覆盖或未授权 repair。
