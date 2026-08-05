# 贡献说明

本仓库公开用于项目展示、问题跟踪和协作查看，但没有开源许可证。公开可见不代表任何人自动获得复制、修改或再分发仓库代码、文字或素材的许可。

## Issue 与 Pull Request

- 接受可复现缺陷、安全边界问题、文档错误和明确的小范围改进 Issue。请避免在 Issue 中提交账号、Cookie、Token、生产日志原文或用户数据。
- 接受事先讨论并获得维护者确认的 Pull Request。较大功能、依赖升级、数据结构变更、视觉改版和素材替换必须先开 Issue 说明必要性、兼容风险和验证方式。
- 提交贡献即声明你有权提交相关代码，并授予仓库维护者在本项目中使用、修改和分发该贡献所需的非独占许可。该授权只覆盖贡献者自行提交的内容，不改变仓库其他内容的权利状态。
- 第三方角色、图片、音乐、字体和品牌素材不能随代码贡献随意替换、复制或再分发。不得提交来源不明、授权范围不清或缺少作者标注的素材。
- 不得提交用户数据、生产 Blob 导出、EdgeOne 项目标识、API Token、应用密钥、管理员 Secret、Cookie、`.env` 或其他秘密信息。

## 本地环境

构建与前端工具链使用 [`.nvmrc`](.nvmrc) 指定的 Node 22.17.1：

```powershell
npm ci
npm run dev
```

`npm run dev` 不模拟 EdgeOne Blob、KV 或 Cloud Functions。同源本地 API 使用构建后的内存 Mock：

```powershell
npm run build:edgeone
npm run mock:server
```

生产服务端以 Node 20 Cloud Functions 为边界，`middleware.js` 则运行在 Edge Runtime。服务端不得使用 Node 21+ API；Edge middleware 不得导入 `node:*`、使用 `Buffer`、`process` 或文件系统。

## 提交前验证

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

使用仓库 Prettier 和 ESLint 配置，不进行无关格式化。新增或替换素材必须同时更新 `ASSETS.md` 或 `NOTICE.md`、类型化素材配置和素材清单，并通过 `npm run report:assets` 检查分类与预算。

## 兼容性要求

- 不得无迁移方案地改变 API 路径、方法、状态码、JSON envelope、Session Cookie 或 CSRF 流程。
- 不得复用或重排历史 Blob key、留言内部 ID、公开编号、墓碑和 repair marker。
- 所有生产数据修复脚本默认只读；写入必须先备份、停写并使用脚本要求的显式生产确认参数。
- 视觉改动必须同时验证桌面和移动视口。只有有意且经过评审的视觉变化才能更新 Playwright PNG 基线，不能用更新基线掩盖回归。
- 不引入来源不明的 GitHub Action，不在 CI 中使用生产 Blob/KV 凭据，也不让无凭据任务执行生产修复。

提交信息建议使用 `type: concise description`，例如 `fix: preserve comment pagination cursor`、`feat: add recovery key rotation` 或 `chore: enforce asset budgets`。
