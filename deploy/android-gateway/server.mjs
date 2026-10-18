// deploy/android-gateway/server.mjs
// 网易云专用网关：手机 App 只认这一个地址，登录用网页扫码，Cookies 留在网关侧，按设备令牌区分。
//
// 结构：
//   POST /auth/register        → { token }，给一台设备开一个空 Cookie 罐
//   任意其它 /api/<endpoint>   → 带着该设备的 Cookie 转发给本机 NeteaseCloudMusicApiEnhanced
//   GET  /health               → 存活探测（App 的后端自动发现用它）
//
// 为什么需要它：网易云接口要服务端签名与 Cookie，浏览器/WebView 直连会被 CORS 和 SameSite 挡死。
// 网关只是把「官方 API 实例」包一层，登录仍然是用户用网易云 App 扫码（网页授权），我们不碰密码。

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serveNcmApi } = require('@neteasecloudmusicapienhanced/api/server');

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_PORT = Number(process.env.NCM_PORT || 3001);
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || '').replace(/\/$/, '');

/** 设备令牌 → 该设备的 Cookie 罐。重启后失效，App 会重新注册并重新扫码。 */
const jars = new Map();

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Cookie',
    'Access-Control-Max-Age': '86400',
};

const readToken = (request) => {
    const header = request.headers.authorization || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
};

const parseCookieHeader = (raw) => {
    const jar = {};
    for (const part of String(raw || '').split(';')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        jar[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return jar;
};

const jarToHeader = (jar) => Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; ');

const absorbSetCookie = (jar, setCookie) => {
    for (const cookie of [].concat(setCookie || [])) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        if (index <= 0) continue;
        jar[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
    }
};

const json = (response, status, body) => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
    });
    response.end(payload);
};

const readBody = (request) => new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
});

// 上游：本机跑一份官方 API，网关只做转发与 Cookie 归属。
const upstream = http.createServer((request, response) => {
    response.writeHead(404).end();
});

await serveNcmApi({ port: UPSTREAM_PORT, host: '127.0.0.1' });

const forward = (path, method, headers, body) => new Promise((resolve, reject) => {
    const request = http.request({
        host: '127.0.0.1',
        port: UPSTREAM_PORT,
        path,
        method,
        headers,
    }, response => {
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve({
            status: response.statusCode || 502,
            headers: response.headers,
            body: Buffer.concat(chunks),
        }));
    });
    request.on('error', reject);
    if (body && body.length) request.write(body);
    request.end();
});

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', PUBLIC_ORIGIN || `http://127.0.0.1:${PORT}`);

    if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders).end();
        return;
    }

    if (url.pathname === '/health') {
        json(response, 200, { ok: true, service: 'folia-netease-gateway', upstream: UPSTREAM_PORT });
        return;
    }

    if (url.pathname === '/auth/register' && request.method === 'POST') {
        const token = randomUUID();
        jars.set(token, {});
        json(response, 200, { token });
        return;
    }

    if (!url.pathname.startsWith('/api/')) {
        json(response, 404, { error: 'not found' });
        return;
    }

    const token = readToken(request);
    if (!token || !jars.has(token)) {
        json(response, 401, { error: 'unknown device token; register first', code: 'DEVICE_TOKEN_REQUIRED' });
        return;
    }

    const jar = jars.get(token);
    const headers = {
        // 上游只监听回环，主机名固定；其余头原样转过去。
        host: `127.0.0.1:${UPSTREAM_PORT}`,
        accept: request.headers.accept || '*/*',
    };
    if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
    for (const [key, value] of Object.entries(request.headers)) {
        if (['x-router', 'x-csrf-token', 'x-real-ip', 'x-forwarded-for'].includes(key)) {
            headers[key] = Array.isArray(value) ? value.join(', ') : value;
        }
    }
    const cookieHeader = jarToHeader(jar);
    if (cookieHeader) headers.cookie = cookieHeader;

    try {
        const result = await forward(
            url.pathname.replace(/^\/api/, '') + url.search,
            request.method,
            headers,
            request.method === 'GET' || request.method === 'HEAD' ? null : await readBody(request),
        );
        absorbSetCookie(jar, result.headers['set-cookie']);
        response.writeHead(result.status, {
            ...corsHeaders,
            'Content-Type': result.headers['content-type'] || 'application/json; charset=utf-8',
            'Content-Length': result.body.length,
        });
        response.end(result.body);
    } catch (error) {
        json(response, 502, { error: 'upstream unreachable', detail: String(error && error.message || error) });
    }
});

server.listen(PORT, () => {
    console.log(`[folia-gateway] listening on :${PORT}, NetEase upstream :${UPSTREAM_PORT}`);
});
