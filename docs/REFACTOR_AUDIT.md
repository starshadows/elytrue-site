# 现代化重构审计

基线提交：`3b3b69d02869abcbfd20074e1d311e9af2517537`

## 2026-08-03 增量维护

本轮从远端 `main` 的 `901fb29` 开始，保持主题、视觉、动画、DOM、API、Blob key、Cookie、CSRF、密码/邮箱格式和首个注册用户自动成为管理员的行为。

- 会话 Cookie 统一由 `isSecureRequest` 判断：依次读取 `x-forwarded-proto` 首值、请求 URL 协议和 `PUBLIC_SITE_URL`。创建、滑动续期、注销和删除均走同一逻辑；正式 EdgeOne HTTPS 带 `Secure`，未配置 HTTPS 来源的本地 HTTP Mock 不带。
- `@types/node` 声明与 lockfile 均固定为 `20.19.43`；服务端 target 保持 ES2022，运行时边界阻断 Node 21+ SQLite、`process.getBuiltinModule`、新版 `import.meta` 和文件系统 glob API。Node 20 CI 继续执行 `npm ci`、`check:server`、`test:server`。
- `tsconfig.server.json` 已启用 `strictNullChecks`、`noUncheckedIndexedAccess`、`alwaysStrict`、`strictBindCallApply`、`strictBuiltinIteratorReturn` 和 `strictFunctionTypes`。`strict`、`noImplicitAny` 暂未整体开启：现有 JS 打开两者仍有 444 个错误，其中 357 个为 TS7006；只开启 `noImplicitAny` 仍有 426 个错误。`skipLibCheck` 暂留，因为此轮只收紧生产 JS，不把第三方声明升级风险混入行为重构；没有用 exclude、`@ts-ignore` 或 `any` 掩盖。
- `src/index.js` 按仓库物理行从 2410 行降到 2209 行。新增 `features/auth/auth-store.ts`，真实持有登录状态、用户 ID、profile、单飞初始化、刷新和失效；新增 `features/theme/theme-controller.ts`，真实持有主题、背景、caption、定时器、布局与音乐联动。Comments、Music、Timeline、Popup、Viewport/PWA 及留言 DOM/加载/编辑仍是后续迁移债务。
- `server/app.js` 按仓库物理行从 594 行降到 423 行，主要保留路由匹配、解析、service 调用、响应适配和顶层错误边界。新增 image/user/report repositories，以及 image/password-reset/report/admin services；图片 pending/active、别名与用量、密码重置、举报和管理员流程已移出入口。只做转发的 auth/comment service 已删除。
- 新留言建立按内部 ID 查询公开编号的轻量反向记录，新举报写 `commentNumber`。读取顺序为举报字段、留言本体、反向记录；只有仍无法解析且已删除的旧举报才每页 100、最多 10 页扫描旧编号座位。命中会渐进回填，命中与未命中均缓存 5 分钟，不要求生产迁移，正常管理请求不再用 `Infinity` 扫编号。
- 旧外部服务器全屏代理入口、canonical/alternate、iframe、脚本和 4 个文件已彻底删除；生产源码与 `dist` 的路径和内容均有静态门禁，旧路径使用现有 SPA fallback。
- `edgeone.json` 对所有响应加入一年期、含子域且不含 preload 的 HSTS。Edge Runtime 按 `Content-Type` 只给 HTML 添加页面 CSP、`X-Frame-Options` 与 Permissions Policy；API JSON 和图片二进制无页面 CSP。HTML `script-src` 仅 `'self'`；`style-src 'unsafe-inline'` 暂留给背景焦点、进度、手势、缩放、弹窗动画和 Vue 运行时样式。
- 本轮没有设置真实 EdgeOne 凭据，没有访问或修改 Blob/KV，没有运行生产迁移，没有创建账号，也没有部署 EdgeOne。Playwright/E2E 按任务要求未执行。

本轮最终非浏览器验收：

| 命令                        | 结果                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `npm ci`                    | 成功；另以真实 Node 20.19.5 + npm 10.9.9 全新安装 912 个包                                               |
| `npm run lint`              | 成功，0 warning                                                                                          |
| `npm run format:check`      | 成功                                                                                                     |
| `npm run check`             | 成功；Vue、测试、Edge Runtime 类型和运行时边界通过                                                       |
| `npm run check:server`      | 成功；本地默认环境与真实 Node 20.19.5 均通过                                                             |
| `npm test`                  | 成功；服务端 122 项中 116 通过、6 项真实凭据测试跳过；前端 10 项通过                                     |
| `npm run test:server`       | 成功；真实 Node 20.19.5 下同为 116 通过、6 跳过                                                          |
| `npm run check:assets`      | 成功；60 个 `public/` 文件、84.71 MiB、59 个静态引用                                                     |
| `npm run build:edgeone`     | 成功；Vite 构建与 7 项产物检查通过；无测试/脚本/环境文件/凭据/source map/旧代理标记，API 入口与 SPA 分离 |
| `npm audit --omit=dev`      | 成功；0 漏洞                                                                                             |
| `npm audit`                 | 按预期非零；12 moderate、14 high、3 critical                                                             |
| Playwright / Chromium / E2E | 按任务要求未执行                                                                                         |

完整 audit 的 29 项告警都只由 `edgeone@1.6.19` 本地 Makers CLI 及其传递开发依赖引入，主要来源为内嵌 npm/sigstore/minimatch、COS SDK 的 XML/request 链、旧 esbuild 和 undici。它们不进入 `dist`，也不进入 `server/` 或 `cloud-functions/` 的生产 import graph；`npm audit --omit=dev` 为 0，产物和运行时边界测试均通过。部分传递包存在单独修复版，但当前 registry 最新稳定 EdgeOne CLI 仍为 `1.6.19`，没有可兼容升级的根版本；audit 还明确报告该 CLI 的旧 esbuild/undici 无根级自动修复。未运行 `npm audit fix --force`，继续等待上游发布兼容版本。

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

## 重构前目录与职责

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

## 重构前前端全局、内联事件和职责拆分

原始 `src/main.ts` 执行两次 `Object.assign(window, ...)`。原始 `src/index.ts` 导出约 50 个函数、状态对象和 DOM 引用，其中页面依赖的主要全局包括：

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
- Node 20.19.5：服务端静态检查通过；93 项服务端测试中 87 项通过、6 项凭据测试跳过。
- `npm audit --omit=dev`：0；完整审计由 35 降至 30，剩余项在最终审计逐项归类。
- 未在 `cloudFunctions.nodejs` 增加运行时字段；Cloud Functions 仍由平台以 Node 20.x 托管。

## 静态素材

明确保留：

- 7 张横屏 WebP、9 张竖屏 WebP。
- 与之对应的 16 张原图。
- 10 首 HOYO-MiX/官方音乐，默认 `HOYO-MiX - Elysian Realm.mp3`。
- favicon、社交分享图、字体、默认头像和当前 UI 引用的 SVG。
- `ASSETS.md`、`NOTICE.md` 及页面中的作者、来源和权利说明。

### 第六阶段素材审计结果

- 完整清单见 `docs/ASSET_INVENTORY.md`。该历史阶段部署素材为 63 个文件、84.72 MiB；本轮删除旧代理后为 60 个文件、84.71 MiB，当前 16 张 WebP、16 张原图、10 首音乐和 16 个 `res` 文件仍由静态引用或类型化配置覆盖。
- 删除 Vercel 配置、旧 API 产物转换器、HLS 辅助页、已关闭主题/旧文案/kami 合并逻辑及隐藏小游戏；同时移除缺失 `xh_mdk` 路径，Vite 不再产生这两项未解析素材警告。
- 2026-08-03 进一步删除旧外部服务器全屏代理入口及全部 4 个文件，不再保留 allowlist。
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
- `server/middleware/` 只处理请求来源、环境和客户端标识；`server/services/` 现在真实承担图片、密码重置、举报与管理员用例；`server/repositories/` 封装图片、用户、举报的 Blob 访问；`server/storage.js` 继续持有唯一 Store 名称与 MemoryStore 注入点，`server/lib/` 保存无业务状态的路由解析。
- `cloud-functions/api/[[default]].js` 入口及默认导出未改；生产代码未引入 Vue、Vite、Playwright、浏览器全局或 Node 22 独占 API。
- 本阶段 `check:server`、运行时边界检查和全部服务端测试通过；另以 Node 20.19.5 执行服务端测试，87 项通过，真实 EdgeOne 凭据测试未进入该离线命令。

### 第七阶段行为与视觉回归结果

- `tests/frontend/api-client.test.ts` 使用 Node 原生测试运行器和 `tsx` 覆盖同源 `/api/*`、`credentials: "include"`、JSON/CSRF、token 刷新、安全方法、401 清理、30 秒默认超时和调用方取消；不引入 Vitest/Jest。
- `tests/contracts.test.js` 固定历史 Blob key 的完整字符串、API 路由唯一性和 `cloud-functions/api/[[default]].js` 稳定入口；`tests/build/output.test.js` 检查 SPA 壳、哈希资源以及部署产物不含服务端、测试、EdgeOne CLI 或 Node 专属模块。
- 新增 SPA fallback 与 `/api/*` 优先级、PWA manifest、16 张背景及焦点、2 个主题、10 首音乐和中英文配置的浏览器契约测试。为使深层 SPA URL 能加载应用，Vite 资源基准由文档相对路径改为站点根路径 `/`；API 路由仍由 Mock/EdgeOne Functions 优先处理。
- 桌面 1440×900 与移动 390×844 截图直接和第一阶段“应用代码未修改”时的 PNG 基线比较，关闭动画并允许最多 0.3% 像素抗锯齿差异，不接受布局、尺寸、颜色或背景焦点变化。视觉测试发现并修复了背景元数据晚于旧启动逻辑应用导致的焦点/顺序回归。
- 最终重复运行发现同毫秒随机内部 ID 会让测试的发布顺序假设不稳定，并暴露用户留言尾部只有隐藏项时 `hasMore` 保守误报。测试种子现固定时间顺序；服务端在收满一页后只读探测剩余可见项，仍受原 `scanCap` 限制，不改变 cursor、ID、索引或隐藏语义。留言套件连续 10 次通过。
- Mock 的 `POST /__test/reset` 仅在本地测试服务器存在，并同时清理 MemoryStore、上传 Store 和进程内限流 bucket，保证账号、留言和视觉种子不会跨用例泄漏；生产 API 不暴露此入口。
- 阶段结果：5 项 API 客户端测试、2 项构建产物测试、现有服务端/存储/认证/留言/middleware/迁移测试和 22 项 Playwright 测试全部通过；1 项人工基线采集用例按设计跳过。

## 最终安全审计

审计日期为 2026-08-02。没有执行 `npm audit fix --force`，也没有把必要开发工具改成运行时 `npx` 下载。

### 生产依赖

`npm audit --omit=dev`：

```text
info 0 / low 0 / moderate 0 / high 0 / critical 0 / total 0
```

`npm ls --omit=dev --all --package-lock-only` 的根依赖只有 `@edgeone/pages-blob@0.0.15`、`image-size@2.0.2` 和 `vue@3.5.40`。Cloud Functions 的静态 import graph 只从前两者加载服务端运行依赖；Vue 只进入前端构建。

### 完整开发依赖

完整 `npm audit`：

```text
info 0 / low 0 / moderate 12 / high 14 / critical 3 / total 29
```

29 项全部由精确锁定的 `edgeone@1.6.19` 本地 Makers CLI 传递引入。表中的“传递修复”表示 npm 已知子包有修复版，但当前 EdgeOne CLI 的内嵌 npm/COS 依赖尚未采用；registry 没有更新且通过本项目审计的 EdgeOne CLI 版本，因此根依赖没有兼容自动修复。

| 包                            | 等级     | 来源路径                                | `dist` | Cloud Functions | 当前修复状态与处置                                                            |
| ----------------------------- | -------- | --------------------------------------- | ------ | --------------- | ----------------------------------------------------------------------------- |
| `edgeone`                     | high     | 直接 devDependency                      | 否     | 否              | `fixAvailable=false`；精确保留 1.6.19，仅对受信仓库本地调试，等待官方兼容版本 |
| `esbuild`                     | moderate | `edgeone` / Nuxt 构建链                 | 否     | 否              | 根 Vite 使用已更新 0.28.1；CLI 内旧 0.19.12 无根级兼容修复，隔离接受          |
| `undici`                      | high     | `edgeone → undici@5`                    | 否     | 否              | `fixAvailable=false`；仅 CLI 网络客户端，限制为受信 EdgeOne 端点，等待上游    |
| `cos-nodejs-sdk-v5`           | moderate | `edgeone → cos-nodejs-sdk-v5`           | 否     | 否              | 有传递修复、CLI 未采用；项目生产不导入 COS SDK，隔离接受                      |
| `fast-xml-parser`             | critical | `edgeone → cos-nodejs-sdk-v5`           | 否     | 否              | 有传递修复、CLI 未采用；不让 CLI 解析不受信 XML，等待上游                     |
| `request`                     | critical | `edgeone → cos-nodejs-sdk-v5 → request` | 否     | 否              | 已弃用链有传递修复但无根级兼容替换；仅 CLI，隔离接受                          |
| `form-data`                   | critical | `edgeone → COS → request`               | 否     | 否              | 有传递修复、CLI 未采用；仅 CLI multipart，隔离接受                            |
| `qs`                          | moderate | `edgeone → COS → request`               | 否     | 否              | 有传递修复、CLI 未采用；生产 API 不加载该副本                                 |
| `tough-cookie`                | moderate | `edgeone → COS → request`               | 否     | 否              | 有传递修复、CLI 未采用；仅 CLI cookie jar                                     |
| `uuid`                        | moderate | `edgeone → COS → request`               | 否     | 否              | 有传递修复、CLI 未采用；生产服务端使用 Node Web Crypto UUID                   |
| `conf`                        | moderate | `edgeone → cos-nodejs-sdk-v5`           | 否     | 否              | 有传递修复、CLI 未采用；仅本地 CLI 配置                                       |
| `ajv`                         | moderate | `edgeone → COS/conf/request`            | 否     | 否              | 有传递修复、CLI 未采用；生产请求校验不加载此副本                              |
| `ajv-formats`                 | moderate | `edgeone → COS → conf`                  | 否     | 否              | 有传递修复、CLI 未采用；仅本地 CLI                                            |
| `npm`                         | high     | `edgeone → npm@10`                      | 否     | 否              | 有传递修复、CLI 内嵌版本未更新；不用其处理不受信包源                          |
| `@npmcli/arborist`            | high     | `edgeone → npm`                         | 否     | 否              | 有传递修复、CLI 未采用；仅依赖树操作                                          |
| `@npmcli/metavuln-calculator` | high     | `edgeone → npm/arborist`                | 否     | 否              | 有传递修复、CLI 未采用；仅本地审计链                                          |
| `libnpmdiff`                  | high     | `edgeone → npm`                         | 否     | 否              | 有传递修复、CLI 未采用；项目运行时不加载                                      |
| `libnpmexec`                  | high     | `edgeone → npm`                         | 否     | 否              | 有传递修复、CLI 未采用；项目脚本不通过该副本执行生产代码                      |
| `libnpmfund`                  | high     | `edgeone → npm`                         | 否     | 否              | 有传递修复、CLI 未采用；仅本地元数据                                          |
| `libnpmpack`                  | high     | `edgeone → npm`                         | 否     | 否              | 有传递修复、CLI 未采用；部署不由该包打包 Functions                            |
| `libnpmpublish`               | high     | `edgeone → npm`                         | 否     | 否              | 有传递修复、CLI 未采用；本项目不执行 npm publish                              |
| `pacote`                      | high     | `edgeone → npm`                         | 否     | 否              | 有传递修复、CLI 未采用；仅受信 registry/lockfile                              |
| `sigstore`                    | high     | `edgeone → npm/pacote`                  | 否     | 否              | 有传递修复、CLI 未采用；不进入签名或生产验证路径                              |
| `@sigstore/core`              | moderate | `edgeone → npm → sigstore`              | 否     | 否              | 有传递修复、CLI 未采用；隔离接受                                              |
| `@sigstore/sign`              | moderate | `edgeone → npm → sigstore`              | 否     | 否              | 有传递修复、CLI 未采用；本项目不通过 CLI 签名产物                             |
| `@sigstore/verify`            | moderate | `edgeone → npm → sigstore`              | 否     | 否              | 有传递修复、CLI 未采用；不用于生产请求验证                                    |
| `brace-expansion`             | high     | `edgeone → npm` 的内嵌依赖              | 否     | 否              | hoisted 副本已更新至 2.1.4；CLI 内嵌 npm 副本无法独立更新，仅本地文件匹配     |
| `picomatch`                   | high     | `edgeone → fast-glob/Nuxt`              | 否     | 否              | 根 Vite/ESLint 使用更新副本；受影响副本仅 CLI，隔离接受                       |
| `ip-address`                  | moderate | `edgeone → npm → socks`                 | 否     | 否              | 有传递修复、CLI 未采用；仅本地代理解析                                        |

### 已修复、接受与部署隔离证明

- 已修复：移除 legacy Chrome 49 双份 bundle，升级 Vite/Vue/TypeScript/ESLint/Sass 工具链；再使用非强制 `npm audit fix` 将共享的 `minimatch` 更新到 9.0.9、hoisted `brace-expansion` 更新到 2.1.4。完整告警由基线 35 降为 29，生产审计保持 0。
- 暂时接受：上表 29 项。共同边界是 `edgeone@1.6.19` devDependency；不对不受信仓库、XML、glob、包源或代理输入运行 CLI。官方发布兼容新版本后重新审计并精确锁定升级。
- 不进入 `dist`：`tests/build/output.test.js` 扫描所有构建 JS，不允许 `edgeone makers`、Playwright、服务端路径或 Node 模块；构建产物检查通过。
- 不进入 Cloud Functions：`server/` 与 `cloud-functions/` 无 `edgeone`、Vite、Vue 或 Playwright import；`check:runtime` 阻断跨运行时导入。
- lockfile 证明：`npm ls --omit=dev --all --package-lock-only` 不包含 EdgeOne CLI；CLI 继续保留在 lockfile，避免临时下载和绕过审计。

## 最终 EdgeOne 安全与缓存配置

全站安全头启用：

```text
script-src 'self'
connect-src 'self'
img-src 'self' data: blob:
media-src 'self' blob:
font-src 'self'
object-src 'none'
base-uri 'self'
frame-ancestors 'none'
style-src 'self' 'unsafe-inline'
```

严格脚本 CSP 启用前已移除主应用动态编辑器的 `onfocus/onblur` 属性；旧外部代理入口随后已整体删除。构建测试扫描 HTML 和 JS 字符串，阻断新的内联事件属性。

`style-src 'self' 'unsafe-inline'` 仍然必需，具体位置包括：

- `src/app/shell.html` 的背景焦点、初始显示/透明度与历史 DOM 契约。
- `src/config/assets.ts` 设置背景 `background-position`。
- `src/features/theme/theme-controller.ts` 的背景焦点与轮播，以及 `src/index.js` 仍保留的播放器/时间轴、移动下拉面板、弹窗和状态显示。
- `src/settings/index.ts` 的页面缩放和 Wallpaper Engine 样式。
- `ProgressSlider.vue`、`ImgViewer.vue`、`FloatMsgs.vue`、`PullDownRefresh.ts` 的进度、手势、缩放和过渡。

移除条件：把静态 style 迁移为已验证的样式类，把连续动态值改为受限 CSS 自定义属性或 nonce/hash 方案，并在桌面/移动视觉基线、主题、背景焦点、动画、图片缩放和播放器测试全部通过后再删除 `'unsafe-inline'`。

缓存层次：

- `/assets/*`：`public, max-age=31536000, immutable`。
- `/res/*`：`public, max-age=300, must-revalidate`。
- HTML、manifest 和未版本化根资源：`no-cache`。
- `/api/*`：`no-store`（Functions 响应也保持 no-store）。

根目录 `middleware.js` 只从 `context.env` 读取 KV，不再依赖任何全局注入；无 `node:*`、Buffer、process、文件系统或 Node crypto。

## 八阶段本地提交

1. `eb1676f` — `chore: add refactor audit and baseline tests`
2. `a5e20ec` — `chore: align dependencies with EdgeOne runtime`
3. `6e89dc9` — `refactor: centralize site content and asset metadata`
4. `6c2b446` — `refactor: modularize frontend application`
5. `cada92d` — `refactor: modularize EdgeOne API backend`
6. `9071fa0` — `chore: remove unused upstream content and assets`
7. `3e4b046` — `test: add behavior and visual regression coverage`
8. `HEAD` — `docs: document EdgeOne-only architecture and operations`

第 8 个提交无法在自身内容中嵌入自身 SHA（写入 SHA 会再次改变该提交）；提交完成后的权威值由 `git rev-parse HEAD` 和最终执行报告给出。整个分支只包含这 8 个本地提交。

## 最终验收结果

以下是 2026-08-02 上一阶段从全新安装执行的历史结果；2026-08-03 本轮结果以本节顶部增量记录和最终提交报告为准：

| 命令                    | 结果                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `npm ci`                | 成功；使用精确 Node 22.17.1 与 npm 11.12.1，全新安装 912 个包     |
| `npm run lint`          | 成功，0 warning                                                   |
| `npm run format:check`  | 成功                                                              |
| `npm run check`         | 成功；Vue/测试类型与三类运行时边界通过                            |
| `npm run check:server`  | 成功                                                              |
| `npm test`              | 成功；服务端 96 项中 90 通过、6 项真实凭据测试跳过；前端 5 项通过 |
| `npm run test:server`   | 成功；90 通过、6 跳过                                             |
| `npm run build:edgeone` | 成功；73 个文件、89,069,515 bytes（84.94 MiB）                    |
| `npm run test:e2e`      | 成功；22 通过、1 项人工基线采集跳过，并在严格 CSP 响应头下运行    |
| `npm run check:assets`  | 成功；64 个 `public/` 文件、84.72 MiB、无超限或重复音乐           |
| `npm audit --omit=dev`  | 成功；0 漏洞                                                      |
| `npm audit`             | 按预期非零；12 moderate、14 high、3 critical，全部逐项记录于上表  |

前端构建代码为 190,092 bytes JS 和 42,279 bytes CSS（未压缩总和）；Vite 输出的四个 JS chunk gzip 合计约 64.47 KiB。构建没有未解析素材警告。

另以真实 Node 20.19.5 调用 npm 11.12.1 完成 `npm ci`，随后只运行 `check:server` 和 `test:server`，均成功。安装阶段对 EdgeOne CLI 的 `ink`、`cli-truncate`、`slice-ansi` 开发依赖报告 Node >=22 警告，但没有关闭 engine 检查且任务未失败；服务端生产 import graph 不加载这些包。Node 20 测试仍为 90 通过、6 个无真实凭据的集成测试跳过。

上一阶段没有设置真实 EdgeOne 凭据、没有访问 Blob/KV、没有运行生产迁移、没有部署或推送。

## 风险与回滚

- 前端视觉风险：保留 class/ID/CSS，分阶段迁移，以固定数据的桌面/移动截图阻断回归。
- API 风险：新增路由与 key 快照，旧测试持续覆盖；任何字段或状态差异均回滚相应提交。
- 存储风险：不运行迁移、不访问生产；repository 重构前后共享现有 MemoryStore/真实集成测试。
- 依赖风险：每次只升级一组兼容依赖；Vite 8 无法通过 EdgeOne 构建时回退最近的兼容稳定线。
- 部署风险：上一阶段只做本地提交；2026-08-03 本轮按要求直接推送线性 `main` 历史，不执行 EdgeOne 部署。

## CSP 计划

严格 CSP 只在所有内联脚本和事件删除后启用。最终脚本、连接、图片、媒体、字体、object、base 和 frame 均限制为计划中的同源策略。

现有页面仍大量使用静态 `style` 属性、CSS 自定义属性和 `element.style` 驱动背景焦点、缩放、弹窗来源动画及播放器进度，因此首轮需保留 `style-src 'self' 'unsafe-inline'`。移除条件是把所有静态 style 迁移为样式表、把运行时样式迁移为受控 class/CSS 变量，并通过全部视觉回归。
