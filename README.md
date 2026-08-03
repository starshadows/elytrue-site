# 星花札记 · elytrue.com

以爱莉希雅为主题的非商业个人同人网站。项目保留原有全屏背景、主题、音乐、时间轴、账号与留言交互，并以 Vue 3、TypeScript 和 EdgeOne Makers 维护为单仓库全栈应用。

## 运行环境

```text
构建与前端工具链：Node 22.17.1
EdgeOne Cloud Functions：平台管理的 Node 20.x
middleware.js：Edge Runtime / Web APIs / ES2023+
```

这三个环境不能互换：

- `.nvmrc` 推荐本地构建使用 Node `22.17.1`。
- `edgeone.json#nodeVersion` 选择 EdgeOne 的依赖安装和 Vite 构建版本 `22.17.1`。
- `package.json#engines.node` 是开发/构建工具链兼容范围：`>=20.19.0 <21 || >=22.12.0 <23`。
- 服务端类型固定为 `@types/node@20.19.43`；`tsconfig.server.json` 以 ES2022 为输出能力上限，并已启用 `strictNullChecks`、`noUncheckedIndexedAccess` 等增量严格检查。
- 以上配置都不会把 Cloud Functions 切换到 Node 22。`cloud-functions/api/[[default]].js` 和 `server/` 仍以平台管理的 Node 20.x 为生产基线。
- 根目录 `middleware.js` 不是 Node 程序，只使用 `Request`、`Response`、`URL`、`context.env` 等 Edge Runtime 能力。

## 目录

- `src/app/`、`src/features/`、`src/components/`：Vue 根应用、功能 composable 与组件；Auth 和 Theme 已拥有真实响应式状态及行为。
- `src/config/`：站点、SEO、背景、作者、原图和音乐的类型化配置。
- `src/lib/api-client.ts`、`src/net/`：同源 `/api/*` 客户端、CSRF、超时与错误 envelope。
- `cloud-functions/api/[[default]].js`：稳定的 EdgeOne Cloud Functions 入口。
- `server/`：Node 20 兼容的路由、服务、仓储、认证、留言和 Blob 存储逻辑；图片、密码重置、举报和管理员流程由独立 service/repository 承担。
- `shared/`：不依赖 Node 或 DOM 的纯校验模块。
- `middleware.js`：主域跳转、Edge KV 限流和按响应类型附加安全头。
- `public/assets/`、`public/res/`：版本化站点素材、音乐、字体与 UI 资源。

完整分层与数据流见 [架构文档](docs/ARCHITECTURE.md)，素材来源与保留依据见 [素材清单](docs/ASSET_INVENTORY.md)。

## 本地开发与验证

安装 [`.nvmrc`](.nvmrc) 指定的 Node 后执行：

```powershell
npm ci
npm run dev
```

`npm run dev` 只启动 Vite。需要同源 API、内存 Blob 和固定测试数据时：

```powershell
npm run build:edgeone
npm run mock:server
```

连接自己的非生产 EdgeOne Makers 项目后，可运行精确锁定在 lockfile 中的 CLI：

```powershell
npm run dev:edgeone
```

常用验收：

```powershell
npm run lint
npm run format:check
npm run check
npm run check:server
npm test
npm run test:server
npm run check:assets
npm run build:edgeone
npm run test:e2e
```

CI 的 `verify` 和 `e2e` 使用 Node 22.17.1；独立 `server-node20` 任务只运行 `check:server` 与 `test:server`，不会导入 Vite、Vue SFC 或 Playwright。

页面安全头由 Edge Runtime 按响应类型附加：HTML 保持 `script-src 'self'`，API JSON 与图片二进制不附加页面 CSP；所有 HTTPS 响应带一年期、含子域但不含 preload 的 HSTS。会话 Cookie 的 `Secure` 依次依据边缘转发协议、请求 URL 和 `PUBLIC_SITE_URL`，因此 EdgeOne TLS 终止后的内部 HTTP URL 与本地 HTTP Mock 均保持正确行为。

2026-08-03 的本轮维护只执行 Node、类型、静态和构建验证；Playwright/E2E 按任务要求未执行。

## 生产部署

唯一生产部署目标是 EdgeOne Makers。项目连接、环境变量、Blob/KV、管理员初始化、备份、修复和回滚步骤见 [EdgeOne 运维清单](docs/EDGEONE_SETUP.md)。本仓库不包含 Vercel、GitHub Pages、ECS 或独立 Node 服务器部署流程。

所有历史 Blob key、字段语义、内部 ID、公开编号、索引、墓碑、repair marker 和图片别名状态保持存储结构兼容；现有数据无需整体迁移或重新序列化。

## 权利与使用说明

仓库公开用于项目展示、学习和协作查看。仓库未附带开源许可证，也未主动授予复制、修改或再分发代码及素材的许可。

素材来源与画师致谢见 [ASSETS.md](ASSETS.md)，完整权利说明见 [NOTICE.md](NOTICE.md)。角色、作品、图片与音乐权利归各自原作者或官方权利人所有。
