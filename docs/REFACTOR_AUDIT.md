# 现代化重构审计

基线提交：`3b3b69d02869abcbfd20074e1d311e9af2517537`

## 基线验证

| 命令                    | 原始结果                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm ci`                | 成功；安装 931 个包，完整审计报告 35 个漏洞                                                                    |
| `npm run check`         | 成功                                                                                                           |
| `npm test`              | 93 项：87 通过、6 项真实 EdgeOne 集成测试因无凭据跳过                                                          |
| `npm run build:edgeone` | 成功；70 个文件、89,414,081 bytes，JS 458,005 bytes                                                            |
| `npm run test:e2e`      | 原始失败：Mock Server 在 Windows 将 `file:` URL pathname 与 `path.join` 混用，产生 `C:\C:\...\dist\index.html` |

E2E 原始失败是测试服务器的跨平台路径错误，不是本次重构引入的页面回归。第一阶段仅修复测试工具并重新采集应用未改动时的视觉基线。

## 运行环境边界

```text
构建与前端工具链：Node 22.17.1
EdgeOne Cloud Functions：平台管理的 Node 20.x
middleware.js：Edge Runtime / Web APIs / ES2023+
```

- Node 22.17.1 用于安装、Vite、Vue 类型检查、Lint、构建和 E2E。
- `cloud-functions/api/[[default]].js` 由 EdgeOne Cloud Functions 的 Node 20.x 执行，入口保持不变。
- `middleware.js` 在 Edge Runtime 执行，只能使用 Web API；当前实现使用 `Request`、`Response`、`URL`、`context.env` 和普通 ES 数据结构，没有 Node 导入。

## 当前目录与职责

| 目录/文件                            | 当前职责与问题                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `index.html`                         | 650 行页面、弹窗、背景、文案和大量内联事件                                                   |
| `src/index.ts`                       | 2,778 行命令式入口；留言、用户、主题、音乐、时间轴、手势和工具函数混杂，并使用 `@ts-nocheck` |
| `src/main.ts`                        | 将入口和组件批量暴露到 `window`，挂载空壳 `App.vue`                                          |
| `src/components/`                    | 多个独立 Vue app 分别挂载，部分组件仍使用内联事件和 `@ts-nocheck`                            |
| `src/net/`                           | XHR 客户端；依赖 `window.baseUrl/bgBaseUrl`                                                  |
| `server/app.js`                      | API 路由、上传、用量、认证编排和管理逻辑集中在单文件                                         |
| `server/*.js`                        | 认证、留言、存储、图片、邮件、HTTP 和限流逻辑                                                |
| `cloud-functions/api/[[default]].js` | 稳定的 EdgeOne Cloud Functions `/api/*` 入口                                                 |
| `middleware.js`                      | 主域名重定向及 KV 边缘限流                                                                   |
| `scripts/`                           | Mock、构建信息、导出、重复用户、索引和用量维护                                               |
| `tests/`                             | Node 原生单元/集成测试与 Playwright E2E                                                      |
| `public/`                            | 主 CSS、PWA、16 张 WebP、16 张原图、10 首音乐、图标、字体及旧上游内容                        |

## 前端全局、内联事件和职责拆分

`src/main.ts` 当前执行两次 `Object.assign(window, ...)`。`src/index.ts` 导出约 50 个函数、状态对象和 DOM 引用，其中页面依赖的主要全局包括：

- 留言：`loadComments`、`clearComments`、`seekComment`、`newComment`、`sendMessage`、`Comments`。
- 用户：`User`、`loadUserInfo`、`showUserComment`。
- 弹窗/图片：`Popup`、`showPopup`、`closePopup`、`viewImg`。
- 主题/音乐：`Theme`、`MusicPlayer`、`Settings`。
- 显示/时间轴：`toggleFullscreen`、`toggleTimeline`、`toggleTopComment`。

`index.html` 与运行时生成的 HTML 含 `onclick`、`onchange`、`onfocus`、`onblur` 和 `javascript:`。最终按 feature 拆分为 auth、comments、gallery、music、theme、settings、timeline、admin；DOM 操作收敛为 Vue 模板事件、composable 和少量明确的 DOM controller。

## 当前生产 API

所有路径位于同源 `/api/*`，响应 envelope 保持 `{ code, message, data }`：

- 健康：`GET /api`、`GET /api/health`。
- 账号：`POST user/register|login|logout|resettoken|resetpassword`、`GET user/me|find`、`PUT user/update`、`POST action`。
- 上传：`POST|DELETE uploads/image`；头像、留言图和默认头像 GET 路径。
- 留言：`GET comments|comments/count`、`POST comments/post|comments/like|comments/report`、`DELETE comments/like`。
- 管理：`POST admin/bootstrap|admin/comments/moderate`、`GET admin/reports|admin/usage`。

客户端继续使用 HttpOnly Cookie；非安全方法携带 `X-CSRF-Token`，响应 `data.csrfToken` 更新客户端 token。

## Blob Store 与 key 结构

Store 名称保持：

- `elytrue-data`
- `elytrue-uploads`

主要 key：

- `users/{userId}.json`
- `indexes/users/name/{sha256}.json`
- `indexes/users/email/{keyedDigest}.json`
- `sessions/{tokenHash}.json`
- `password-resets/{tokenHash}.json` 及 `.claimed`
- `comments/{16位内部ID}.json`
- `indexes/comments/number/{公开编号}.json`
- `indexes/comments/by-user/{uid}/{16位内部ID}.json`
- `dates/{YYYY-MM-DD}/{16位内部ID}.json`
- `likes/{commentId}/{userId}.json`
- `reports/{commentId}/{userId}.json`
- `uploads/aliases/avatars|comments/{imageId}.json`
- `usage/uploads.json`
- `repairs/comment-delete/{commentId}.json`

编号占位的 `onlyIfNew`、墓碑空号、日期“曾发布”口径、用户索引、图片 pending/active、强一致读取、补偿回滚和 repair marker 必须保持。

## 依赖基线

直接生产依赖：

- `@edgeone/pages-blob`：Blob Store SDK，生产需要。
- `image-size`：上传图片尺寸校验，生产需要。
- `vue`：前端运行时。

直接开发依赖：

- Vite、plugin-vue、Vue TypeScript 配置、TypeScript、vue-tsc。
- Playwright。
- EdgeOne CLI，仅本地 Makers 调试，不应进入前端 bundle 或 Cloud Function 生产导入图。
- `sass-embedded`，当前 4 个 SFC 使用 SCSS，不能删除。
- legacy 插件当前生成约 291 KiB 未压缩的额外 JS；目标浏览器不需要 Chrome 49，待构建和视觉验证后删除。

当前 `npm audit --omit=dev` 为零漏洞。完整审计的 35 个告警主要来自 EdgeOne CLI 的 COS/npm/esbuild/undici 传递依赖、legacy Babel 链、旧 Vite/Rollup 和 Sass 传递依赖。第二阶段将验证兼容升级；无法由项目安全修复的 CLI-only 告警会逐项隔离说明，不使用强制修复。

### 第二阶段候选与最终版本

2026-08-02 通过 npm registry 检查当前稳定版本、`engines` 和 peer dependency 后得到：

| 包                   | 候选          | 最终               | 选择依据                                                                              |
| -------------------- | ------------- | ------------------ | ------------------------------------------------------------------------------------- |
| Vite                 | 8.2.0         | 8.2.0              | Node 要求 `^20.19.0 \|\| >=22.12.0`；Node 22.17.1 工具链满足，EdgeOne 构建与 E2E 通过 |
| Vue                  | 3.5.40        | 3.5.40             | 3.5 major 当前稳定 patch；行为与视觉回归通过                                          |
| `@vitejs/plugin-vue` | 6.0.8         | 6.0.8              | peer 明确支持 Vite 5–8 和 Vue 3                                                       |
| `vue-tsc`            | 3.3.9         | 3.3.9              | peer 接受 TypeScript 5+；项目类型检查通过                                             |
| TypeScript           | 7.0.2 / 6.0.3 | 6.0.3              | `typescript-eslint` 8.65.0 正式支持 `<6.1.0`，因此不选 TS 7                           |
| `@vue/tsconfig`      | 0.9.1         | 0.9.1              | 当前稳定版，与 TS 6/Vue 3 类型检查通过                                                |
| `sass-embedded`      | 1.100.0       | 1.100.0            | 当前 SFC 仍使用 SCSS；构建通过，不能移除                                              |
| EdgeOne CLI          | 1.6.19        | 1.6.19（精确锁定） | registry 无更新稳定版；继续进入 lockfile，仅用于本地 Makers 调试                      |

同时移除 `@vitejs/plugin-legacy` 及 Chrome 49 双份 bundle。Vite 8 构建后的主 JS 为约 164 KiB（升级前含 legacy 输出合计约 458 KiB）。本地环境实际为 Node 24，因此另以 `node@20.19.5` 独立执行 `tsconfig.server.json` 和全部 93 个服务端测试，87 通过、6 个真实 EdgeOne 凭据测试安全跳过；CI 和 EdgeOne 构建配置仍固定 Node 22.17.1。

第二阶段验证：

- `check`、`check:server`、`test`、`build:edgeone` 全部通过。
- Playwright：17 通过，1 个仅手工生成基线的用例按设计跳过。
- Node 20.19.5：服务端静态检查和 93 个服务端测试通过（6 个凭据测试跳过）。
- `npm audit --omit=dev`：0；完整审计由 35 降至 30，剩余项在最终审计逐项归类。
- 未在 `cloudFunctions.nodejs` 增加运行时字段；Cloud Functions 仍由平台以 Node 20.x 托管。

## 静态素材

明确保留：

- 7 张横屏 WebP、9 张竖屏 WebP。
- 与之对应的 16 张原图。
- 10 首 HOYO-MiX/官方音乐，默认 `HOYO-MiX - Elysian Realm.mp3`。
- favicon、社交分享图、字体、默认头像和当前 UI 引用的 SVG。
- `ASSETS.md`、`NOTICE.md` 及页面中的作者、来源和权利说明。

直接访问保护：

- `public/yumeniwa/` 可由直接 URL 访问，但依赖旧外部服务器；在无法证明用户不依赖前不删除。

### 第六阶段素材审计结果

- 完整清单见 `docs/ASSET_INVENTORY.md`。当前部署素材为 63 个文件、84.72 MiB；16 张 WebP、16 张原图、10 首音乐和 16 个当前 `res` 文件均由静态引用或类型化配置覆盖。
- 删除 Vercel 配置、旧 API 产物转换器、HLS 辅助页、已关闭主题/旧文案/kami 合并逻辑及隐藏小游戏；同时移除缺失 `xh_mdk` 路径，Vite 不再产生这两项未解析素材警告。
- `/yumeniwa/` 仍可直接访问且无法证明无历史用户，因此保留其 3 个文件并从主应用 import graph 隔离。
- `scripts/audit-assets.mjs` 检查缺失、孤立、动态路径、大小写、25 MiB、SHA-256 重复文件及重复音乐；当前通过，无重复音乐或超限文件。

## EdgeOne 与平台约束

- 构建输出 `dist`，构建 Node 由顶层 `nodeVersion` 控制。
- Cloud Functions Node 20.x，默认 30 秒；不在 `cloudFunctions.nodejs` 中声明运行时版本。
- Blob 单次强一致读与 `onlyIfNew` 可用，但批量业务事务需应用层补偿。
- KV 限流是读改写，跨边缘并发不能保证原子计数；Cloud Function 进程内限流仅是单实例二次保护。
- `usage/uploads.json` 的跨实例增减可能偏差，继续保留 `rebuild-usage.mjs`。
- SPA fallback 是 EdgeOne 识别的精确 `/* -> /index.html` 配置，平台先匹配静态资源与 Functions。

### 第五阶段服务端边界结果

- `server/routes/registry.js` 是声明式 API 合同，逐项记录 method、path/prefix、鉴权、CSRF 和管理员要求；`server/app.js` 只按该表分发，未知 method/path 仍返回原 404 envelope。
- `server/domain/blob-keys.js` 集中构造生产 Blob key。构造器保留原前缀、16 位内部 ID 补零、`.json` 后缀、编号座位、墓碑、repair marker 和图片别名字符串；已有数据无需迁移。
- `server/middleware/` 只处理请求来源、环境和客户端标识，`server/services/` 暴露认证/留言用例，`server/repositories/` 固化强一致读取和 `onlyIfNew`，`server/storage.js` 继续持有唯一的 Store 名称与 MemoryStore 注入点，`server/lib/` 保存无业务状态的路由解析。
- `cloud-functions/api/[[default]].js` 入口及默认导出未改；生产代码未引入 Vue、Vite、Playwright、浏览器全局或 Node 22 独占 API。
- 本阶段 `check:server`、运行时边界检查和全部服务端测试通过；另以 Node 20.19.5 执行服务端测试，87 项通过，真实 EdgeOne 凭据测试未进入该离线命令。

### 第七阶段行为与视觉回归结果

- `tests/frontend/api-client.test.ts` 使用 Node 原生测试运行器和 `tsx` 覆盖同源 `/api/*`、`credentials: "include"`、JSON/CSRF、token 刷新、安全方法、401 清理、30 秒默认超时和调用方取消；不引入 Vitest/Jest。
- `tests/contracts.test.js` 固定历史 Blob key 的完整字符串、API 路由唯一性和 `cloud-functions/api/[[default]].js` 稳定入口；`tests/build/output.test.js` 检查 SPA 壳、哈希资源以及部署产物不含服务端、测试、EdgeOne CLI 或 Node 专属模块。
- 新增 SPA fallback 与 `/api/*` 优先级、PWA manifest、16 张背景及焦点、2 个主题、10 首音乐和中英文配置的浏览器契约测试。为使深层 SPA URL 能加载应用，Vite 资源基准由文档相对路径改为站点根路径 `/`；API 路由仍由 Mock/EdgeOne Functions 优先处理。
- 桌面 1440×900 与移动 390×844 截图直接和第一阶段“应用代码未修改”时的 PNG 基线比较，关闭动画并允许最多 0.3% 像素抗锯齿差异，不接受布局、尺寸、颜色或背景焦点变化。视觉测试发现并修复了背景元数据晚于旧启动逻辑应用导致的焦点/顺序回归。
- Mock 的 `POST /__test/reset` 仅在本地测试服务器存在，并同时清理 MemoryStore、上传 Store 和进程内限流 bucket，保证账号、留言和视觉种子不会跨用例泄漏；生产 API 不暴露此入口。
- 阶段结果：5 项 API 客户端测试、2 项构建产物测试、现有服务端/存储/认证/留言/middleware/迁移测试和 22 项 Playwright 测试全部通过；1 项人工基线采集用例按设计跳过。

## 风险与回滚

- 前端视觉风险：保留 class/ID/CSS，分阶段迁移，以固定数据的桌面/移动截图阻断回归。
- API 风险：新增路由与 key 快照，旧测试持续覆盖；任何字段或状态差异均回滚相应提交。
- 存储风险：不运行迁移、不访问生产；repository 重构前后共享现有 MemoryStore/真实集成测试。
- 依赖风险：每次只升级一组兼容依赖；Vite 8 无法通过 EdgeOne 构建时回退最近的兼容稳定线。
- 部署风险：只做本地提交，不推送或部署；每个阶段可用独立提交回退。

## CSP 计划

严格 CSP 只在所有内联脚本和事件删除后启用。最终脚本、连接、图片、媒体、字体、object、base 和 frame 均限制为计划中的同源策略。

现有页面仍大量使用静态 `style` 属性、CSS 自定义属性和 `element.style` 驱动背景焦点、缩放、弹窗来源动画及播放器进度，因此首轮需保留 `style-src 'self' 'unsafe-inline'`。移除条件是把所有静态 style 迁移为样式表、把运行时样式迁移为受控 class/CSS 变量，并通过全部视觉回归。
