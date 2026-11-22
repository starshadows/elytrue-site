# 星花札记 · elytrue.com

以爱莉希雅为主题的非商业个人同人展示网站。站点使用 Vue 3、Vite 与 EdgeOne Pages，提供背景轮播、音乐播放、视频主题、显示设置和素材致谢。

## 当前运行模式

生产站点为纯展示模式：

- 不提供注册、登录、个人主页、留言、回复、点赞、举报、上传或管理功能。
- 主题、音乐、背景原图下载与显示设置统一从左上角主题条进入。
- 浏览器启动过程不请求任何业务 API。
- Cloud Function 路由表只保留 `GET /api/` 与 `GET /api/health` 健康检查；其余路径统一返回 `404`。
- 工信部与公安备案信息由独立固定底栏展示，不依赖任何交互模块。

## 运行环境与目录

- 本地构建和 CI 使用 `.nvmrc` 指定的 Node 22.17.1；`package.json#engines` 是工具链支持范围。
- `src/app/`、`src/components/`、`src/features/` 是 Vue 展示应用、组件和媒体控制器。
- `src/config/` 管理站点元数据与素材清单。
- `public/assets/` 保存版本化背景、原图、音乐和 HLS 视频，`public/res/` 保存小型 UI、字体与备案资源。
- `cloud-functions/api/[[default]].js` 与 `server/` 提供最小健康检查接口。
- `middleware.js` 负责规范域名跳转与安全响应头。

## 本地开发与验证

```powershell
npm ci
npm run dev
```

完整发布前验证：

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

构建后可用本地静态服务器验证展示页和 `/api/health`：

```powershell
npm run mock:server
```

## EdgeOne 部署

EdgeOne Makers 连接 `starshadows/elytrue-site` 的 `main` 分支，执行 `npm ci` 和 `npm run build:edgeone` 后输出 `dist`。Cloud Function 地域为 `ap-shanghai`，最长执行 30 秒。

展示站不需要账号密钥、Session、CSRF、Blob Store 或限流 KV 绑定。部署后检查：

- `/api/health` 返回 `mode: "display-only"`。
- 首页不发起 `/api/user/*`、`/api/comments/*`、`/api/uploads/*` 或 `/api/admin/*` 请求，且这些路径均返回 `404`。
- 桌面和移动端底部始终显示 `赣ICP备2026015414号` 与 `赣公网安备36073502000226号`。
- 左上角主题条中的主题、音乐、背景下载与显示设置可用。

## 素材与权利

仓库没有开源许可证；公开可见不代表授予复制、修改、商用或再分发代码、文字和素材的许可。角色、作品名称、官方美术及 HOYO-MiX 音乐权利归官方权利人，二创图片权利归各画师：

- `landscape1`、`landscape2`：官方美术。
- `landscape3`、`landscape4`、`portrait4`、`portrait5`：合悟昂，Pixiv 56022318，按作者主页转载要求标注。
- `landscape5` 至 `landscape7`、`portrait6` 至 `portrait9`：喵咕君QAQ(KH3)，Pixiv 58434088，经许可转载。
- `portrait1`、`portrait2`：nami，Pixiv 89748593，经许可转载。
- `portrait3`：roena，Pixiv 35132995，经许可转载。

页面图片保存界面展示作者、来源链接和原图入口。新增或替换素材必须更新 `src/config/background-manifest.ts` / `src/config/assets.ts`、页面致谢与本节，并通过 `npm run report:assets`；任何单文件不得超过 EdgeOne 25 MiB 限制。
