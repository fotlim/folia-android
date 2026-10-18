# 上游基线与本分支改动

## 来源

- 上游仓库：[chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)
- 作者与贡献者：见上游 [CONTRIBUTORS.md](CONTRIBUTORS.md)、[LICENSE](LICENSE)
- 基线提交：`d7bce03`（上游 `main`，版本 0.7.20，抓取于 2026-10-18）
- 本分支版本：**0.0.1**（`package.json`、`realeco-release`、`android/app/build.gradle` 的 `versionName` 都来自同一处）
- 许可证：AGPL-3.0。本分支同样以 AGPL-3.0 发布，未改动上游许可证；分发的 APK 与源码同源。

## 改动范围

只新增 Android 平台相关能力，桌面版（Electron）、Web 版与 PWA 的行为保持不变。所有新增的
前端平台代码在 `src/services/mobileShell/`，原生代码在 `android/`，两端只通过
`window.FoliaNative` 这一处接口通信。

| 区域 | 改动 |
| --- | --- |
| `android/` | 新增：WebView 壳、SAF 文件系统桥、前台播放服务与媒体会话、服务端地址管理（全部为新增文件） |
| `src/services/mobileShell/` | 新增：原生 RPC、SAF 目录句柄实现与持久化编解码、媒体会话同步、后端自动探测、移动端布局样式 |
| `src/index.tsx` | 启动时安装 Android 壳（其他平台为 no-op） |
| `src/services/db.ts` | 目录句柄存取经过 `safHandleCodec`（浏览器里的真句柄原样透传） |
| `src/services/localMusicService.ts` | Android 壳内不把 SAF 句柄写进歌曲记录；忽略失去方法的旧句柄 |
| `src/services/localLibraryAvailability.ts` | Android 壳内本地音乐可用 |
| `src/hooks/useMediaSessionBridge.ts` | 同时向原生媒体会话发布状态；接回通知/耳机按键 |
| `src/services/runtimeConfig.ts`、三个 provider 的 base 解析 | 运行期注入的服务端地址优先于构建变量 |
| `vite.config.ts` | 新增 `FOLIA_BUILD_TARGET=mobile`：`base: './'`、不启用 PWA |
| `src/i18n/locales/*` | 新增 Android 与本地库相关文案；补齐缺失的 `ui.unknownArtist` |
| `src/components/modal/settings/**` | 「连接与集成」里新增 Android 服务端行（显示探测结果、重新探测、手动编辑） |
| `docs/android-*.md` | 移植说明、装机清单与验证截图 |

## 许可与署名

上游代码、界面设计与素材版权归 chthollyphile 及 [CONTRIBUTORS.md](CONTRIBUTORS.md) 中的贡献者所有。
本分支按 AGPL-3.0 发布；再分发时请保留 [LICENSE](LICENSE) 与本文件。
