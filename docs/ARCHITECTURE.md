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
- 单一倒序用户索引、公开 read view、latest 快照、`onlyIfNew` 编号占位和 repair marker。
- 图片 alias 的 pending/active 生命周期和补偿回滚。

站点在上线前切换到此 schema，不保留旧留言索引、旧 like cache 或 canonical 全量扫描兼容分支。

### 账号恢复

- 新用户记录增加 `recoveryKeyHash`、`recoveryKeyCreatedAt` 和 `recoveryKeyVersion`；恢复密钥原文只在注册成功响应中返回一次，不进入个人资料、日志、URL、Cookie 或浏览器持久存储。
- 密钥包含 28 个无歧义随机字符，约 139 bit 熵；`server/crypto.js` 通过独立的 `generateRecoveryKey`、`hashRecoveryKey` 和 `verifyRecoveryKey` 语义封装使用 scrypt 与安全比较。
- `POST /api/user/recover` 接收 `identifier`、`recoveryKey`、`password`，成功后更新密码、增加 `sessionVersion`、废止旧密钥并返回一次新密钥，不创建登录会话。账号不存在、缺少密钥和密钥错误使用同一错误。
- `POST /api/user/recovery-key` 需要会话、CSRF 和当前密码，用于已有用户首次生成或重新生成密钥。`recovery-key-claims/{userId}/{version}.json` 通过 `onlyIfNew` 认领当前用户记录版本；恢复、密钥轮换、资料更新、全设备注销和管理员初始化共用该写入栅栏，防止旧会话的并发写入覆盖已轮换的密码、密钥或 `sessionVersion`。
- 边缘层按 IP、Cloud Functions 层按 IP 与账号标识摘要限流；限流 key 不含恢复密钥或完整邮箱。
- 没有恢复字段的历史用户仍可登录和使用，不会在启动时自动补写。邮件重置代码已删除；历史 `password-resets/*` 数据保持惰性，不自动迁移或删除。

新举报直接保存 `commentNumber`；硬删除前会补齐该留言已有举报的编号，因此删除后不需要扫描编号 seat 或反向索引。

### 留言读取

- `comments/{id}.json` 是完整事实；`indexes/comments/number/{n}.json` 是唯一公开编号映射。`views/comments/public/{invertedId}-{id}.json` 保存可直接渲染的完整卡片，隐藏时移入 `views/comments/hidden/`、恢复时移回；普通分页一次 list 后每条最多一次 get，并发上限为 8，管理员列表会额外合并隐藏视图。
- `views/comments/latest.json` 保存最新 12 条公开卡片、`nextCursor`、`todayCount`、上海日期、`generatedAt` 和版本。`GET /comments/public` 与 bootstrap 首屏正常命中只读取此 Blob；日期过期、缺失或损坏时回退 public view，不把快照当事实来源。写入通过 Blob `onlyIfNew` 锁跨实例串行，mutation 开始时先删除旧快照，失败时保持 fallback 而不是继续提供已知过期内容。
- `indexes/comments/by-user/{uid}/{invertedId}-{id}.json` 是唯一用户留言索引，值本身是主页摘要。每页一次 list、每条一次 get；全隐藏页仍返回可推进 cursor，不在单请求内反复扫空页。
- `likes/{id}/{uid}.json` 保持幂等事实，展示计数直接写 canonical/public/user/latest。普通列表不读取或 list 点赞事实；登录态通过 `/comments/viewer-likes` 以并发上限 8 批量读取。
- `replyPreview` 在回复发布时固化；目标后来隐藏或删除仍显示发布当时摘要。这一历史快照语义避免首页 N 次回复回源。
- 点赞、隐藏、恢复和删除先通过 `operations/comment-mutations/{id}/{version}.json` 原子认领 canonical 下一版本，认领覆盖到 read view 更新完成，避免并发点赞用旧本体撤销隐藏或复活删除。read view/latest 写失败写 `repairs/comment-views/{id}.json`，不撤销已完成的 canonical 发布。`npm run rebuild:comment-views` 默认只读，显式 `--fix --confirm-production-repair` 才按 canonical 与点赞事实修复。留言路由输出 `readView`、`latestView`、`commentBodies`、`likes` 等可读 `Server-Timing` 分类。

#### 改造前读取基线

2026-08-05 使用带 `get/list` 计数与并发峰值记录的 `MemoryStore` 对旧实现实测：

| 请求 | 旧 Blob 读取 | 主要来源 |
| --- | ---: | --- |
| 公共首页 10 条 | 31 get | 1 hint + 10 seat + 10 canonical + 10 like cache |
| 公共首页 12 条 | 37 get | 1 hint + 12 seat + 12 canonical + 12 like cache |
| 匿名 bootstrap 12 条 | 37 get + 1 list | 上述 37 次 + 当日日期索引 list |
| 用户首页 20 条 | 20 get + 1 list | v2 list + 20 canonical |
| 12 条回复共享一个目标 | 38 get | 首页 37 次 + 1 reply canonical |
| 登录用户 12 条 liked 状态 | 12 get | 每条一个 like fact，受并发上限 8 约束 |

自动化预算测试现在要求 latest 命中不超过 2 次数据读取；fallback 和用户页均为一次 list 加最多 `count` 次并发 get；普通首页不得读取 `likes/` 或回复 canonical。

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

### 素材与构建预算

`config/repository-budgets.json` 是仓库静态素材和正式构建产物的唯一预算来源。`npm run check:assets` 在引用、重复内容和 EdgeOne 单文件限制之外，按背景预览、背景原图、普通图片、音频、字体、`public/assets` 总量和 `public/res` 总量执行警戒/失败阈值；未知二进制和超过 512 KiB 的未版本化文件产生可定位警告。`npm run report:assets` 额外输出每个 `public/assets`、`public/res` 文件的类型、大小、类别、版本状态、首屏属性、延迟能力和外部迁移候选状态。

`npm run check:build-budget` 在正式 Vite 构建后检查单个/总 JS、单个/总 CSS、首屏传输上界、最大图片/音频/字体和 `dist` 总量，并同时阻断 source map、服务端、测试、维护脚本、密钥文件进入产物。JS/CSS 同时报告原始和 gzip 大小。首屏传输上界按 HTML 原始大小、入口 JS/CSS gzip、站点字体和“随机首张背景中最大预览”计算；原图下载和音乐不计入首屏。

GitHub Actions 的 `verify` 通过 `build:edgeone` 使用同一套素材/构建预算，`e2e` 仍在 Windows Chromium 视觉基线环境构建同一产物，`server-node20` 继续独立验证 Cloud Functions。PR 运行可取消同一 PR 的旧任务，`main` 推送任务不会被自动取消。

大型原图和音乐是未来外部静态存储候选，但当前没有可验证的非敏感素材域名或 EdgeOne 外部存储凭据，GitHub checkout/EdgeOne Makers 也未确认会拉取 LFS 对象，因此没有迁移、删除或转换现有文件。仓库不执行历史重写；未来迁移必须先验证开发、CI、EdgeOne 构建和生产 CSP 的完整链路。

发布流程见 [发布清单](RELEASE.md)，应用或部署异常见 [回滚清单](ROLLBACK.md)。

## 平台限制

- Blob 单 key 强一致读取与 `onlyIfNew` 可用，但跨 key 业务事务依赖补偿回滚。
- Edge KV 只有读写、没有原子增量/CAS，固定窗口是多节点 best-effort 计数；Cloud Functions 进程内限流只提供单实例第二层保护。可信地址只来自平台上下文，伪造转发 Header 不参与身份。
- `usage/uploads.json` 跨实例增减可能偏差，使用 `npm run audit:uploads` 做物理一致性审计，再按授权使用 `scripts/rebuild-usage.mjs` 只读核对或显式确认修复。
- 真实 Blob 集成测试需要独立非生产项目凭据，默认安全跳过；普通 CI 不访问真实 Blob/KV。
