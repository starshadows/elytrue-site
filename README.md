# 星花札记 · elytrue.com

以爱莉希雅为主题的非商业个人同人网站，保留上游站点的全屏背景、主题、音乐与留言交互，并迁移为 EdgeOne Makers 单仓库全栈项目。

## 来源关系

本仓库是 [haojiezhe12345/haojiezhe12345.github.io](https://github.com/haojiezhe12345/haojiezhe12345.github.io) 的正式 Fork，保留上游提交历史和 GitHub Fork 关系。上游后端 [haojiezhe12345/MadoHomuAPI](https://github.com/haojiezhe12345/MadoHomuAPI) 仅作为本地迁移参考，未部署至 EdgeOne。

## 目录

- `src/`、`index.html`：Vue/Vite 前端
- `cloud-functions/`：EdgeOne Node.js 20 Cloud Functions 入口
- `server/`：账号、会话、邮件、留言、图片与管理逻辑
- `shared/`：前后端可复用的校验规则
- `middleware.js`：`www`、`blog` 域名跳转
- `edgeone.json`：构建、上海函数地域、缓存与 SPA fallback
- `public/assets/`：公开的 WebP、原图和官方音乐
- `scripts/export-edgeone-data.mjs`：站长手动导出 Blob 数据

## 本地验证

```powershell
npm ci
npm test
npm run build:edgeone
```

连接 EdgeOne 项目后，可使用：

```powershell
npm run dev:edgeone
```

本地仅调试前端时仍可运行 `npm run dev`；该模式不会模拟 EdgeOne Blob、KV 与 Cloud Functions。

## 部署

EdgeOne Makers 连接公开仓库的 `main` 分支。环境变量、KV 绑定、Blob 存储和首次管理员初始化步骤见 [docs/EDGEONE_SETUP.md](docs/EDGEONE_SETUP.md)。

正式域名仍为 `elytrue.com`。腾讯云接入备案通过前不切换生产 DNS，现有 ECS 继续提供公网服务。

## 权利与使用说明

仓库公开用于项目展示、学习和协作查看。仓库未附带开源许可证，也未主动授予复制、修改或再分发代码及素材的许可。

素材来源与画师致谢见 [ASSETS.md](ASSETS.md)，完整权利说明见 [NOTICE.md](NOTICE.md)。角色、作品、图片与音乐权利归各自原作者或官方权利人所有。
