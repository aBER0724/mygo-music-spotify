# Spotify · MyGo Music 插件

在 [MyGo Music](https://github.com/egoist/mygo-music) 中浏览 Spotify 曲库和你的资料库，通过 Spotify Connect 控制播放。需要 MyGo Music 0.1.22 及以上。

Spotify 不向第三方应用提供音频，所以 MyGo Music 通过 Spotify Connect 控制一台 Spotify 设备播放：可以是你打开的 Spotify 客户端（电脑、手机或音箱），也可以是插件内置的播放器。MyGo Music 负责选歌、暂停、拖动进度和调音量。播放需要 **Spotify Premium**。

## 准备 Spotify 应用

Spotify 的开发模式要求每位使用者用自己的 Client ID，一次配置即可：

1. 打开 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)，用 Premium 账号登录，点 **Create app**。
2. **Redirect URIs** 填 `http://127.0.0.1:43821/callback`（必须是 `127.0.0.1`，不能写 `localhost`），API 勾选 **Web API**，保存。
3. 在应用的 **User Management** 中加入要登录的 Spotify 账号邮箱（开发模式最多 5 人；只有你自己用时加自己）。
4. 复制应用的 **Client ID**。

## 安装和使用

1. MyGo Music → 设置 → 插件 → `+` → 从 GitHub 安装，填入 `starriv/mygo-music-spotify`。也可以从 [Releases](https://github.com/starriv/mygo-music-spotify/releases) 下载 `plugin.zip` 后从本地安装。
2. 在插件设置中粘贴 Client ID。
3. 在来源选择器中选 **Spotify**，点 **登录**，在浏览器里授权后回到 MyGo Music。
4. 点播放。有打开的 Spotify 客户端时用它播放；没有时用内置播放器在这台电脑上播放。播放器的设备菜单可以切换设备。

## 内置播放器（Spotify Soloist）

不想打开 Spotify 应用时，插件可以用 Spotify 官方的无界面播放器 [Spotify Soloist](https://developer.spotify.com/documentation/soloist) 在这台电脑上播放。支持 Apple 芯片的 Mac（macOS 13 及以上）和 x86_64 Windows。

1. 按 [Soloist 入门指南](https://developer.spotify.com/documentation/soloist/tutorials/getting-started) 用 Premium 账号生成 API Key，填到插件设置的 **Soloist API Key**。每个人要用自己的 Key。
2. 在 MyGo Music 的插件设置中允许 Spotify 插件运行程序（用于下载、解压和启动 Soloist）。
3. 第一次使用时，插件从 Spotify 官方地址下载 Soloist（约 11 MB）到插件文件夹的 `soloist/` 中。Spotify 不允许转发 Soloist，所以插件不附带它。
4. 配对一次：保存 Key 后插件会在后台启动 Soloist。在同一网络下打开手机或这台电脑上的 Spotify 应用，点「连接到设备」，选择「MyGo Music on Mac」（Windows 上是「MyGo Music on Windows」）。以后会自动恢复登录，不用再打开 Spotify 应用。没配对就点播放时，MyGo Music 也会提示这一步。

Soloist 每个版本 90 天后过期，过期时插件会自动重新下载。它只在需要时启动，退出 MyGo Music 时一起关闭。退出插件登录会同时清除 Soloist 的配对。

API Key 会出现在 Soloist 的启动参数中，同一台电脑上以你的身份运行的其他程序能看到它。

## 功能

- 歌曲、专辑、艺人、歌单和播客搜索，支持翻页。
- 首页：最近播放、热门歌曲、热门艺人、你的歌单；侧栏有热门歌曲（最近 4 周和 6 个月）和最近播放。
- 已点赞的歌曲、收藏的专辑、订阅的播客，以及点赞、收藏、关注、订阅。
- 自建歌单的创建、改名、删除（取消关注）、添加和移出歌曲、调整顺序。
- 专辑、艺人、播客详情；播客节目可以直接播放和保存。
- 同步歌词：Spotify 不向第三方提供歌词，插件按歌名、歌手和时长从 [LRCLIB](https://lrclib.net) 和网易云音乐匹配。外语歌在网易云有中文翻译时一并显示。
- Spotify Connect：播放队列、暂停、继续、拖动、音量、切换设备，并跟随在 Spotify 端切换的歌曲。

## 限制

这些来自 Spotify 对开发模式应用的规定（2024 年 11 月和 2026 年 2 月的变更），插件无法绕开：

- 别人的歌单（包括 Spotify 官方编辑歌单和「每周新发现」）读不到歌曲列表，只显示说明，请在 Spotify 应用中播放。你自己创建或协作的歌单不受影响。
- 没有艺人热门歌曲接口，艺人页的歌曲来自按艺人名搜索的结果，只保留确实属于该艺人的歌。
- 没有推荐、电台和评论接口，所以插件不提供这些页面。歌词来自第三方，偶尔会缺失，或匹配到同名、同时长的其他版本。
- 搜索每页最多 10 条。
- 设备列表里离线却仍标为「正在使用」的设备（常见于很久没开的电脑）会被跳过：插件确认播放没有开始后，换到其他设备或 Soloist。
- 一次把当前歌曲起的 50 首交给 Spotify，播完后 MyGo Music 自动续上。若 Spotify 开启了「自动播放」，在队列末尾可能先播放它推荐的歌，这时 MyGo Music 会提示 Spotify 正在播放别的内容。

登录信息只保存在 MyGo Music 的插件数据中。退出登录会删除本地令牌；要彻底撤销授权，到 [spotify.com/account/apps](https://www.spotify.com/account/apps/) 移除这个应用。

## 开发

```
plugin.json            插件清单（MyGo Music 要求放在仓库根目录）
locales/zh-CN.json     简体中文翻译（宿主要求与 plugin.json 同级）
src/index.js           插件本体，plugin.json 的 main
test/                  按功能分的测试：auth、catalog、library、playback、soloist、lyrics
test/helpers.mjs       测试共用的模拟宿主、Spotify、Soloist 和歌词源
scripts/verify.mjs     检查清单、翻译、权限与代码一致
scripts/pack.mjs       生成 dist/plugin.zip
.github/workflows/     CI 与发布
```

MyGo Music 把 `main` 当作单个文件加载，不支持 `import` 其他文件，所以插件代码保持在一个文件里，按区块组织。运行不需要构建或依赖安装，开发只需 Node 22.2+：

```sh
npm run verify   # 语法检查、一致性检查、全部测试
npm run pack     # 校验后生成 dist/plugin.zip（同样的源码生成完全相同的文件）
```

- 测试替换了 `host` 和 `fetch`，不访问网络，也不需要 Spotify 账号。
- 界面文字用 `t("English")` 包裹，并在 `locales/zh-CN.json` 中提供翻译，`npm run verify` 会检查有无缺漏。
- 本地调试：在 MyGo Music 中从文件夹安装本仓库即可。
- 发布：在 `plugin.json`、`package.json` 中提升版本，在 `CHANGELOG.md` 写好该版本的条目，推送到 `main`。CI 校验通过后，若该版本还没有 Release，会自动创建 `v<版本>` tag 和 Release，附上 `plugin.zip`，说明取自 CHANGELOG。

## 许可证

[AGPL-3.0-only](LICENSE)。Spotify 及其内容归 Spotify AB 所有，本项目不是 Spotify 或 MyGo Music 的官方发布。
