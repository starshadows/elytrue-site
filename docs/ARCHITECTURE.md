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
                        └─ server/app.js + routes/registry.js + routes/policy.js
                            ├─ middleware/：来源、环境、身份
                             ├─ services/：图片、账号恢复、举报与管理员用例
                            ├─ repositories/：图片、用户、举报的一致性存储访问
                            ├─ domain/：Blob key 合同
                            └─ storage.js：elytrue-data / elytrue-uploads
```

EdgeOne 对精确 `/* -> /index.html` 规则先匹配静态资源和 Functions，仅在没有其他路由时执行 SPA fallback。前端资源以 `/assets/` 根路径加载，因此深层客户端 URL 不会产生相对路径漂移。

## 前端

`src/app/App.vue` 是唯一根应用，统一渲染站点外壳、留言、弹窗、图片查看器和浮动消息。`src/features/` 按 auth、comments、gallery、music、pwa、settings、theme、timeline、viewport 和 admin 划分类型化边界：store 持有共享响应式状态和 API 流程，controller 持有音乐、主题、时间轴及浏览器生命周期。组件只保留模板内交互和局部 DOM 布局行为；弹窗、浮动消息和图片查看器不再创建独立 Vue 应用。关键 class、ID、DOM 顺序、背景顺序/焦点和动画参数保持不变。

Comments store 以 `jumping` 和 `jumpNumber` 管理公开编号跳转：请求完成后保留目标，`CommentsPanel` 在 Vue 完成 DOM 更新后定位留言并调用 `finishJump()`，随后恢复双向分页；失败、刷新、时间轴加载和后续跳转都会释放或替换旧状态。发布成功直接合并服务端返回的完整留言，不再固定等待或刷新首屏；首次、新旧分页和用户主页留言只在真实请求超过 200ms 时显示加载动画，错误结束动画并保留重试入口。点赞 pending 状态同样只由 Comments store 管理，组件不保留独立 timer。Timeline 只通过 `refreshComments` 和 `loadCommentsAtTime` 两个明确回调加载留言。

头像弹窗先使用 Auth store 已缓存的 Profile 打开，用户留言再独立分页加载，不重复阻塞式请求 `/user/me`。开发环境通过 `src/lib/performance.ts` 记录 `comments-initial`、`comment-post`、`user-popup-open` 和 `user-comments-first-page`；生产构建不写额外性能日志。

`src/config/site.ts` 是站点、SEO 和中英文文案来源；`src/config/assets.ts` 是 16 张背景、作者/来源、原图映射和 10 首音乐来源。PWA manifest 在构建前从站点配置生成。

类型化 API 客户端固定同源 `/api/*`、`credentials: "include"`、JSON envelope `{ code, message, data }`、非安全方法 CSRF、30 秒默认超时、调用方取消和 401 本地状态清理。

## API 与存储兼容

`server/routes/registry.js` 声明 method、path、鉴权、CSRF 和管理员要求；`routes/policy.js` 在调用 Handler 前统一执行来源检查、Session 解析、角色与 CSRF 策略，启动时同时验证每条声明都有完整策略和实际 Handler。`server/domain/blob-keys.js` 集中生产 key。下列合同保持不变：

- Blob Store：`elytrue-data`、`elytrue-uploads`。
- Cookie 名称/属性、CSRF 流程、密码散列和邮箱加密格式。
- 除已移除的邮件重置接口外，既有 API 路径、HTTP 方法、请求字段、响应 envelope 和状态码语义。
- 留言 16 位内部 ID、稳定公开编号、编号墓碑和日期“曾发布”口径。
- 用户/日期索引、`onlyIfNew` 编号占位、repair marker。
- 图片 alias 的 pending/active 生命周期和补偿回滚。

历史数据无需迁移即可读取、更新和删除；代码不依赖 JSON 属性顺序或空白。

### 账号恢复

- 新用户记录增加 `recoveryKeyHash`、`recoveryKeyCreatedAt` 和 `recoveryKeyVersion`；恢复密钥原文只在注册成功响应中返回一次，不进入个人资料、日志、URL、Cookie 或浏览器持久存储。
- 密钥包含 28 个无歧义随机字符，约 139 bit 熵；`server/crypto.js` 通过独立的 `generateRecoveryKey`、`hashRecoveryKey` 和 `verifyRecoveryKey` 语义封装使用 scrypt 与安全比较。
- `POST /api/user/recover` 接收 `identifier`、`recoveryKey`、`password`，成功后更新密码、增加 `sessionVersion`、废止旧密钥并返回一次新密钥，不创建登录会话。账号不存在、缺少密钥和密钥错误使用同一错误。
- `POST /api/user/recovery-key` 需要会话、CSRF 和当前密码，用于已有用户首次生成或重新生成密钥。`recovery-key-claims/{userId}/{version}.json` 通过 `onlyIfNew` 认领当前用户记录版本；恢复、密钥轮换、资料更新、全设备注销和管理员初始化共用该写入栅栏，防止旧会话的并发写入覆盖已轮换的密码、密钥或 `sessionVersion`。
- 边缘层按 IP、Cloud Functions 层按 IP 与账号标识摘要限流；限流 key 不含恢复密钥或完整邮箱。
- 没有恢复字段的历史用户仍可登录和使用，不会在启动时自动补写。邮件重置代码已删除；历史 `password-resets/*` 数据保持惰性，不自动迁移或删除。

新留言会建立按内部留言 ID 指向公开编号的轻量反向记录；新举报同时保存 `commentNumber`。读取历史举报时依次使用举报字段、仍存在的留言本体和反向记录。仅对无法解析且已删除的旧举报执行每页 100、最多 10 页的兼容扫描，结果（含未命中）缓存 5 分钟，命中后渐进回填举报与反向记录；不要求生产全量迁移。

### 留言读取

- 主时间线优先从 `meta/comments-number-hint.json` 向下读取稳定编号座位：每批最多预取 48 个座位，Blob 读取并发上限为 8，总扫描仍受 `scanCap` 限制；`cursor + direction` 表示严格的内部 ID 分页边界，公开编号跳转和历史 `from` 语义保持不变。仅当编号索引不存在或不足以覆盖历史未编号数据时回退旧 `comments/` 枚举。
- `likes/{id}/{uid}.json` 是点赞事实来源，点赞/取消点赞的 `onlyIfNew` 记录保持幂等；`cache/comment-like-count/{id}.json` 是独立列表展示缓存，避免更新计数时回写整条留言并与隐藏/删除竞争。新留言以版本化的本体零值省去空缓存读取，历史留言首次读取会按 Like 事实惰性建立缓存。缓存更新失败写 `repairs/comment-like-count/{id}.json`，`npm run audit:comment-likes` 默认只读核对，只有显式 `--fix --confirm-production-repair` 才修复缓存和 marker。
- 新留言同时写 `indexes/comments/by-user-v2/{uid}/{invertedId}-{commentId}.json`，用户主页按倒序 key 每页最多读取 20 条；没有 v2 数据的历史用户自动回退 `indexes/comments/by-user/{uid}/`，无需全量迁移。隐藏留言页使用服务端 `nextCursor` 继续扫描，避免空页循环或遗漏。
- 一页内的 `replyid` 先去重，再直接读取目标留言并返回最小 `replyPreview`；目标删除或对当前用户不可见时返回删除占位，不暴露隐藏内容。`CommentCard` 不再挂载后逐卡发请求。
- 留言路由返回 `Server-Timing` 的 `auth`、`index`、`comments`、`likes`、`replies` 和 `total` 分项，字段不包含用户标识或凭据。

### 图片操作

- 上传和删除分别写 `operations/image-uploads/{imageId}.json` 与 `operations/image-deletes/{imageId}.json`。上传别名失败会删除本次 Blob；补偿失败或用量缓存失败保留未完成 phase，供只读审计定位。
- 删除先用 `onlyIfNew` 认领操作，再按 Blob、alias、usage 阶段推进；扣减前先持久化 `usage-adjusting`，无法判定扣减是否落盘时转为 `usage-repair-needed`，不冒险重复扣减。其余部分失败写 `lastError` 并可重试，完成后重复请求保持幂等。
- alias/物理 Blob inventory 是恢复依据，`usage/uploads.json` 是可重建缓存。`npm run audit:uploads` 只读报告孤立 Blob、悬空别名、非法 size、未完成 operation 和用量偏差；显式运行 `scripts/rebuild-usage.mjs --fix --confirm-production-migration` 会在重算后完成 `usage-repair-needed` marker，部署不会自动删除或迁移数据。

## 缓存与 CSP

- `/assets/*` 是 Vite hash 或 `elytrue-20260724` 版本目录：`public, max-age=31536000, immutable`。
- `/res/*` 未 hash：`public, max-age=300, must-revalidate`。
- HTML、manifest 和其他未版本化资源：`no-cache`；`/api/*`：`no-store`。
- EdgeOne 配置对所有响应设置 `Strict-Transport-Security: max-age=31536000; includeSubDomains`，暂不使用 preload。
- Edge Runtime 根据最终 `Content-Type` 管理页面头：HTML 使用 `script-src 'self'`、`X-Frame-Options: DENY` 和 Permissions Policy；API JSON 与图片二进制不附加页面 CSP。
- `style-src 'self' 'unsafe-inline'` 暂时保留，因为背景焦点、播放器进度、手势位移、图片缩放、弹窗动画以及 Vue `:style` 仍需运行时样式。移除条件见重构审计。

## 自动化边界

`check:runtime` 同时运行无 Node 类型的 WebWorker/ES2023 middleware 类型检查和导入静态扫描，并阻断 Node 21+ 的 SQLite、`process.getBuiltinModule`、新版 `import.meta` 与文件系统 glob API。`check:server` 使用独立 `tsconfig.server.json` 和 Node 20 类型对生产服务端做 `checkJs`，已启用 `strictNullChecks`、`noUncheckedIndexedAccess`、`alwaysStrict` 等增量严格选项；`test:server` 不加载 Vite、Vue SFC 或 Playwright。`check:build` 扫描最终部署资源，证明服务端、测试、维护脚本、环境文件、source map、EdgeOne CLI 和 Node 专属模块不进入前端 bundle。

## 平台限制

- Blob 单 key 强一致读取与 `onlyIfNew` 可用，但跨 key 业务事务依赖补偿回滚。
- Edge KV 只有读写、没有原子增量/CAS，固定窗口是多节点 best-effort 计数；Cloud Functions 进程内限流只提供单实例第二层保护。可信地址只来自平台上下文，伪造转发 Header 不参与身份。
- `usage/uploads.json` 跨实例增减可能偏差，使用 `npm run audit:uploads` 做物理一致性审计，再按授权使用 `scripts/rebuild-usage.mjs` 只读核对或显式确认修复。
- 真实 Blob 集成测试需要独立非生产项目凭据，默认安全跳过；普通 CI 不访问真实 Blob/KV。
