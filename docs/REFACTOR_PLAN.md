# Vue 3 / EdgeOne 现代化重构计划

## 目标

在不改变星花札记现有主题、视觉、动画、DOM 契约和用户功能的前提下，将前端整理为 Vue 3 + TypeScript 模块化应用，将 EdgeOne API 后端拆分为清晰的路由、服务、仓储和存储层，并清理确认不可达的上游遗留内容。

所有工作在本地分支 `refactor/modernize-edgeone` 完成；不推送、不创建 PR、不部署、不访问真实 Blob/KV，也不执行生产数据迁移。

## 三种运行环境

```text
构建与前端工具链：Node 22.17.1
EdgeOne Cloud Functions：平台管理的 Node 20.x
middleware.js：Edge Runtime / Web APIs / ES2023+
```

- `.nvmrc` 是推荐的本地构建版本。
- `package.json#engines.node` 描述开发和构建工具链的兼容范围。
- `edgeone.json#nodeVersion` 只选择 EdgeOne 的构建环境。
- 上述三项都不会把生产 Cloud Functions 切换到 Node 22。
- `server/` 和 `cloud-functions/` 不使用 Node 22 独占 API。
- 根目录 `middleware.js` 不导入 `node:*`，不使用 Buffer、process 或文件系统。

## 实施阶段

1. `chore: add refactor audit and baseline tests`
   - 建立审计、修复 Windows Mock Server 路径问题、固定 E2E 数据并保存桌面/移动视觉基线。
2. `chore: align dependencies with EdgeOne runtime`
   - 对齐 Node 版本、依赖、CI、Lint、格式化和运行时边界检查。
3. `refactor: centralize site content and asset metadata`
   - 集中站点、SEO、背景、作者、原图和音乐配置。
4. `refactor: modularize frontend application`
   - 建立真实 Vue 根组件、类型化 API 客户端和 feature/composable 结构，移除全局暴露及内联事件。
5. `refactor: modularize EdgeOne API backend`
   - 保持 Cloud Function 入口与 API 合同不变，拆分路由、服务、仓储和 key 构造器。
6. `chore: remove unused upstream content and assets`
   - 建立素材清单和自动审计后，只删除能够证明不可达且无依赖的旧内容。
7. `test: add behavior and visual regression coverage`
   - 增加 API、运行时边界、存储合同、历史兼容和视觉回归测试。
8. `docs: document EdgeOne-only architecture and operations`
   - 只保留 EdgeOne Makers 生产部署说明，完善缓存、安全头、审计结果和最终报告。

## 兼容性

所有历史 Blob key、字段名称、字段语义、内部 ID、公开编号、索引、墓碑、图片别名和读写行为必须保持存储结构兼容。现有生产数据必须无需迁移即可继续读取、更新和删除。不得要求重新序列化全部历史数据，也不得依赖 JSON 属性顺序或空白等无意义的字节级一致性。

不得改变 Blob Store 名称、Cookie 名称和属性、CSRF 流程、密码散列格式、邮箱加密格式、API 路径、HTTP 方法、请求字段、响应 envelope、状态码语义、留言内部 ID、公开编号、墓碑、repair marker 或图片 pending/active 语义。

## 验收

最终运行：

```powershell
npm ci
npm run lint
npm run format:check
npm run check
npm run check:server
npm test
npm run test:server
npm run build:edgeone
npm run test:e2e
npm run check:assets
npm audit --omit=dev
npm audit
```

生产审计不得存在未解释的 high/critical。完整审计中的开发工具漏洞按来源、等级、部署可达性、修复状态和接受理由逐项记录；不使用 `npm audit fix --force`，也不通过运行时 `npx` 隐藏依赖。
