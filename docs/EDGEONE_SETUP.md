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

服务端开发类型固定为 `@types/node@20.19.43`。CI 的 `server-node20` 任务必须继续在 Node 20.x 下依次执行 `npm ci`、`npm run check:server` 和 `npm run test:server`；运行时边界脚本只是补充门禁，不能替代真实 Node 20 类型和执行验证。

## 2. 环境变量与绑定

仅在 EdgeOne 项目设置保存：

- `ELYTRUE_APP_SECRET`：至少 32 个随机字符，用于邮箱加密、索引摘要和服务端安全派生。
- `PUBLIC_SITE_URL`：当前 EdgeOne 预览域或 `https://elytrue.com`。
- `ALLOWED_ORIGINS`：允许的 EdgeOne 预览域与正式域，逗号分隔。

真实值不得写入仓库、构建日志或前端变量。

`PUBLIC_SITE_URL` 也参与会话 Cookie 的 `Secure` 判断。Cloud Function 依次检查边缘转发协议首值、请求 URL 协议和该公开 URL；正式 HTTPS 部署必须配置为 `https://`，本地 HTTP Mock 不配置时仍生成可用的非 Secure Cookie。会话创建、滑动续期、注销和删除 Cookie 共用同一判断。

绑定两个 Pages Blob Store：

- `elytrue-data`：用户、索引、会话、恢复密钥版本认领、留言、点赞、举报和元数据。
- `elytrue-uploads`：头像和留言图片。

绑定 Edge KV 为 `ELYTRUE_RATE_LIMIT_KV`。`middleware.js` 只从 `context.env` 获取此绑定；客户端地址只信任 `request.eo.clientIp` 或平台注入的 `context.clientIp`，不会使用可伪造的 `x-forwarded-for`/`cf-connecting-ip`。缺少绑定或可信地址时边缘层跳过该桶，Cloud Functions 的账号维度/单实例内存限流仍工作。`GET /api/health` 在缺少有效 KV binding 时返回 `status: degraded` 和不含配置细节的 `checks.rateLimitKv: degraded`；不得把 KV 名称、环境变量值或秘密写入响应或日志。

Edge KV 不提供原子增量或 CAS，应用内固定窗口在多节点并发下只能 best-effort，不能替代 EdgeOne WAF/频率控制；代码和文档不得将它描述为严格全局限流。生产项目必须在平台侧配置 WAF/频控，且 WAF/平台频控是生产发布阻断项。建议至少配置：

- 登录：按可信 IP 每 15 分钟 12 次；按账号标识摘要每 15 分钟 12 次；失败响应统一限速。
- 注册：按可信 IP 每小时 20 次；按邮箱或用户名摘要每小时 5 次；限制自动化批量注册。
- 恢复：按可信 IP 每小时 5 次；按账号标识摘要每小时 5 次；恢复密钥不得作为明文规则或日志字段。
- 上传：登录用户按 IP 与用户标识每 10 分钟 12 次，并限制请求体大小和单连接速率。
- 留言：登录用户按 IP 与用户标识每 10 分钟 10 次；点赞、举报分别设置更宽但独立的窗口。
- 管理员接口：管理员初始化按 IP 与账号每小时 5 次；其他管理员写接口按 IP 与账号每 10 分钟 30 次。

以上规则应在 WAF/平台侧用接口路径和 HTTP 方法分别配置，账号规则使用平台支持的不可逆摘要或在应用层完成的摘要标识，不使用邮箱、用户名、恢复密钥明文。没有平台原子计数能力时不要在应用代码中模拟复杂的精确分布式计数。

## 3. 首次管理员

全新、空的 `elytrue-data` Store 中，第一个成功注册的账号自动成为唯一管理员，并立即写入永久关闭标记。后续注册账号均为普通用户，不需要配置 `ADMIN_BOOTSTRAP_SECRET`，也不需要手工调用初始化接口。

管理员以后仍从普通登录弹窗使用用户名或邮箱和密码登录；登录后在个人主页显示“管理举报与留言”。必须妥善保存首个账号的密码和注册后只显示一次的恢复密钥。两者同时丢失时无法自助恢复，只能按站点运维流程人工处理。

保留的 `POST /api/admin/bootstrap` 仅用于兼容已有部署的人工恢复流程，不是新站点初始化步骤。

## 4. 发布前验收

日常发布使用 [发布清单](RELEASE.md)；本节保留平台级要求。

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
npm run check:build-budget
npm run test:e2e
npm run check:assets
npm audit --omit=dev
npm audit
```

完整 `npm audit` 可能报告只属于精确锁定 EdgeOne CLI 的传递开发依赖；按 `docs/REFACTOR_AUDIT.md` 逐项复核，不使用 `npm audit fix --force`，也不把 CLI 改成运行时 `npx` 下载。

部署预览后检查：

- `GET /api/health` 返回目标 `version`、`buildTime` 和 `commitTime`。
- 注册、恢复密钥保存、用户名/邮箱登录、刷新恢复、退出、密钥轮换与账号恢复。
- 留言发布、回复、点赞、举报、编号跳转和用户主页分页。
- 桌面/移动背景焦点、主题、音乐恢复、语言、PWA。
- HTML/API/图片分类安全头、版本化 `/assets/*` immutable、未 hash `/res/*` 重新验证、动态头像成功响应 immutable 且错误响应 no-store、HSTS 以及 HTML CSP。HSTS 必须为 `max-age=31536000; includeSubDomains` 且不含 preload；HTML `script-src` 必须保持仅 `'self'`。
- Cloud Functions 日志不包含密码、恢复密钥、完整邮箱密文或 API Key。

## 5. 域名与回滚

完整应用回滚和数据边界见 [回滚清单](ROLLBACK.md)。

- 在 EdgeOne 绑定 `elytrue.com`。
- `www.elytrue.com` 与 `blog.elytrue.com` 由 `middleware.js` 301 到主域。
- 页面底部备案链接保持不变。

发布失败时在 EdgeOne Makers 回滚到最近一个已验收部署版本；不要运行数据迁移作为应用回滚手段。API 与 Blob key 保持向后兼容，因此正常代码回滚不要求重写历史数据。

## 6. 手动备份与只读核查

账号恢复不需要全量迁移：没有恢复字段的历史用户继续正常登录，在个人主页输入当前密码后按需生成即可。历史 `password-resets/*` Blob 已不再被代码读取；部署不会自动删除。如需清理，必须另行备份并获得明确的生产数据删除授权。

用户资料、会话版本与恢复密钥写入通过 `recovery-key-claims/*` 短期占位串行化，正常完成或捕获到异常时会重试清理。若 Cloud Function 在写用户本体前被强制终止，先运行 `npm run repair:user-claims` 只读报告；确认 claim 已超过 5 分钟、完成全量备份并暂停账号写入流量后，才可执行 `npm run repair:user-claims -- --fix --confirm-production-repair`。不得在仍有账号写请求时删除当前版本占位。

只对明确授权的项目临时设置 EdgeOne 项目 ID 和 API Token：

```powershell
npm run export:data
npm run audit:uploads
```

导出写入 Git 忽略的 `exports/`。`audit:uploads` 只读分页检查 alias、物理 Blob、图片 operation marker 和 usage 缓存，异常时退出码为 1，不自动删除或修复。完成后清除 Token。普通构建和测试不访问真实 Blob/KV。

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

- Blob 跨 key 操作非事务化，服务层通过图片上传/删除 operation marker 和留言 repair marker 保留可重试的补偿状态。
- KV 限流是边缘读改写，跨节点不保证严格原子；服务端进程内限流是第二层保护，平台 WAF 才是生产强制层。
- `usage/uploads.json` 可能因跨实例并发出现偏差；以 alias 和物理 Blob inventory 审计结果为恢复依据。确认备份和停写后，`scripts/rebuild-usage.mjs --fix --confirm-production-migration` 会重算缓存并完成待修复的图片 usage operation marker。
- 图片先 pending，留言成功后 active；清理任务不得删除已被历史留言引用的图片。
- 留言硬删除永久保留公开编号墓碑和日期“曾发布”记录，避免编号重排。
- 新数据自动写公开编号反向记录；旧举报仅在字段、本体和反向记录均无法解析时进行每页 100、最多 10 页的有限兼容扫描，并以 5 分钟缓存和渐进回填避免重复扫描。该方案不要求生产数据迁移。
