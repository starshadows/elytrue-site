# AGENTS.md

星花札记 elytrue.com——EdgeOne Makers 单仓全栈项目:Vue 3 + Vite 前端 + Node.js Cloud Functions 后端,存储全部走 EdgeOne Pages Blob / KV。仓库无开源许可证,素材权利见 NOTICE.md / ASSETS.md。

## 命令

- 安装:`npm ci`(有 lockfile)
- 验证顺序(与 `.github/workflows/ci.yml` 一致):`npm test` → `npm run build:edgeone`
- `npm test`:直接用 `node --test tests/*.test.js`,**无测试框架**。测试注入 `MemoryStore`/`MemoryKV`(server/storage.js、tests/middleware.test.js 有现成实现),不依赖任何 EdgeOne 服务;新测试照抄该注入模式,不要引入 vitest/jest。集成测试在 `tests/integration.test.js`,未设 `EDGEONE_TEST_PROJECT_ID`/`EDGEONE_TEST_TOKEN` 时自动跳过
- `npm run check`:vue-tsc -b 类型检查(tsconfig 开了 `erasableSyntaxOnly`,**禁止 enum/namespace/参数属性**)
- `npm run build:edgeone` = `check:assets` + `build`;`build` 会先跑 `gen:build-info`(生成被 gitignore 的 `server/build-info.js`:BUILD_VERSION=git 短提交、BUILD_TIME=实际构建时间、COMMIT_TIME;无法解析 git 时构建失败;测试/本地无该文件时 health 回落 dev)。`check:assets` 遍历 `public/`,任何单文件 >25MB 构建即失败,添加大素材时注意
- `npm run dev`:仅 Vite 前端,**不模拟** Blob/KV/Cloud Functions,后端接口不可用;模拟需要已连接 EdgeOne 项目的 `npm run dev:edgeone`
- `npm run mock:server` + `npm run test:e2e`:本地 Playwright E2E(先 `npm run build`;mock-server 用 MemoryStore 提供后端,见 scripts/mock-server.mjs)
- `npm run export:data`:需要环境变量 `EDGEONE_PROJECT_ID`、`EDGEONE_API_TOKEN`,输出到被 gitignore 的 `exports/`
- `npm run repair:user-claims`:报告用户 mutation claim;生产修复必须先停写并传 `--fix --confirm-production-repair`,仅删除超过 5 分钟且版本可判定的占位
- 数据脚本(同需上述环境变量,先备份再 --fix):`scripts/check-duplicate-users.mjs`(重复用户名报告/修复,`--fix` 另需 `ELYTRUE_APP_SECRET`)、`scripts/rebuild-comment-views.mjs`(留言 read view/点赞计数/latest 快照核对与修复,**--fix 必须带 --confirm-production-repair**)、`scripts/rebuild-usage.mjs`(按别名重算图片空间统计)

## 架构

- `cloud-functions/api/[[default]].js` → `server/app.js` 的 `handleApiRequest`:全部 `/api/*` 路由是手写路由表(路径去掉 `/api` 前缀后精确匹配)。`server/` 是纯 JS、无构建步骤;`shared/validation.js` 前后端共用
- 存储:`server/storage.js` 的 `createStores` 固定取两个 Blob Store——`elytrue-data`(用户/会话/留言/索引)和 `elytrue-uploads`(头像/留言图);key 约定如 `users/{id}.json`、`uploads/aliases/...`。生产环境只注入,测试注入 `MemoryStore`
- 留言事实为 `comments/{16位内部ID}.json`;公开编号只用 `indexes/comments/number/{n}.json`,硬删除转 tombstone。公开卡片为 `views/comments/public/{invertedId}-{id}.json`,用户摘要为唯一的 `indexes/comments/by-user/{uid}/{invertedId}-{id}.json`,首屏快照为 `views/comments/latest.json`。无旧索引或 canonical 扫描 fallback
- public/bootstrap 首屏优先单读 latest;损坏或缺失时 list 一次 public view 并按并发上限 8 每条 get 一次。用户页同样一次 list+每条一次 get;空隐藏页返回推进后的 `nextCursor`,不在单次请求内无限扫描
- 回复预览采用发布时快照,目标后来隐藏/删除仍保留历史摘要;列表不读取回复目标。点赞事实仍是 `likes/{id}/{uid}.json`,计数直接写 canonical/public/user/latest,普通列表不扫描事实
- 创建的 canonical/编号/图片关键步骤失败会补偿回滚;read view/latest 写失败不丢弃已发布留言,统一写 `repairs/comment-views/{id}.json`。隐藏、恢复、删除和点赞均更新 read model;重建脚本可检测并修复。`X-Idempotency-Key` 可使发布请求安全重试
- 图片别名 status 缺失按 active 处理:`DELETE /api/uploads/image?imageId=` 只允许 pending;自动清理(>24h)会先经用户留言索引核对引用,被引用的 pending 不删
- updateUser 索引事务:先全部预校验+预计算(含 passwordHash)→原子认领新索引→经用户版本认领写本体→删除旧索引前强一致校验归属(他人索引不删,记 `user_old_index_not_owned`);失败只回滚本次认领
- 图片别名带 `status`:`pending`(未关联留言,可被 `DELETE /api/uploads/image?imageId=` 删除或 24h 后自动清理)/`active`;缺省视为 active
- 边缘限流在 `middleware.js`(Edge Function),依赖 KV 绑定 `ELYTRUE_RATE_LIMIT_KV`(策略表 `RATE_LIMIT_POLICIES`);未绑定则退化为 `server/rate-limit.js` 进程内二次限流。新增写端点时两处都要加
- 环境变量只在 EdgeOne 项目设置里(`ELYTRUE_APP_SECRET`、`PUBLIC_SITE_URL`、`ADMIN_BOOTSTRAP_SECRET`、`ALLOWED_ORIGINS`),`.env.example` 仅占位;本地跑测试时自己构造 env(见 tests/api.test.js)
- SPA fallback、缓存、函数地域(ap-shanghai)都在 `edgeone.json`;生产部署由 EdgeOne Makers 自动拉 `main` 分支,运维清单见 `docs/EDGEONE_SETUP.md`
- Cloud Function 是 Node 20、30s 上限;改动服务端代码要兼容
- 账号恢复密钥为 `ELY-` 开头的 28 位无歧义随机字符(约 139 bit),仅注册/恢复/轮换成功响应返回一次;用户记录只保存独立 scrypt 哈希、创建时间和版本。`POST user/recover` 同时轮换密码/密钥并增加 `sessionVersion`;`POST user/recovery-key` 需登录、CSRF 和当前密码。所有用户本体写入共用 `recovery-key-claims/{userId}/{version}.json` 原子版本认领,防止同一旧密钥并发使用或旧会话更新覆盖恢复结果

## 约定

- 认证:HttpOnly cookie + `X-CSRF-Token` 头;`src/net/xhr.ts` 的 `token` 字段只是遗留 UI 信号,不要用作鉴权。CSRF token 从响应 `data.csrfToken` 更新
- 前端登录态:`src/index.ts` 的 `User.loginState`(`loading`/`authenticated`/`unauthenticated`)与 `User.ready()`(单飞 /user/me);需要登录的操作先 `await User.ensureLoggedIn()`,不要在 `loading` 期间直接判定未登录
- 前端 API 基址来自全局 `window.baseUrl`/`window.bgBaseUrl`(global.d.ts),默认 `''`
- 图片上传:头像 ≤1MB、留言图 ≤2MB,base64 包在 JSON 里;Blob 用量达 90% 停止上传(507)。`usage/uploads.json` 在删除/清理时按别名 size 扣减(进程内队列串行化,跨实例仍可能偏差,用 rebuild-usage.mjs 重算)
- `POST /api/admin/bootstrap` 是一次性管理员初始化(带 `X-Admin-Bootstrap-Secret` 头),成功后永久关闭
- 举报:`POST /api/comments/report` 禁止举报自己的留言(403)、重复举报返回 409;UI 上 .btn.report 仅登录且非本人留言显示
- UI 文案、API 消息、错误提示均为中文,新增文案保持一致;`public/assets/` 按版本目录存放(如 `elytrue-20260724`),有命名先例
