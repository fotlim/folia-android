# 网易云专用网关（Android 客户端用）

给 Folia 的 Android 构建提供「开箱即用」的在线音乐后端：客户端只认网关地址，登录仍然是网易云扫码，
Cookies 留在网关侧，按设备令牌区分。**只跑网易云**；酷狗 / QQ 的适配代码仍在仓库里，等需要时在
`src/services/onlineMusic/providerEnablement.ts` 的构建变量里加一个名字即可恢复，网关再加一条转发。

## 它做了什么

```
POST /auth/register        → { token }      给一台设备开一个空 Cookie 罐
GET  /health               → { ok: true }   存活探测（App 的后端自动发现用它）
ANY  /api/<endpoint>       → 转发给本机 NeteaseCloudMusicApiEnhanced，带上该设备的 Cookie
```

- 上游只监听 `127.0.0.1`，不暴露公网；网关是唯一入口。
- 请求带 `Authorization: Bearer <token>`；没有令牌时返回 401 `DEVICE_TOKEN_REQUIRED`，客户端据此自动注册。
- 登录（扫码）走的是上游原有的 `/login/qr/*`，密码不经过网关。

## 部署

```bash
cd deploy/android-gateway
npm install
PORT=8080 NCM_PORT=3001 npm start
```

前面挂一层 HTTPS 反代（Caddy / Nginx / Cloudflare Tunnel）即可；客户端要求 HTTPS 或局域网 http。

## 客户端怎么接上

APK 构建时把默认地址写进构建变量（或让设备上的自动发现找到它）：

```bash
# .env.android 或在命令行
VITE_NETEASE_API_BASE=https://你的网关域名/api
```

- App 启动后自动探测 / 使用这个地址；
- 首次请求前会 `POST /auth/register` 拿设备令牌，写进原生设置，之后每次请求自动带上；
- 用户不需要填任何地址，只需要在「连接在线平台」里扫码登录网易云。

## 与「预留接口」

| 想恢复的东西 | 改哪里 |
| --- | --- |
| 重新开放 QQ / 酷狗 | 构建变量 `VITE_ONLINE_PROVIDERS=netease,qq,kugou`（`package.json` 的 `build:android`） |
| 网关多接一个平台 | 本文 `server.mjs` 里照 `/api/netease` 的形状加一条转发 + 一个上游实例 |
| 换成别的后端 | 客户端只认 `VITE_NETEASE_API_BASE` / `runtime-config.js` 的 `servers.netease`，任意兼容实现都行 |
