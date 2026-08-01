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
- `PUBLIC_SITE_URL`：预览阶段填预览域名，正式切流后填 `https://elytrue.com`。
- `ADMIN_BOOTSTRAP_SECRET`：首次管理员初始化的一次性高强度随机值。
- `ALLOWED_ORIGINS`：预览与正式站点允许的来源，逗号分隔。

真实值不得写入仓库、构建日志或前端环境变量。

## 3. 存储

创建或首次访问时使用两个 Pages Blob Store：

- `elytrue-data`：用户、索引、会话、重置令牌、留言、点赞、举报和元数据。
- `elytrue-uploads`：头像和留言图片。

创建 KV 绑定，变量名必须为 `ELYTRUE_RATE_LIMIT_KV`。它只保存短期频率计数；未绑定时本地开发会退化为进程内限流，生产部署必须绑定。

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
