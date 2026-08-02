# EdgeOne Makers 运维清单

生产环境只使用 EdgeOne Makers。本清单不包含 Vercel、GitHub Pages、ECS 或独立 Node 服务器部署方案。

## 1. 运行时与构建

```text
构建与前端工具链：Node 22.17.1
EdgeOne Cloud Functions：平台管理的 Node 20.x
middleware.js：Edge Runtime / Web APIs / ES2023+
```

项目连接公开仓库 `starshadows/elytrue-site`，生产分支选择 `main`：

- 安装：`npm ci`
- 构建：`npm run build:edgeone`
- 输出：`dist`
- 构建 Node：`edgeone.json#nodeVersion = 22.17.1`
- Cloud Function 入口：`cloud-functions/api/[[default]].js`
- Cloud Function 地域：`ap-shanghai`

`cloudFunctions.nodejs` 只保留平台支持的 `maxDuration` 等字段，不声明 runtime 或 nodeVersion。生产 Functions 始终按平台管理的 Node 20.x 编写。

## 2. 环境变量与绑定

仅在 EdgeOne 项目设置保存：

- `ELYTRUE_APP_SECRET`：至少 32 个随机字符，用于邮箱加密和索引摘要。
- `RESEND_API_KEY`：Resend API Key。
- `RESEND_FROM_EMAIL`：重置邮件发件地址，需先在 Resend 验证域名。
- `RESEND_FROM_NAME`：重置邮件发件人名称，默认 `星花札记`。
- `PUBLIC_SITE_URL`：当前 EdgeOne 预览域或 `https://elytrue.com`。
- `ALLOWED_ORIGINS`：允许的 EdgeOne 预览域与正式域，逗号分隔。

真实值不得写入仓库、构建日志或前端变量。

绑定两个 Pages Blob Store：

- `elytrue-data`：用户、索引、会话、重置令牌、留言、点赞、举报和元数据。
- `elytrue-uploads`：头像和留言图片。

绑定 Edge KV 为 `ELYTRUE_RATE_LIMIT_KV`。`middleware.js` 只从 `context.env` 获取此绑定；缺少绑定时边缘层跳过计数，Cloud Functions 的进程内限流仍工作，但生产验收必须确认 KV 已绑定。

## 3. 首次管理员

全新、空的 `elytrue-data` Store 中，第一个成功注册的账号自动成为唯一管理员，并立即写入永久关闭标记。后续注册账号均为普通用户，不需要配置 `ADMIN_BOOTSTRAP_SECRET`，也不需要手工调用初始化接口。

管理员以后仍从普通登录弹窗使用用户名或邮箱和密码登录；登录后在个人主页显示“管理举报与留言”。必须妥善保管首个账号密码；未配置 Resend 时无法通过邮件找回密码。

保留的 `POST /api/admin/bootstrap` 仅用于兼容已有部署的人工恢复流程，不是新站点初始化步骤。

## 4. 发布前验收

本地和 CI 必须通过：

```powershell
npm ci
npm run lint
npm run format:check
npm run check
npm run check:server
npm test
npm run test:server
npm run build:edgeone
npm run test:e2e
npm run check:assets
npm audit --omit=dev
npm audit
```

完整 `npm audit` 可能报告只属于精确锁定 EdgeOne CLI 的传递开发依赖；按 `docs/REFACTOR_AUDIT.md` 逐项复核，不使用 `npm audit fix --force`，也不把 CLI 改成运行时 `npx` 下载。

部署预览后检查：

- `GET /api/health` 返回目标 `version`、`buildTime` 和 `commitTime`。
- 注册、用户名/邮箱登录、刷新恢复、退出与找回密码。
- 留言发布、回复、点赞、举报、编号跳转和用户主页分页。
- 桌面/移动背景焦点、主题、音乐恢复、语言、PWA。
- HTML/API 缓存头、`/assets/*` immutable、`/res/*` 重新验证以及 CSP。
- Cloud Functions 日志不包含密码、重置 token、完整邮箱密文或 API Key。

## 5. 域名与回滚

- 在 EdgeOne 绑定 `elytrue.com`。
- `www.elytrue.com` 与 `blog.elytrue.com` 由 `middleware.js` 301 到主域。
- `mail.elytrue.com` 仅用于 Resend 发信认证。
- 页面底部备案链接保持不变。

发布失败时在 EdgeOne Makers 回滚到最近一个已验收部署版本；不要运行数据迁移作为应用回滚手段。API 与 Blob key 保持向后兼容，因此正常代码回滚不要求重写历史数据。

## 6. 手动备份与只读核查

只对明确授权的项目临时设置 EdgeOne 项目 ID 和 API Token：

```powershell
npm run export:data
```

导出写入 Git 忽略的 `exports/`。完成后清除 Token。普通构建、测试和本次重构均不访问真实 Blob/KV。

以下命令默认只读：

```powershell
node scripts/check-duplicate-users.mjs
node scripts/rebuild-comment-indexes.mjs
node scripts/rebuild-usage.mjs
```

任何写入都必须先完成备份，并显式使用脚本要求的 `--fix`、`--confirm-production-migration` 等确认参数。留言编号迁移会修改本体和索引，不能通过“只删索引”回滚；没有生产变更授权时不得执行。

## 7. 可选的非生产集成测试

真实 EdgeOne Blob 测试只允许指向独立非生产项目：

```powershell
$env:EDGEONE_TEST_PROJECT_ID = '<non-production-project>'
$env:EDGEONE_TEST_TOKEN = '<temporary-token>'
node --test tests/integration.test.js
```

测试使用 `integration-test/` 前缀并尝试清理。未设置凭据时安全跳过；不得将生产项目凭据用于常规 CI 或本地回归。

## 8. 平台限制与修复工具

- Blob 跨 key 操作非事务化，服务层保留补偿回滚与 repair marker。
- KV 限流是边缘读改写，跨节点不保证严格原子；服务端进程内限流是第二层保护。
- `usage/uploads.json` 可能因跨实例并发出现偏差；以 alias `size` 重算为准。
- 图片先 pending，留言成功后 active；清理任务不得删除已被历史留言引用的图片。
- 留言硬删除永久保留公开编号墓碑和日期“曾发布”记录，避免编号重排。
