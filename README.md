# 星花札记 · elytrue.com

以爱莉希雅为主题的非商业个人同人网站。项目使用 Vue 3、Vite、Node.js Cloud Functions 和 EdgeOne Pages Blob/KV，保持 EdgeOne Makers 单仓库全栈部署。

## 运行环境与目录

- 本地构建和 CI 使用 `.nvmrc` 指定的 Node 22.17.1；`package.json#engines` 是工具链支持范围。
- `cloud-functions/api/[[default]].js` 与 `server/` 以平台管理的 Node 20.x 为生产边界。
- `middleware.js` 运行在 Edge Runtime，只使用 Web API 与 `context.env`，不能导入 Node API。
- `src/app/`、`src/components/`、`src/features/` 是 Vue 应用、组件和响应式状态；`src/config/` 管理站点与素材清单。
- `server/` 持有路由、认证、服务、仓储与 Blob 访问；`shared/` 是前后端共用纯校验代码。
- `public/assets/` 保存版本化背景、原图和音乐，`public/res/` 保存小型 UI、字体与备案资源。
- `scripts/` 包含构建审计、只读核查及需显式确认的生产修复工具。

浏览器的同源 `/api/*` 请求经 `middleware.js` 进入 Cloud Function，再由 `server/app.js` 的手写路由表分发。静态文件和 SPA fallback 由 `edgeone.json` 管理，不存在独立服务器部署目标。

## 本地开发与验证

```powershell
npm ci
npm run dev
```

`npm run dev` 只启动 Vite，不模拟 Blob、KV 或 Functions。同源本地 API 使用构建产物和内存 Store：

```powershell
npm run build:edgeone
npm run mock:server
```

连接自己的非生产 EdgeOne Makers 项目后可运行 `npm run dev:edgeone`。常用发布前验证顺序：

```powershell
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

`npm run report:assets` 输出素材引用和预算报告。真实 EdgeOne 集成测试仅可使用独立非生产项目的 `EDGEONE_TEST_PROJECT_ID` 与 `EDGEONE_TEST_TOKEN`；未设置时自动跳过。

## EdgeOne 部署

EdgeOne Makers 连接 `starshadows/elytrue-site` 的 `main` 分支，执行 `npm ci` 和 `npm run build:edgeone`，输出 `dist`。Cloud Function 地域为 `ap-shanghai`，最长执行 30 秒。生产项目必须绑定：

- Blob Store `elytrue-data`：用户、会话、留言、索引、点赞、举报、repair marker 与元数据。
- Blob Store `elytrue-uploads`：头像和留言图片。
- Edge KV `ELYTRUE_RATE_LIMIT_KV`：边缘 best-effort 限流；生产还必须配置 EdgeOne WAF/频率控制。

必需环境变量仅存放在 EdgeOne 项目设置：

- `ELYTRUE_APP_SECRET`：至少 32 个随机字符，用于服务端加密、摘要和安全派生。
- `PUBLIC_SITE_URL`：正式站为 `https://elytrue.com`，也用于 Session Cookie 的 `Secure` 判断。
- `ALLOWED_ORIGINS`：允许的正式域和预览域，逗号分隔。
- `ADMIN_BOOTSTRAP_SECRET`：只为已有部署的兼容管理员恢复流程保留；新站首个注册账号自动成为管理员。

部署后核对 `/api/health` 的 `version`、`buildTime`、`commitTime`，并验证桌面/移动页面、注册登录、恢复密钥、留言发布/回复/点赞/举报/编号跳转、上传、缓存与安全头。版本不一致或持续 5xx 时在 EdgeOne 部署历史回滚到最近已验收提交，不用数据迁移代替应用回滚。

## 数据与安全边界

- 不改变 `elytrue-data`、`elytrue-uploads`、Session Cookie、CSRF、API 路径、响应 envelope、Blob key 或已有字段语义。
- `comments/{16位内部ID}.json` 是留言事实；公开编号映射、编号墓碑、公开/用户 read view、latest 快照、点赞事实、图片 alias 和 repair marker 均须保持兼容。
- Blob 跨 key 操作不是事务；发布、图片和 read model 依赖补偿及 repair marker。不得因代码回滚删除墓碑、claim 或 operation marker。
- 恢复密钥原文只在注册、恢复或轮换成功时返回一次；服务端只保存独立 scrypt 哈希。历史用户和历史 `password-resets/*` Blob 不自动迁移或删除。
- `usage/uploads.json` 与留言点赞计数是可审计缓存。`npm run audit:uploads`、`npm run audit:comment-likes`、`npm run repair:user-claims`、`npm run rebuild:comment-views`、`scripts/check-duplicate-users.mjs` 和 `scripts/rebuild-usage.mjs` 默认只读。
- 任何生产修复必须先完整备份并暂停对应写流量，再使用脚本要求的 `--fix`、`--confirm-production-repair` 或 `--confirm-production-migration`。凭据只临时放入环境变量，导出位于被忽略的 `exports/`。
- 日志、Issue、提交和构建产物不得包含密码、恢复密钥、Cookie、完整邮箱、EdgeOne Token、应用密钥或生产 Blob 导出。

## 素材与权利

仓库没有开源许可证；公开可见不代表授予复制、修改、商用或再分发代码、文字和素材的许可。角色、作品名称、官方美术及 HOYO-MiX 音乐权利归官方权利人，二创图片权利归各画师：

- `landscape1`、`landscape2`：官方美术。
- `landscape3`、`landscape4`、`portrait4`、`portrait5`：合悟昂，Pixiv 56022318，按作者主页转载要求标注。
- `landscape5` 至 `landscape7`、`portrait6` 至 `portrait9`：喵咕君QAQ(KH3)，Pixiv 58434088，经许可转载。
- `portrait1`、`portrait2`：nami，Pixiv 89748593，经许可转载。
- `portrait3`：roena，Pixiv 35132995，经许可转载。

页面图片保存界面展示作者、来源链接和原图入口。使用素材前仍须遵守权利人的最新规则并在需要时另行取得授权。新增或替换素材必须更新 `src/config/assets.ts`、页面致谢与本节，并通过 `npm run report:assets`；任何单文件不得超过 EdgeOne 25 MiB 限制。
