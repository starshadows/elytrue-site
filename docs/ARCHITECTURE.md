# EdgeOne-only 架构

## 三种运行环境

```text
构建与前端工具链：Node 22.17.1
EdgeOne Cloud Functions：平台管理的 Node 20.x
middleware.js：Edge Runtime / Web APIs / ES2023+
```

| 环境             | 代码范围                                                | 可用能力                                                         | 明确禁止                                                  |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| 构建与前端工具链 | npm、Vite 8、Vue 类型检查、ESLint、Playwright、素材审计 | Node 22.17.1、浏览器 DOM/Web API                                 | 不代表生产 Functions 运行时                               |
| Cloud Functions  | `cloud-functions/`、`server/`、服务端可用的 `shared/`   | 平台管理的 Node 20.x、EdgeOne Blob SDK、Web `Request`/`Response` | Node 22 独占 API、Vue/Vite/Playwright、浏览器全局         |
| Edge Runtime     | 根目录 `middleware.js`                                  | ES2023+、`Request`、`Response`、`URL`、`context.env`、Edge KV    | `node:*`、fs/path、Node crypto、Buffer、process、文件系统 |

`.nvmrc` 是推荐本地构建版本；`package.json#engines.node` 是开发/构建工具链支持范围；`edgeone.json#nodeVersion` 是 EdgeOne 构建版本。三者都不会改变平台管理的 Cloud Functions Node 20.x。服务端类型固定解析为 `@types/node@20.19.43`，以 ES2022 target、Node 20 类型和独立 Node 20 CI 共同约束生产能力。

## 请求与模块流

```text
浏览器
  ├─ 静态 HTML、/assets/*、/res/* ──> EdgeOne 静态资源
  └─ /api/* ──> middleware.js（边缘跳转/限流/按内容类型附加安全头）
                  └─ cloud-functions/api/[[default]].js
                       └─ server/app.js + routes/registry.js
                            ├─ middleware/：来源、环境、身份
                            ├─ services/：图片、密码重置、举报与管理员用例
                            ├─ repositories/：图片、用户、举报的一致性存储访问
                            ├─ domain/：Blob key 合同
                            └─ storage.js：elytrue-data / elytrue-uploads
```

EdgeOne 对精确 `/* -> /index.html` 规则先匹配静态资源和 Functions，仅在没有其他路由时执行 SPA fallback。前端资源以 `/assets/` 根路径加载，因此深层客户端 URL 不会产生相对路径漂移。

## 前端

`src/app/App.vue` 是唯一根应用，统一渲染站点外壳、留言、弹窗、图片查看器和浮动消息。`src/features/` 按 auth、comments、gallery、music、pwa、settings、theme、timeline、viewport 和 admin 划分类型化边界：store 持有共享响应式状态和 API 流程，controller 持有音乐、主题、时间轴及浏览器生命周期。组件只保留模板内交互和局部 DOM 布局行为；弹窗、浮动消息和图片查看器不再创建独立 Vue 应用。关键 class、ID、DOM 顺序、背景顺序/焦点和动画参数保持不变。

`src/config/site.ts` 是站点、SEO 和中英文文案来源；`src/config/assets.ts` 是 16 张背景、作者/来源、原图映射和 10 首音乐来源。PWA manifest 在构建前从站点配置生成。

类型化 API 客户端固定同源 `/api/*`、`credentials: "include"`、JSON envelope `{ code, message, data }`、非安全方法 CSRF、30 秒默认超时、调用方取消和 401 本地状态清理。

## API 与存储兼容

`server/routes/registry.js` 声明 method、path、鉴权、CSRF 和管理员要求；`server/domain/blob-keys.js` 集中生产 key。下列合同保持不变：

- Blob Store：`elytrue-data`、`elytrue-uploads`。
- Cookie 名称/属性、CSRF 流程、密码散列和邮箱加密格式。
- API 路径、HTTP 方法、请求字段、响应 envelope 和状态码语义。
- 留言 16 位内部 ID、稳定公开编号、编号墓碑和日期“曾发布”口径。
- 用户/日期索引、`onlyIfNew` 编号占位、repair marker。
- 图片 alias 的 pending/active 生命周期和补偿回滚。

历史数据无需迁移即可读取、更新和删除；代码不依赖 JSON 属性顺序或空白。

新留言会建立按内部留言 ID 指向公开编号的轻量反向记录；新举报同时保存 `commentNumber`。读取历史举报时依次使用举报字段、仍存在的留言本体和反向记录。仅对无法解析且已删除的旧举报执行每页 100、最多 10 页的兼容扫描，结果（含未命中）缓存 5 分钟，命中后渐进回填举报与反向记录；不要求生产全量迁移。

## 缓存与 CSP

- `/assets/*` 是 Vite hash 或 `elytrue-20260724` 版本目录：`public, max-age=31536000, immutable`。
- `/res/*` 未 hash：`public, max-age=300, must-revalidate`。
- HTML、manifest 和其他未版本化资源：`no-cache`；`/api/*`：`no-store`。
- EdgeOne 配置对所有响应设置 `Strict-Transport-Security: max-age=31536000; includeSubDomains`，暂不使用 preload。
- Edge Runtime 根据最终 `Content-Type` 管理页面头：HTML 使用 `script-src 'self'`、`X-Frame-Options: DENY` 和 Permissions Policy；API JSON 与图片二进制不附加页面 CSP。
- `style-src 'self' 'unsafe-inline'` 暂时保留，因为背景焦点、播放器进度、手势位移、图片缩放、弹窗动画以及 Vue `:style` 仍需运行时样式。移除条件见重构审计。

## 自动化边界

`check:runtime` 同时运行无 Node 类型的 WebWorker/ES2023 middleware 类型检查和导入静态扫描，并阻断 Node 21+ 的 SQLite、`process.getBuiltinModule`、新版 `import.meta` 与文件系统 glob API。`check:server` 使用独立 `tsconfig.server.json` 和 Node 20 类型对生产服务端做 `checkJs`，已启用 `strictNullChecks`、`noUncheckedIndexedAccess`、`alwaysStrict` 等增量严格选项；`test:server` 不加载 Vite、Vue SFC 或 Playwright。`check:build` 扫描最终部署资源，证明服务端、测试、维护脚本、环境文件、source map、EdgeOne CLI 和 Node 专属模块不进入前端 bundle。

2026-08-03 本轮维护未启动浏览器；Playwright/E2E 按任务要求未执行。

## 平台限制

- Blob 单 key 强一致读取与 `onlyIfNew` 可用，但跨 key 业务事务依赖补偿回滚。
- KV 读改写不是跨边缘原子计数；Cloud Functions 进程内限流只提供单实例第二层保护。
- `usage/uploads.json` 跨实例增减可能偏差，使用 `scripts/rebuild-usage.mjs` 只读核对或显式确认修复。
- 真实 Blob 集成测试需要独立非生产项目凭据，默认安全跳过；普通 CI 不访问真实 Blob/KV。
