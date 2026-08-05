# 发布清单

生产唯一部署目标是 EdgeOne Makers。平台连接、Store、KV 和环境变量的首次配置见 [EdgeOne 运维清单](EDGEONE_SETUP.md)。

## 发布前

1. 使用 `.nvmrc` 指定的 Node 22.17.1，并确认 `node --version`、`npm --version` 和工作区状态。
2. 执行 `npm ci`，不得使用会改写 lockfile 的临时依赖安装代替。
3. 确认 `ELYTRUE_APP_SECRET`、`PUBLIC_SITE_URL` 和 `ALLOWED_ORIGINS` 只存在于 EdgeOne 项目设置。已有部署仅在确有兼容需要时保留 `ADMIN_BOOTSTRAP_SECRET`，不得写入仓库或构建日志。
4. 确认 `elytrue-data`、`elytrue-uploads` 两个 Blob Store 和 `ELYTRUE_RATE_LIMIT_KV` 绑定到目标生产项目；普通发布不读取、导出或迁移生产 Blob。确认 WAF/平台频控已启用并覆盖下方列出的生产接口；这是生产发布阻断项。
5. 确认首个管理员已经存在且能够登录。不要在管理员状态不明时调用兼容用 `POST /api/admin/bootstrap`，也不要把发布与管理员初始化混为同一步骤。
6. 检查 GitHub Actions 最近一次已知正常的 `verify`、`server-node20` 和 `e2e`，并确认将要发布的提交已进入 `main`。

## 完整验证

```powershell
npm ci
npm run lint
npm run format:check
npm run check
npm run check:server
npm test
npm run check:assets
npm run build:edgeone
npm run check:build-budget
npm run test:e2e
```

`npm run build:edgeone` 依次执行素材审计、正式构建、部署产物测试和构建大小预算。生产依赖高危审计必须阻断发布：

```powershell
npm audit --omit=dev --audit-level=high
npm run audit:dev:critical
```

完整开发依赖审计由 `npm run audit:dev:critical` 执行；它只 allowlist 带注释的 EdgeOne CLI 传递依赖，未列入的 critical 会阻断。不使用 `npm audit fix --force`。

生产 WAF/平台频控是发布阻断项，至少核对以下规则已经启用：

- 登录：可信 IP 和账号摘要分别限制为每 15 分钟 12 次。
- 注册：可信 IP 每小时 20 次，邮箱或用户名摘要每小时 5 次。
- 恢复：可信 IP 和账号摘要分别限制为每小时 5 次。
- 上传：IP 与用户标识每 10 分钟 12 次，并限制请求体和连接速率。
- 留言：IP 与用户标识每 10 分钟 10 次；点赞、举报独立限速。
- 管理员：初始化按 IP 与账号每小时 5 次，其他写接口每 10 分钟 30 次。

账号规则只能使用不可逆摘要，不能把邮箱、用户名或恢复密钥明文放进 WAF 规则、日志或诊断响应。没有平台原子能力时，应用层限流只按 best-effort 验收，不得作为严格全局计数证明。

## 发布方式

EdgeOne Makers 连接公开仓库 `starshadows/elytrue-site` 的 `main` 分支，安装命令为 `npm ci`，构建命令为 `npm run build:edgeone`，输出目录为 `dist`。合并或推送到受保护的 `main` 后等待 GitHub 必需检查和 EdgeOne 构建完成，不手工上传本地 `dist` 覆盖平台产物。

部署完成后请求 `GET /api/health`，核对：

- `status` 为 `ok`；
- `version` 与目标 Git 短提交一致；
- `buildTime` 是本次 EdgeOne 构建时间；
- `commitTime` 与目标提交时间一致。

若静态页面与 `/api/health` 版本不一致，停止验收并按 [回滚清单](ROLLBACK.md) 处理，不继续执行数据修复。

## 烟雾测试

- 页面：桌面和移动首屏背景、文字、弹窗、语言、主题和时间轴正常。
- API：`/api/health`、匿名留言列表和错误 envelope 正常，API 响应不被 SPA fallback 替代。
- 图片：站点图标、背景预览、原图下载、留言图和头像可访问，内容类型与缓存头正确。
- 登录：用户名/邮箱登录、刷新恢复、当前设备退出和所有设备退出正常。
- 留言：发布、回复、点赞、举报、公开编号跳转和用户主页分页正常。
- 音乐：默认曲目、播放暂停、切歌顺序和恢复播放状态正常。
- 安全头：HTML CSP、HSTS、API JSON `no-store`、版本化 `/assets/*` immutable 和未 hash `/res/*` 重新验证符合 `edgeone.json`；动态头像成功响应 immutable、错误响应 no-store。

## 发布后观察

观察 Cloud Functions 错误率、30 秒超时、Edge KV best-effort 限流、WAF/平台频控命中、图片上传失败、`usage-repair-needed`、留言点赞 repair marker、账号 mutation claim 和静态资源 404。日志不得包含密码、恢复密钥、完整邮箱、Cookie 或 API Token。

出现以下任一情况时，停止所有生产修复和迁移操作：版本不一致、持续写流量未停止、Blob inventory 与 alias 不一致、operation phase 无法判定、备份不完整、审计结果在重复运行间变化，或无法确认 repair marker 对应的当前数据版本。先保留现场、只读审计并按回滚清单处理。
