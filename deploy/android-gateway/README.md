# 网易云专用网关（Android 客户端用）

给 Folia 的 Android 构建提供「开箱即用」的在线音乐后端。做法和常见的第三方网易云客户端一样：
**跑一份官方 API 实例，登录态留在服务端**，客户端不用令牌、不用填地址，扫码登录后直接用。

只跑网易云；酷狗 / QQ 的适配代码仍在仓库里，等需要时用构建变量加回来（见文末「预留接口」）。

## 它做了什么

```
GET  /health               → { ok, loggedIn, store }   存活探测（App 的后端自动发现用它）
ANY  /api/<endpoint>       → 转发给本机 NeteaseCloudMusicApiEnhanced，带上服务端的 Cookie
```

- 上游只监听 `127.0.0.1`，不暴露公网；网关是唯一入口。
- 登录走的是上游原有的 `/login/qr/*`（App 里就是扫码），密码不经过网关。
- 一个部署 = 一个网易云账号（和 YesPlayMusic 这类方案一致）。

## 会话持久化（开关）

默认只在内存里，网关重启就要重新扫码。要保留登录态，用环境变量选一个后端：

```bash
# 写盘
COOKIE_STORE=file COOKIE_JAR_FILE=./.netease-cookies.json npm start

# 写 Redis（多实例/容器重启也稳）
COOKIE_STORE=redis REDIS_URL=redis://127.0.0.1:6379/0 npm start

# 默认：只在内存
npm start
```

每次上游回写 Cookie 都会立刻落一次；`/health` 的 `store` 字段能看出当前用的是哪个后端，
`loggedIn` 表示罐里有没有 `MUSIC_U`。

## 部署

```bash
cd deploy/android-gateway
npm install
PORT=8080 NCM_PORT=3001 npm start
```

前面挂一层 HTTPS 反代（Caddy / Nginx / Cloudflare Tunnel）即可。客户端要求 HTTPS，或同局域网的 http。

## 客户端怎么接上

APK 构建时把默认地址写进构建变量，或在设备上让自动发现找到它：

```bash
VITE_NETEASE_API_BASE=https://你的网关域名/api
```

- App 启动后自动探测 / 使用这个地址；
- 用户只需要在「连接在线平台」里扫码登录网易云，不需要填任何地址。

## 预留接口

| 想恢复的东西 | 改哪里 |
| --- | --- |
| 重新开放 QQ / 酷狗 | `package.json` 的 `build:android` 里 `VITE_ONLINE_PROVIDERS=netease,qq,kugou` |
| 网关多接一个平台 | `server.mjs` 里照 `/api` 的形状加一条转发 + 一个上游实例 |
| 换成别的后端 | 客户端只认 `VITE_NETEASE_API_BASE` / `runtime-config.js` 的 `servers.netease`，任意兼容实现都行 |
