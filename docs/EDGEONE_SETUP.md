# EdgeOne Makers 配置清单

## 1. 免费项目与构建

1. 在腾讯云中国站 EdgeOne Makers 创建免费项目。
2. 连接公开仓库 `starshadows/elytrue-site`，生产分支选择 `main`。
3. 构建命令使用 `npm run build:edgeone`，输出目录为 `dist`。
4. 不开通 COS、腾讯云邮件推送、付费增值套件或后付费资源。
5. 在费用中心设置低额预算预警；免费额度耗尽时暂停对应功能。

`edgeone.json` 已将 Node.js Cloud Functions 地域固定为上海 `ap-shanghai`。

## 2. 环境变量

仅在 EdgeOne 项目设置中保存：

- `ELYTRUE_APP_SECRET`：至少 32 个随机字符，用于邮箱加密和索引摘要。
- `RESEND_API_KEY`：Resend API Key。
- `RESEND_FROM_EMAIL`：重置邮件发件地址（默认 `noreply@mail.elytrue.com`，需在 Resend 验证该域）。
- `RESEND_FROM_NAME`：重置邮件发件人名称（默认 `星花札记`）。
- `PUBLIC_SITE_URL`：预览阶段填预览域名，正式切流后填 `https://elytrue.com`。密码重置链接以此为准生成。
- `ADMIN_BOOTSTRAP_SECRET`：首次管理员初始化的一次性高强度随机值。
- `ALLOWED_ORIGINS`：预览与正式站点允许的来源，逗号分隔。

真实值不得写入仓库、构建日志或前端环境变量。

## 3. 存储

创建或首次访问时使用两个 Pages Blob Store：

- `elytrue-data`：用户、索引、会话、重置令牌、留言、点赞、举报和元数据。
- `elytrue-uploads`：头像和留言图片。

创建 KV 绑定，变量名必须为 `ELYTRUE_RATE_LIMIT_KV`。KV 目前只支持 Edge Functions，因此短期频率计数由根目录 `middleware.js` 在边缘节点执行；Node.js Cloud Functions 仍保留进程内二次限流。未绑定时本地开发会退化为后端进程内限流，生产部署必须绑定。

上传累计值达到参考免费额度 80% 时后台会记录警告；达到 90% 时停止新图片上传，文字留言和读取仍继续。管理员可通过 `GET /api/admin/usage` 检查记录值，并结合 EdgeOne 控制台核对实际用量。

## 4. Resend

1. 在 Resend 验证 `mail.elytrue.com`。
2. 按 Resend 提供的记录配置 SPF、DKIM，并为该子域配置 DMARC。
3. 发件人固定为 `星花札记 <noreply@mail.elytrue.com>`。
4. 免费额度达到上限后找回密码邮件暂停，不切换到付费渠道。

注册不发送验证邮件；用户名、邮箱和密码提交后账号立即激活。

## 5. 初始化管理员

1. 只在预览部署注册站长账号并登录。
2. 携带当前 CSRF 头和 `X-Admin-Bootstrap-Secret` 请求 `POST /api/admin/bootstrap`。
3. 成功后后端写入永久关闭标记，初始化入口无法再次使用。
4. 随后从 EdgeOne 环境变量中删除 `ADMIN_BOOTSTRAP_SECRET`。

## 6. 域名与切流

- 腾讯云接入备案通过前，继续由当前阿里云 ECS 提供 `elytrue.com` 公网服务。
- 审核期间仅使用 EdgeOne 预览域名验收，不提前切换正式 DNS。
- 通过后绑定 `elytrue.com`，将 `www.elytrue.com`、`blog.elytrue.com` 301 到主域名。
- `mail.elytrue.com` 只用于 Resend 发信认证。
- 页面底部中央保留 `赣ICP备2026015414号-1` 链接。
- 切流后保留 ECS 14 天；关键检查失败时恢复旧 DNS。
- 若公安备案记录的是旧 ECS IP 或阿里云接入信息，按平台要求办理变更。

## 7. 手动备份

在本地临时设置只读所需的 EdgeOne 项目 ID 与 API Token 后运行：

```powershell
npm run export:data
```

导出文件写入被 Git 忽略的 `exports/`。任务结束后立即清除本地环境变量和不再使用的 Token。

## 8. 数据迁移脚本

以下脚本需要临时设置 `EDGEONE_PROJECT_ID`、`EDGEONE_API_TOKEN`（参考 export:data），运行前建议先 `npm run export:data` 备份。

### 8.1 重复用户名检查与修复

```bash
node scripts/check-duplicate-users.mjs          # 报告模式:扫描并输出重复组,不修改数据
node scripts/check-duplicate-users.mjs --fix    # 修复:保留最早账号,其余改名 原名_2/_3
```

修复只改 `users/{id}.json` 的 `name` 与用户名索引，不触碰邮箱、留言、头像与会话。修复前打印计划、修复后自动校验。退出码 1 表示仍存在重复或环境变量缺失。

### 8.2 留言编号/日期/用户索引迁移

稳定公开编号（`indexes/comments/number/`）、自然日计数（`dates/`）与用户留言索引（`indexes/comments/by-user/`）需要为旧留言回填：

```bash
node scripts/rebuild-comment-indexes.mjs          # 报告:统计缺口
node scripts/rebuild-comment-indexes.mjs --fix    # 按 createdAt 为旧留言分配编号并回填索引
```

幂等可重跑。回滚：删除上述三个前缀的 key 即可，`comments/` 本体不变。

## 9. 部署版本确认与邮件日志

- `GET /api/health` 返回 `version`（构建时注入的 git 短提交）与 `buildTime`，用于确认 EdgeOne 实际部署的提交。
- 密码重置邮件结果以结构化日志输出到 Cloud Functions 日志：`{"event":"password_reset_email","success":false,"userId":"...","provider":"resend","status":403,"error":"domain is not verified"}`。发送成功时含 `emailId`。日志不包含重置 token、密码或完整 API Key。邮件未收到时按此排查：`RESEND_API_KEY` 是否配置、发件域是否在 Resend 验证（SPF/DKIM）、是否触发限流或退信。
- 上传的临时图片（超过 24 小时未被留言引用）会在下次上传时自动清理，事件为 `pending_image_cleanup`。

## 10. 集成测试（可选）

连接真实 EdgeOne Blob 验证 `onlyIfNew`、强一致读取与并发行为（默认跳过）：

```bash
EDGEONE_TEST_PROJECT_ID=<测试项目ID> EDGEONE_TEST_TOKEN=<API Token> node --test tests/integration.test.js
```

使用独立 `integration-test/` 前缀并自动清理，不访问生产数据；可用 `EDGEONE_TEST_STORE` 覆盖目标 Store（默认 `elytrue-data`）。
