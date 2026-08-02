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

`.nvmrc` 是推荐本地构建版本；`package.json#engines.node` 是开发/构建工具链支持范围；`edgeone.json#nodeVersion` 是 EdgeOne 构建版本。三者都不会改变平台管理的 Cloud Functions Node 20.x。

## 请求与模块流

```text
浏览器
  ├─ 静态 HTML、/assets/*、/res/* ──> EdgeOne 静态资源
  └─ /api/* ──> middleware.js（边缘跳转/限流）
                  └─ cloud-functions/api/[[default]].js
                       └─ server/app.js + routes/registry.js
                            ├─ middleware/：来源、环境、身份
                            ├─ services/：认证与留言用例
                            ├─ repositories/：一致性读取/条件写
                            ├─ domain/：Blob key 合同
                            └─ storage.js：elytrue-data / elytrue-uploads
```

EdgeOne 对精确 `/* -> /index.html` 规则先匹配静态资源和 Functions，仅在没有其他路由时执行 SPA fallback。前端资源以 `/assets/` 根路径加载，因此深层客户端 URL 不会产生相对路径漂移。

## 前端

`src/app/App.vue` 是唯一根应用。`src/features/` 按 auth、comments、gallery、music、theme、settings、timeline 和 admin 提供 Composition API 边界；现有复杂交互由显式 controller 逐步承接，不再向 `window` 批量暴露模块。关键 class、ID、DOM 顺序、背景顺序/焦点和动画参数由视觉基线保护。

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

## 缓存与 CSP

- `/assets/*` 是 Vite hash 或 `elytrue-20260724` 版本目录：`public, max-age=31536000, immutable`。
- `/res/*` 未 hash：`public, max-age=300, must-revalidate`。
- HTML、manifest 和其他未版本化资源：`no-cache`；`/api/*`：`no-store`。
- `script-src 'self'` 已启用；主应用和保留的 `/yumeniwa/` 均无 HTML 内联事件或内联脚本。
- `style-src 'self' 'unsafe-inline'` 暂时保留，因为背景焦点、播放器进度、手势位移、图片缩放、弹窗动画以及 Vue `:style` 仍需运行时样式。移除条件见重构审计。

## 自动化边界

`check:runtime` 同时运行无 Node 类型的 WebWorker/ES2023 middleware 类型检查和导入静态扫描。`check:server` 使用独立 `tsconfig.server.json` 对 Node 20 生产服务端做 `checkJs`；`test:server` 不加载 Vite、Vue SFC 或 Playwright。`check:build` 扫描最终部署资源，证明服务端、测试、EdgeOne CLI 和 Node 专属模块不进入前端 bundle。

## 平台限制

- Blob 单 key 强一致读取与 `onlyIfNew` 可用，但跨 key 业务事务依赖补偿回滚。
- KV 读改写不是跨边缘原子计数；Cloud Functions 进程内限流只提供单实例第二层保护。
- `usage/uploads.json` 跨实例增减可能偏差，使用 `scripts/rebuild-usage.mjs` 只读核对或显式确认修复。
- 真实 Blob 集成测试需要独立非生产项目凭据，默认安全跳过；普通 CI 不访问真实 Blob/KV。
