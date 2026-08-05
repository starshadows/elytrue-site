# 素材来源与处理记录

本站公开保存轻量 WebP、未经转码的原图下载文件和官方音乐。仓库公开不改变任何素材的权利归属，也不代表第三方可以复制、修改或再分发。

## 当前背景图

| 文件 | 类型 | 作者或来源 | 作者 ID / 来源链接 | 已知使用说明 |
| --- | --- | --- | --- | --- |
| `landscape1`、`landscape2` | 横图 | 官方美术 | 游戏官方发布内容 | 官方素材，权利归官方权利人所有 |
| `landscape3`、`landscape4` | 横图 | 合悟昂 | [Pixiv 56022318](https://www.pixiv.net/users/56022318) | 按作者主页所示转载要求标注作者与来源 |
| `landscape5`–`landscape7` | 横图 | 喵咕君QAQ(KH3) | [Pixiv 58434088](https://www.pixiv.net/users/58434088) | 经作者许可转载并标注作者与来源 |
| `portrait1`、`portrait2` | 竖图 | nami | [Pixiv 89748593](https://www.pixiv.net/users/89748593) | 经作者许可转载并标注作者与来源 |
| `portrait3` | 竖图 | roena | [Pixiv 35132995](https://www.pixiv.net/users/35132995) | 经作者许可转载并标注作者与来源 |
| `portrait4`、`portrait5` | 竖图 | 合悟昂 | [Pixiv 56022318](https://www.pixiv.net/users/56022318) | 按作者主页所示转载要求标注作者与来源 |
| `portrait6`–`portrait9` | 竖图 | 喵咕君QAQ(KH3) | [Pixiv 58434088](https://www.pixiv.net/users/58434088) | 经作者许可转载并标注作者与来源 |

页面上的“保存背景图片”界面同时展示作者、来源链接和原图下载入口。桌面首页只请求横屏 WebP，移动端只请求竖屏 WebP；保存界面可访问两类素材。

## 音乐

下列文件均按官方发布信息标注为 HOYO-MiX / 官方曲目：

- `HOYO-MiX - Elysian Realm.mp3`（默认曲目）
- `HOYO-MiX - Conflict.mp3`
- `HOYO-MiX - Elysia.mp3`
- `HOYO-MiX - Erupt.mp3`
- `HOYO-MiX - ForEly.mp3`
- `HOYO-MiX - Last Waltz.mp3`
- `HOYO-MiX - Subtle.mp3`
- `HOYO-MiX - Sweet Trap.mp3`
- `HOYO-MiX - The Flawless Human.mp3`
- `黄龄 HOYO-MiX - TruE.mp3`（仅保留完整高时长版本）

未使用宴宁演唱的二创曲目。音乐权利归原官方权利人所有。

## 文件处理

运行 `python .\scripts\prepare_user_assets.py` 会：

- 为 7 张横图生成最长边不超过 1920px 的桌面 WebP；
- 为 9 张竖图生成不超过 `1440×2160` 的移动端 WebP；
- 复制 16 张未经转码的原文件至 `public/assets/elytrue-20260724/originals/`；
- 生成 `1200×630` 社交分享图和站点图标；
- 复制上述 10 首官方音乐；
- 保持预览与原图路径的一一对应关系。

部署前 `npm run check:assets` 会按 `config/repository-budgets.json` 检查分类单文件、目录总量、未知二进制、未版本化大型文件和 EdgeOne Makers 25 MiB 硬限制；`npm run report:assets` 输出逐文件治理报告。
