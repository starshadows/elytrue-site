# 素材清单与可达性审计

审计日期：2026-08-05。范围为 `public/`、前端静态引用、运行时生成路径和历史直接访问入口。本清单只描述仓库状态，不改变 `ASSETS.md` 与 `NOTICE.md` 中的权利归属。

## 保留的部署素材

| 目录或文件                                     | 数量 |              大小 | 运行时引用                                     | 来源与权利                                    | 保留原因                               |
| ---------------------------------------------- | ---: | ----------------: | ---------------------------------------------- | --------------------------------------------- | -------------------------------------- |
| `public/assets/elytrue-20260724/bg/` 横屏 WebP |    7 | 合计计入 3.23 MiB | `src/config/assets.ts`、首页桌面背景、下载弹窗 | 官方美术及已标注 Pixiv 画师，详见 `ASSETS.md` | 当前桌面视觉必需                       |
| 同目录竖屏 WebP                                |    9 | 合计计入 3.23 MiB | 同一配置、首页移动背景、下载弹窗               | 同上                                          | 当前移动视觉与背景焦点必需             |
| `public/assets/elytrue-20260724/originals/`    |   16 |         63.60 MiB | 配置中的原图下载映射                           | 与对应 WebP 一一对应，保留原作者/官方权利     | 用户“下载背景原图”功能必需             |
| `public/assets/elytrue-20260724/bgm/`          |   10 |         17.43 MiB | `OFFICIAL_MUSIC` 播放列表                      | HOYO-MiX/官方曲目，详见 `ASSETS.md`           | 主题音乐和恢复播放功能必需；无重复音频 |
| `public/res/`                                  |   16 |          0.26 MiB | favicon、字体、默认头像、播放器、弹窗与工具栏  | 站点 UI 或上游素材，权利说明见 `NOTICE.md`    | 全部有静态或声明式运行时引用           |
| `public/social-share.jpg`                      |    1 |         0.199 MiB | Open Graph/Twitter 元数据                      | 由已记录站点素材生成                          | 分享预览必需                           |
| `public/index.manifest.json`                   |    1 |        <0.001 MiB | HTML manifest link / PWA                       | 站点配置生成                                  | PWA 必需                               |

当前 `public/` 合计 60 个文件、84.71 MiB。最大单文件为 `originals/portrait3.png`（10.56 MiB），低于 EdgeOne Makers 25 MiB 限制。

`public/assets` 本身为 42 个文件、84.25 MiB：16 张背景预览 3.23 MiB、16 张背景原图 63.60 MiB、10 个音频 17.43 MiB。`public/res` 为 16 个文件、0.26 MiB，其中字体 12.6 KiB，其余为图标和普通图片。逐文件报告通过 `npm run report:assets` 生成，字段包括路径、扩展类型、大小、类别、版本号/hash、首屏属性、是否可延迟和是否为外部迁移候选。

## 首屏与延迟加载

- `bg/*.webp` 中任一横屏或竖屏预览都可能经随机顺序成为首张背景，因此统一视为潜在首屏资源；浏览器只高优先级预加载当前布局的第一张，其余背景按轮播准备。
- `res/AaWoyoudianfangLite.ttf` 和 favicon 属于首屏外壳资源。
- `originals/*` 只在用户请求原图下载时访问，全部可延迟。
- 音频由播放器按播放状态加载，不计入首屏关键传输，全部适合延迟和未来外部托管。
- UI 图标、默认头像和主题缩略图较小，保留同源，不作为迁移优先项。

## 可执行预算

预算唯一来源为 `config/repository-budgets.json`，单位为字节。阈值以 2026-08-05 生产基线加有限增长余量制定：

| 项目                 | 当前最大/总量 |    警戒值 |     失败值 |
| -------------------- | ------------: | --------: | ---------: |
| 普通图片             |      0.20 MiB |  0.50 MiB |   1.00 MiB |
| 背景预览             |      0.32 MiB |  0.50 MiB |   0.75 MiB |
| 背景原图             |     10.56 MiB | 11.00 MiB |  12.00 MiB |
| 单个音频             |      3.14 MiB |  3.50 MiB |   4.00 MiB |
| 单个字体             |      0.01 MiB | 0.125 MiB |   0.25 MiB |
| `public/assets` 总量 |     84.25 MiB | 90.00 MiB |  96.00 MiB |
| `public/res` 总量    |      0.26 MiB |  0.50 MiB |   1.00 MiB |
| `public` 总量        |     84.71 MiB | 95.00 MiB | 102.00 MiB |

未知二进制文件和大于等于 512 KiB 的未版本化静态文件会产生警告；任何文件超过类别失败值或 EdgeOne 25 MiB 硬限制都会使 CI 失败，并输出路径、实际值和限制。审计只读取仓库文件，不访问用户 Blob，也不需要 EdgeOne 凭据。

## 已删除内容

| 文件或内容                                                                           | 删除依据                                                                                                   | 对当前行为的影响                                                    |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `vercel.json`                                                                        | EdgeOne-only 部署后不可达且不被构建读取                                                                    | 无；EdgeOne 配置位于 `edgeone.json`                                 |
| `scripts/transform_dist_api_endpoint.js`                                             | 旧外部 API/base URL 构建后替换流程；同源 `/api/*` 已成为唯一客户端合同                                     | 无；不再允许构建产物二次改写                                        |
| `public/index.hlsvideo.html`                                                         | 只服务已关闭、素材缺失的 Walpurgis HLS 主题                                                                | 无；主题选择器仅暴露自动/爱莉希雅                                   |
| birthday、Christmas、Lunar New Year、Qixi、Night、kami、Walpurgis 背景/文案/脚本/CSS | 不在主题表，素材缺失或依赖旧外部服务，主 UI 无入口                                                         | 删除前后当前默认主题、背景顺序/焦点、动画参数不变                   |
| 隐藏 `game1` / `game2` DOM、CSS 与缺失的 `xh_mdk`/Mello 路径                         | 入口硬编码 `display:none`，素材不存在，E2E 不依赖                                                          | 消除 Vite 未解析素材警告，不影响可见功能                            |
| 旧 kami 留言合并与用户弹窗                                                           | `Settings.showKami` 永远为 false，当前 API/Blob 不提供独立 kami 数据源；真实用户主页由 Vue `UserHome` 提供 | 当前留言、分页、跳转和用户主页继续走同源 API                        |
| 旧外部服务器全屏代理入口及其 4 个文件                                                | 依赖站外主机，含旧 canonical/alternate、iframe 和全屏脚本；不属于当前站点功能                              | 已彻底删除；旧路径交给现有 SPA fallback，不影响 `/api/*` 与静态资源 |

未删除任何当前 7+9 张 WebP、16 张原图、10 首音乐、在用图标/字体、分享图或权利声明。

## 自动化审计

`npm run check:assets` 执行 `scripts/audit-assets.mjs`，检查：

- HTML/Vue/TS/JS/SCSS/manifest 中静态路径是否存在且大小写一致；
- `src/config/assets.ts` 动态生成的 16 组预览/原图和 10 首音乐是否完整；
- 未经审查的动态路径和 `public/` 孤立文件；
- EdgeOne 单文件 25 MiB 限制；
- SHA-256 重复文件以及重复音乐内容；
- 生产源码和构建产物不得重新出现已删除代理路径或旧外部服务器域名。
- 分类单文件预算、`public/assets`/`public/res` 总预算、未知二进制和未版本化大文件。

允许项只有配置构造的背景/音乐路径和当前运行时图片 URL。新增素材必须先进入类型化配置与权利清单，不能仅通过字符串拼接绕过审计。

## 外部托管与 Git LFS 决定

优先迁移候选为 63.60 MiB 背景原图和 17.43 MiB 音频。当前仓库没有可验证的外部静态素材域名、访问凭据或类型化素材基址；EdgeOne Makers 对 Git LFS 对象的拉取能力也未在本项目验证，GitHub Actions checkout 当前没有启用 `lfs: true`。因此本阶段未删除或移动素材、未启用 Git LFS、未修改 CSP，也没有重写 Git 历史。

未来迁移必须先准备非敏感且长期稳定的 HTTPS 素材域名，验证本地 fallback、GitHub CI、EdgeOne Makers 构建、桌面/移动背景、原图下载、音乐 Range 请求和精确 CSP 来源，再逐批迁移不可变版本目录。迁移前后都要运行素材报告、正式构建、Playwright 和线上 404/缓存检查；不得让 Git 仓库只保留生产无法解析的 LFS pointer。

发布和回滚检查分别见 [发布清单](RELEASE.md) 与 [回滚清单](ROLLBACK.md)。
