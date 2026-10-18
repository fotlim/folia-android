# Android 移植说明（Android 10 / API 29 及以上）

这个目录树里的 Android 支持不是另写一个客户端：它把同一份 React 前端装进一个 WebView 壳，再给壳补上三件浏览器没有、而手机上必须有的能力。

| 能力 | 浏览器 / PWA | Android 壳 |
| --- | --- | --- |
| 本地音乐目录 | `showDirectoryPicker`（File System Access API） | Storage Access Framework（系统文件选择器）+ 同形状的句柄实现 |
| 后台 / 锁屏播放 | 页面里的 `navigator.mediaSession` | 前台服务 + 平台 `MediaSession` + 媒体通知 |
| 在线音乐后端 | 部署好的 Web 版地址（构建变量） | 设备内设置的服务端地址（`runtime-config.js` 运行期注入） |

版本基线：`minSdk 29`（Android 10）、`targetSdk 35`、`compileSdk 35`、AGP 8.7.2、Gradle 8.11.1、JDK 17。之所以从 29 起，是因为作用域存储、前台服务类型和媒体通知在这之后才是稳定形态；再往下的系统需要另一套存储权限模型，不在此次范围内。

## 竖屏 / 1080×2400 / 20:9 手机适配

手机上的 CSS 视口是「物理像素 ÷ DPR」，所以 1080×2400 的 20:9 手机（dpr 2.75–3）实际是 **393×873 或 360×800 CSS 像素**，横过来是 **800×360**。这三档是适配的目标，量法记在 `test/manual/android-viewport-check.mjs`（按给定视口渲染并报告横向溢出、越界元素、过小的点按目标）。

已做的调整：

| 位置 | 问题 | 处理 |
| --- | --- | --- |
| 软键盘（竖屏/横屏都会遇到） | `decorFitsSystemWindows=false` 下 `adjustResize` 不再缩窗口，输入框与对话框按钮被键盘盖住 | `MainActivity` 把 `WindowInsetsCompat.Type.ime()` 的底边也算进 WebView 容器的 padding（与 `systemBars`/`displayCutout` 取较大值） |
| Bravais 缝内页签 | 竖排文字让它只有 **22 CSS px 宽**，约为触控下限的一半 | 窄屏（≤480px）把 `padding-block` 加到 11px → **37–38 CSS px**；`writing-mode: vertical-rl` 下 block 轴才是水平方向，用 inline 会让页签变高而不是变宽 |
| 播放胶囊 | `md` 断点下只有 80% 宽，360px 屏上进度条仅约 290px | 窄屏改为整宽（328px @360） |
| 横屏 360px 高 | 缝的页签列只剩 60px，九行页签被 `overflow: hidden` 裁掉 | `max-height: 420px` 时给导航列 200px 下限，并让整个缝纵向滚动；页签间 gap 归零 |
| 状态栏 / 挖孔 / 手势条 | 页面画到系统栏下面 | 容器按 `systemBars`+`displayCutout` 加 padding（整块 WebView 内缩，`position: fixed` 的浮层同样受益） |

这些规则全部写在 `src/services/mobileShell/mobileShell.css`，并**只在 `html[data-folia-shell='android']` 下生效**——桌面版、Web 版、PWA 的布局一个像素都没动。

顺带修掉一个与分辨率无关、但只有窄屏才看得见的 bug：`App.tsx` 用 `t('ui.unknownArtist')` 取歌手占位文案，而 `ui` 命名空间里根本没有这个键，未匹配到在线元数据的本地歌曲会在播放栏显示原始的 `ui.unknownArtist` 字符串；三个语言文件已补上。

验证（真机视口 393×873 CSS / dpr 2.75 = 1080×2400，WebView 自身截图）：

- 竖屏整页布局正确，缝居中、五个页签与底部工具列齐全，播放胶囊占满可用宽度（见 `docs/android-portrait-1080x2400.png`）；
- 页签实测 37×42 CSS px（102×115 物理像素）；
- 横屏 800×360 时页签恢复为单字并可在缝内滚动（见 `docs/android-landscape-800x360.png`）；
- 软键盘：WSA 没有可用的软键盘（`mInputShown=false`），IME inset 这条只按 API 语义实现，需在手机上确认一次。

## 架构

```
android/app/src/main/java/top/izuna/foliamajor/
├── MainActivity.java       WebView 装配、资产路由、返回键、窗口内边距、WebView 版本检查
├── WebAssetHandler.java    把 dist/ 从 APK 里以 https://appassets.androidplatform.net 提供（安全上下文）
├── SafStreamHandler.java   把一个 SAF 文档当成 HTTP 响应流出去（fetch → Blob，不走 base64）
├── FoliaFileSystem.java    SAF 树遍历：列表、定位文件、持久化权限检查
├── FoliaBridge.java        window.FoliaNative 的唯一实现，全部异步回调
├── PlaybackService.java    前台服务 + 媒体会话 + 媒体通知 + 唤醒锁
└── ServerSettings.java     在线后端地址（原生对话框 + 生成 runtime-config.js）
```

前端侧新增 `src/services/mobileShell/`：

| 文件 | 作用 |
| --- | --- |
| `nativeBridge.ts` | `callNative()` RPC、事件分发、`isAndroidShell()` 判定 |
| `safDirectoryHandles.ts` | `showDirectoryPicker` 的 SAF 实现：`values()` / `getDirectoryHandle` / `getFileHandle` / `getFile` / `queryPermission` |
| `safHandleCodec.ts` | 把句柄编成可存 IndexedDB 的普通对象，读回时还原（浏览器里的真句柄原样透传） |
| `mediaSessionNative.ts` | 把播放状态推给前台服务；把通知上的播放/暂停/上一首/下一首接回播放器 |
| `mobileShell.ts` | 安装上述能力、返回键、通知权限 |

### 为什么用自绘的 WebView 壳而不是 Capacitor

官方示范仓库 [folia-sonnet](https://github.com/chthollyphile/folia-sonnet) 用 Capacitor 打包，并明确不承诺本地音乐扫描、后台/锁屏连续播放和前台媒体服务。这三件恰好是这次移植要解决的，而它们都需要原生代码；既然要写原生代码，直接用一个 Activity + `WebViewAssetLoader` + JavaScriptInterface 反而更短：没有 `cap sync`、没有插件注册表、也没有 Capacitor 版本与 AGP 的耦合。

壳没有引入任何第三方原生依赖，只有 `androidx.appcompat` / `core` / `documentfile` / `webkit`。

### 关键实现取舍

- **安全上下文**：页面从 `https://appassets.androidplatform.net/assets/public/index.html` 加载。origin 是 https，所以 OPFS（`navigator.storage.getDirectory()`，封面与二进制缓存依赖它）、`crypto.subtle`、`localStorage` 全部可用。
- **文件不再走 base64**：`FoliaFileSystem` 给每个待读文件发一个一次性 token，前端 `fetch` `/saf/<token>` 拿到响应体。整首歌只经过一次 ContentResolver 流，Chromium 会把大 Blob 落到磁盘，不会把 40 MB 的 FLAC 塞进 JS 堆。
- **SAF 句柄的形状**：`values()` 是目录遍历唯一的入口，前端拿到的每个子项都能继续 `getFileHandle`；因此 `localMusicService.ts` 的导入、重扫、歌词与封面查找、播放前取文件都不用改。
- **句柄跨重启**：真的 File System Access 句柄可以结构化克隆进 IndexedDB；壳里的句柄是类实例，不能。`safHandleCodec` 存「根 tree URI + 相对路径」，读回时重建，`queryPermission` 会向系统确认持久化读权限还在。
- **返回键**：先按 Escape（应用用它关弹窗/面板），当前没有任何可见浮层时再把应用切到后台，而不是销毁 Activity——销毁会连带停掉播放。
- **锁屏与息屏**：前台服务持有 `PARTIAL_WAKE_LOCK` 和音频焦点，`MainActivity.onPause` 在服务活动期间不暂停 WebView，队列、解码器和定时器才能继续跑。Android 14+ 需要的 `FOREGROUND_SERVICE_MEDIA_PLAYBACK` 已在清单里声明。
- **明文后端**：`usesCleartextTraffic="true"` + `MIXED_CONTENT_ALWAYS_ALLOW`。自建网易云/酷狗/QQ API 通常在局域网里跑 http，不允许就会被静默拦掉。
- **窗口内边距**：`WindowCompat.setDecorFitsSystemWindows(false)` 之后把 systemBars + displayCutout 的 insets 作为 padding 加在容器上。targetSdk 35 在 Android 15 上强制 edge-to-edge，这样刘海和手势条都不会压住内容。

## 构建

需要 JDK 17、Android SDK Platform 35、Build-Tools 35.0.0，Node.js 24。

```bash
# 1. 装依赖（与 Web 版相同）
npm install

# 2. 构建前端并复制进 APK 资产目录
npm run build:android

# 3. 打包
npm run android:apk:debug     # 调试包，输出 android/app/build/outputs/apk/debug/
npm run android:apk           # 签名发行包，输出 android/app/build/outputs/apk/release/
```

`android/keystore.properties` 指向仓库里自签的 `android/folia-release.keystore`（口令写在文件里）。它只用于本地安装验证，**不能**用于上架；换自己的密钥时替换该文件即可，`app/build.gradle` 会在存在时自动启用签名。

没有 Android SDK 时：

```bash
sdkmanager --install "platforms;android-35" "build-tools;35.0.0" "platform-tools"
```

`android/local.properties` 里的 `sdk.dir` 是机器本地路径，不要提交。

> 本项目的主依赖流程是 `npm install`（仓库里是 `package-lock.json`）。如果你习惯用 pnpm，请额外在 `.npmrc` 里加 `node-linker=hoisted`：`@paper-design/shaders-react` 直接 import 了它自己的同级依赖 `@paper-design/shaders`，pnpm 的默认严格布局不提升它，构建会报 `Rolldown failed to resolve import "@paper-design/shaders"`。

## 运行期配置：在线音乐后端

APK 里没有内置网易云/酷狗/QQ 后端（和 Web 版一样，需要自行部署）。地址在**设备上**配置，不需要重新打包：

- 首次启动且三处地址都为空时，应用会自动弹出原生对话框；
- 之后可以在「设置 → 连接与集成 → 在线音乐后端」重新打开；
- 保存后应用重新加载，壳会把地址写进 `runtime-config.js`（由 `WebAssetHandler` 按请求生成），前端 `src/services/runtimeConfig.ts` 里的 `getRuntimeServerEndpoint()` 优先生效，其次才看构建时的 `VITE_*` 变量。

留空表示该平台不可用，其余功能（本地音乐、Navidrome、歌词动画）不受影响。

## 与桌面版的能力差异

| 功能 | Android | 说明 |
| --- | --- | --- |
| 本地音乐导入 / 重扫 / 歌词封面 | ✅ | 经 SAF，需要用户授权目录 |
| 后台、息屏、锁屏控制 | ✅ | 前台服务 + 媒体通知（无进度拖动） |
| 在线音乐（网易云/酷狗/QQ） | 取决于自建后端 | 与 Web 版一致 |
| AI 主题 | 取决于部署的后端 | `GEMINI_API_KEY` / OpenAI 兼容接口只在服务端 |
| 均衡器 / 智能过渡（Beat This / htdemucs） | ❌ | 依赖 Electron 主进程的 ONNX 推理 |
| 模组系统（Folium）、OBS 浏览器源、Stage、遥控窗、壁纸模式、歌词接口、透明背景 | ❌ | 都是桌面专属入口，`window.electron` 不存在时前端本来就不显示 |

## 验证状态

### 真机（Windows Subsystem for Android，Android 13 / API 33，WebView 118）

通过 `adb connect 127.0.0.1:58526` 装到 WSA 上逐项验证：

| 项目 | 结果 |
| --- | --- |
| 冷启动 | ✅ WebView 加载打包资产，启动遮罩退出，首启动原生「Server endpoints」对话框弹出 |
| 本地音乐导入 | ✅ 系统目录选择器 → 选中 `/sdcard/Music/FoliaTest` → 日志 `Traversed 2 relevant files`、`Saved directory handle`、`Finished importing "FoliaTest" with 1/1 available songs` |
| SAF 流式读取 | ✅ 音频元素 `src=blob:https://appassets…`、`duration=40`（WAV），说明 `/saf/<token>` 流 → Blob → File → 播放链路成立 |
| 歌词文件 | ✅ 同目录 `.lrc` 被索引，播放页按时间轴显示 `With screen` / `Foreground service` |
| 全屏歌词动画 | ✅ 播放页渲染正常（见 `docs/android-wsa-player.png`） |
| 句柄跨进程持久化 | ✅ `am force-stop` 后重启，本地库仍在（`takePersistableUriPermission` + `safHandleCodec`） |
| 重扫增量 | ✅ 新增一首后 `Snapshot diff: 1 changed/new, 1 unchanged`，不是全量重导 |
| 后台续播 | ✅ 按 Home 后 `visibilityState=hidden`，播放位置从 2s 继续到 15s，媒体会话保持 `state=3`（PLAYING） |
| 媒体通知 | ✅ `dumpsys notification` 有 `category=transport`、`channel=folia.playback`、3 个动作的通知 |
| 耳机/车机按键 | ✅ `KEYCODE_MEDIA_PAUSE` → 暂停（18.77s），`KEYCODE_MEDIA_PLAY` → 继续（21.98s），日志 `MediaSessionService … to top.izuna.foliamajor.debug/Folia` |
| 发行包 | ✅ 同上，`assembleRelease` 产物安装后正常启动 |
| 1080×2400 竖屏 | ✅ `wm size 1080x2400` + `am task resize` 把窗口拉到满屏，WebView 自报 393×873 CSS / dpr 2.75；整页布局、五个页签、底部工具列与播放胶囊都在（见 `docs/android-portrait-1080x2400.png`） |
| 800×360 横屏 | ✅ 页签回到单字并可在缝内滚动，不再被裁到只剩一个（见 `docs/android-landscape-800x360.png`） |

真机验证抓到并修掉的两个 bug（都是只有装到设备上才会暴露的）：

1. **`SuperNotCalledException`**：最初为了「播放时别暂停 WebView」在 `onPause()` 里跳过 `super.onPause()`，Android 直接抛异常杀进程——一按播放就崩。实际情况是 `super.onPause()` 本来就不会暂停 WebView，跳过它没有任何收益。现在无条件调用，页面照常运行。
2. **播放 70ms 后自动暂停**：前台服务里又申请了一次 `AUDIOFOCUS_GAIN`，而 Chromium 自己已经为 `<audio>` 申请了瞬时焦点，同一应用二次申请导致系统重分配焦点，WebView 收到 `AUDIOFOCUS_LOSS` 就把媒体暂停了。现在服务完全不碰音频焦点，只做通知与媒体会话（`AudioFocus` 日志与修复后的位置推进可对照）。

另外把两处会打扰用户的弹窗改成一次性：首启动的服务端对话框与通知权限请求都用 SharedPreferences 记过，Activity 重建或换歌不会再弹。

### 本机构建与前端烟测

- `FOLIA_BUILD_TARGET=mobile vite build` 通过，产物 19.5 MB / 1912 个文件；PWA 插件在该模式下不启用，`base` 为 `./`。
- `tsc --noEmit` 通过（含新增的 `src/services/mobileShell/*`、`useMediaSessionBridge` 改动）。
- `gradle assembleDebug` / `assembleRelease` 通过；`aapt2 dump badging` 确认 `minSdkVersion 29`、`targetSdkVersion 35`、`FOREGROUND_SERVICE_MEDIA_PLAYBACK` 与 `POST_NOTIFICATIONS` 已声明；`apksigner verify` 确认发行包已签名；APK 内 `assets/public` 含 1912 个文件，主 chunk 与 `dist/` 一致。
- 前端烟测 `npm run test:android-smoke`：用 Chromium 在 412×915 视口里带一个假的 `FoliaNative` 启动移动构建。结果：开机成功（启动遮罩退出、`#root` 有内容）、`__foliaNativeSettle`/`__foliaNativeTransport`/`__foliaNativeBackPressed` 都已安装、`showDirectoryPicker` 已被 SAF 版本替换、`device.info` 与 `media.clear` 已被调用、控制台无报错；并且完整走了一遍本地音乐要用的路径——选目录 → `values()` 遍历 → `getDirectoryHandle` 下钻 → `getFileHandle` → `getFile()`（`/saf/<token>` 流式读取，拿到的字节、mime、文件名都对）。截图见 `docs/android-smoke.png`。

### 尚未验证

- 真实手机/平板：刘海与手势条的 insets、息屏（`SCREEN_OFF`）下的续播、蓝牙耳机按键、Android 10/11/12 上的行为差异。
- 通知样式在不同 OEM 系统上的呈现（WSA 没有完整的通知栏 UI，只验证到通知记录与动作）。

装机后的检查顺序见 `docs/android-port-checklist.md`。

## 排障

- **在 WSA 上调试**：`adb connect 127.0.0.1:58526`（先在 WSA 设置 → 开发者 打开 ADB 调试并在弹出的授权框里点允许）。调试包开了 `setWebContentsDebuggingEnabled`，可以用 `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` 接管页面；仓库里的 `test/manual/wsa-cdp.mjs` 提供了 `text` / `click` / `tap` / `eval` / `key` 几个动作，比按坐标点更可靠（WSA 的 freeform 窗口位置会变）。
- **白屏**：`adb logcat -s FoliaShell`。壳把 WebView 的 console 全部转成 `FoliaShell` 日志，前端启动错误会直接出现在里面。
- **本地音乐入口未出现**：确认 `https://appassets.androidplatform.net` 这个 origin 下的 `isSecureContext` 为真（壳里恒为真），以及系统文件选择器返回了目录；`saf.list` 失败会以 `NotFoundError` 出现在日志里。
- **没有播放通知**：Android 13+ 需要 `POST_NOTIFICATIONS`，壳在第一次播放时请求一次；被拒绝后需在系统设置里手动打开。
- **WebView 版本过旧**：低于 100 时应用启动会提示更新 Android System WebView（OPFS 需要 86+，壳的其余 API 也需要较新的 Chromium）。
