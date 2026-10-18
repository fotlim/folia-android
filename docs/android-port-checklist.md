# Android 装机检查清单

本机没有可用的 Android 虚拟化，所以运行时行为必须在真机上过一遍。下面按「先能起来，再能用」的顺序列，每步都给出失败时该看哪里。

> 已经在 Windows Subsystem for Android（Android 13 / API 33）上过了一遍：§0 §1 §2 §3（后台连续播放、媒体会话、耳机按键）§4 的服务端配置入口、以及整套本地音乐导入/重扫/歌词都通过。标记为 ✅ 的条目是 WSA 上实测过的；Android 10~12 的设备、真实刘海屏与息屏行为仍需在手机上确认。

## 0. 安装

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
adb logcat -c
adb logcat -s FoliaShell FoliaPlayback AndroidRuntime
```

- `minSdkVersion` 必须是 29：`aapt dump badging <apk> | grep sdkVersion`。

## 1. 首帧

- [ ] 冷启动后能看见 Folia 的启动遮罩，随后进入首页，而不是黑屏或白屏。
- [ ] 首次启动弹出「Server endpoints」原生对话框（三处地址都为空时）。可以取消。
- [ ] 日志里出现 `[MobileShell] Android device {...}`。
- [ ] 若系统 WebView 低于 100，会先弹更新提示。

失败时：`FoliaShell` 日志里有 WebView 的 console。白屏通常是 JS 抛错或资产 404 —— 检查 `index.html` 的脚本是否 200（壳对未知资产返回 404）。

## 2. 本地音乐

- [ ] 首页选择本地音乐 → 出现系统目录选择器 → 选中一个含音频文件的目录。
- [ ] 列表出现曲目，封面/标题/时长正常（这一步会走 SAF 列表 + 逐文件 fetch + 元数据解析）。
- [ ] 播放一首本地 FLAC / MP3，进度条与歌词跟随。
- [ ] 杀掉应用重开，本地库仍在，且能直接播放（验证句柄持久化 + `takePersistableUriPermission`）。
- [ ] 「重新扫描」不会把所有歌当成新歌（验证 `local_dir_handles` 编解码）。

失败时：`NotFoundError` = SAF 目录/文件解析不到；`NotReadableError` = ContentResolver 打不开流；两者都看 `FoliaShell` 日志。

## 3. 后台与锁屏

- [ ] 播放中按 Home，声音继续。
- [ ] 息屏 30 秒后声音仍继续，锁屏界面显示当前曲目与封面。
- [ ] 通知栏出现媒体通知，播放/暂停、上一首、下一首都生效。
- [ ] 蓝牙耳机/线控的播放暂停键生效。
- [ ] 从最近任务划掉应用：仍在播放（`onTaskRemoved` 故意不停止）。

失败时：`FoliaPlayback` 日志；Android 13+ 没有通知说明 `POST_NOTIFICATIONS` 被拒（系统设置里打开）。

## 4. 在线音乐

- [ ] 「设置 → 连接与集成 → 在线音乐后端」打开原生对话框，填入自建地址并保存。
- [ ] 应用自动重载；搜索网易云有结果，能播放。
- [ ] 局域网 http 地址可用（验证明文流量与混合内容放行）。

失败时：看页面内「开发者 → 运行日志」，那里有 `VITE_NETEASE_API_BASE is not configured` 一类的明确错误。

## 5. 界面适配

- [x] 竖屏 1080×2400（393×873 CSS）：整页无横向溢出，缝、页签、底部工具列、播放胶囊齐全（WSA 已验）。
- [x] 横屏 800×360（20:9 手机横置）：页签不裁切，可在缝内滚动（WSA 已验）。
- [ ] 状态栏与手势条不遮挡内容（WSA 无系统栏，需真机确认）。
- [ ] 软键盘不遮挡输入框（设置 → 搜索设置；WSA 无可用软键盘，需真机确认）。
- [ ] 横竖屏切换不重建 WebView（`configChanges` 已声明）。
- [ ] 返回手势：有弹窗时只关弹窗；无弹窗时把应用切到后台，不销毁 Activity。
- [ ] 通知权限被拒后，播放与本地库仍然可用（只是没有通知）。

## 6. 已知不需要在真机上验证的

桌面专属入口（模组系统、OBS、Stage、遥控窗、壁纸、歌词接口、透明背景、均衡器/智能过渡）在 `window.electron` 不存在时前端不会渲染，属于预期。
