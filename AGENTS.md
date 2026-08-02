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
- 数据脚本(同需上述环境变量,先备份再 --fix):`scripts/check-duplicate-users.mjs`(重复用户名报告/修复)、`scripts/rebuild-comment-indexes.mjs`(留言编号/日期/用户索引迁移,**--fix 必须带 --confirm-production-migration**,新旧混合默认中止,回滚需恢复完整备份)、`scripts/rebuild-usage.mjs`(按别名重算图片空间统计)

## 架构

- `cloud-functions/api/[[default]].js` → `server/app.js` 的 `handleApiRequest`:全部 `/api/*` 路由是手写路由表(路径去掉 `/api` 前缀后精确匹配)。`server/` 是纯 JS、无构建步骤;`shared/validation.js` 前后端共用
- 存储:`server/storage.js` 的 `createStores` 固定取两个 Blob Store——`elytrue-data`(用户/会话/留言/索引)和 `elytrue-uploads`(头像/留言图);key 约定如 `users/{id}.json`、`uploads/aliases/...`。生产环境只注入,测试注入 `MemoryStore`
- 留言数据(server/comments.js):评论本体 `comments/{16位内部ID}.json`(内部 ID 保持稳定,点赞/回复/图片引用它);**稳定公开编号** `indexes/comments/number/{n}.json`(onlyIfNew 原子占位,允许空洞,占位带 reservationId 供回滚识别;硬删除时转为 `tombstone:true` 空号,跳转 404、不复用、迁移校验豁免);自然日计数 `dates/{YYYY-MM-DD}/{id}.json`(Asia/Shanghai,`comments/count` 用;删除留言不删此索引,口径为「当天曾发布」);用户留言索引 `indexes/comments/by-user/{uid}/{id}.json`(个人页游标分页 `cursor`+`hasMore`,硬删除时同步删除)。`number` 查询参数按公开编号跳转,`from` 仍是内部 ID 语义(精确命中时是居中窗口)。旧数据无 `number` 字段时回落 id 顺序展示编号,迁移脚本可回填
- 分页按**可见留言数量**收集(越过隐藏留言直到凑够 count 或窗口结束):主列表保持数组返回,用户列表返回 `{items, hasMore}`;`time` 参数为 Unix 秒,内部 ID 上界换算为 `time*1e6+1000`
- createComment 一致性:正文→编号占位→(回写 number+用户索引+日期索引)→图片 pending→active,任一失败回滚本次已写资源(仅删自己 reservationId 的占位;已激活图片还原为 pending)并记结构化日志(`comment_*` 事件),不返回 201;编号占位不得指向不存在的留言
- 图片别名 status 缺失按 active 处理:`DELETE /api/uploads/image?imageId=` 只允许 pending;自动清理(>24h)会先经用户留言索引核对引用,被引用的 pending 不删
- updateUser 索引事务:先原子认领全部新索引→写用户本体→成功后删旧索引;失败只回滚本次认领;旧索引删除失败记 `user_old_index_delete_failed` 日志
- 图片别名带 `status`:`pending`(未关联留言,可被 `DELETE /api/uploads/image?imageId=` 删除或 24h 后自动清理)/`active`;缺省视为 active
- 边缘限流在 `middleware.js`(Edge Function),依赖 KV 绑定 `ELYTRUE_RATE_LIMIT_KV`(策略表 `RATE_LIMIT_POLICIES`);未绑定则退化为 `server/rate-limit.js` 进程内二次限流。新增写端点时两处都要加
- 环境变量只在 EdgeOne 项目设置里(`ELYTRUE_APP_SECRET`、`RESEND_API_KEY`、`RESEND_FROM_EMAIL`、`RESEND_FROM_NAME`、`PUBLIC_SITE_URL`、`ADMIN_BOOTSTRAP_SECRET`、`ALLOWED_ORIGINS`),`.env.example` 仅占位;本地跑测试时自己构造 env(见 tests/api.test.js)
- SPA fallback、缓存、函数地域(ap-shanghai)都在 `edgeone.json`;生产部署由 EdgeOne Makers 自动拉 `main` 分支,运维清单见 `docs/EDGEONE_SETUP.md`
- Cloud Function 是 Node 20、30s 上限;改动服务端代码要兼容
- 密码重置邮件(server/email.js)不抛异常,返回结构化结果 `{ok, emailId?, status?, error?}`,由 `requestPasswordReset` 记结构化日志(事件 `password_reset_email`,不落 token/密码/完整 key)。重置 token 认领用 `password-resets/{hash}.json.claimed` onlyIfNew 原子标记,并发只能一个成功

## 约定

- 认证:HttpOnly cookie + `X-CSRF-Token` 头;`src/net/xhr.ts` 的 `token` 字段只是遗留 UI 信号,不要用作鉴权。CSRF token 从响应 `data.csrfToken` 更新
- 前端登录态:`src/index.ts` 的 `User.loginState`(`loading`/`authenticated`/`unauthenticated`)与 `User.ready()`(单飞 /user/me);需要登录的操作先 `await User.ensureLoggedIn()`,不要在 `loading` 期间直接判定未登录
- 前端 API 基址来自全局 `window.baseUrl`/`window.bgBaseUrl`(global.d.ts),默认 `''`
- 图片上传:头像 ≤1MB、留言图 ≤2MB,base64 包在 JSON 里;Blob 用量达 90% 停止上传(507)。`usage/uploads.json` 在删除/清理时按别名 size 扣减(进程内队列串行化,跨实例仍可能偏差,用 rebuild-usage.mjs 重算)
- `POST /api/admin/bootstrap` 是一次性管理员初始化(带 `X-Admin-Bootstrap-Secret` 头),成功后永久关闭
- 举报:`POST /api/comments/report` 禁止举报自己的留言(403)、重复举报返回 409;UI 上 .btn.report 仅登录且非本人留言显示
- UI 文案、API 消息、错误提示均为中文,新增文案保持一致;`public/assets/` 按版本目录存放(如 `elytrue-20260724`),有命名先例
