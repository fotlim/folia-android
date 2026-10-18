// deploy/android-gateway/server.mjs
// 网易云专用网关：手机 App 只认这一个地址。做法和常见的第三方网易云客户端一样——跑一份官方 API
// 实例，登录态（Cookie）留在服务端，扫码登录后所有请求共用这一个会话；客户端不需要令牌、不需要
// 配置任何东西，打开就能用。
//
// 结构：
//   GET  /health               → 存活探测（App 的后端自动发现用它）
//   任意其它 /api/<endpoint>   → 转发给本机 NeteaseCloudMusicApiEnhanced，带上服务端的 Cookie
//
// 会话持久化（可选，重启不用重扫码）：
//   COOKIE_STORE=file   COOKIE_JAR_FILE=./.netease-cookies.json
//   COOKIE_STORE=redis  REDIS_URL=redis://127.0.0.1:6379/0
//   不设置 = 只在内存里，重启后重新扫码。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { serveNcmApi } = require('@neteasecloudmusicapienhanced/api/server');

const PORT = Number(process.env.PORT || 8080);
const UPSTREAM_PORT = Number(process.env.NCM_PORT || 3001);
const COOKIE_STORE = (process.env.COOKIE_STORE || 'memory').toLowerCase();
const COOKIE_JAR_FILE = process.env.COOKIE_JAR_FILE || path.join(process.cwd(), '.netease-cookies.json');
const REDIS_URL = process.env.REDIS_URL || '';
const REDIS_KEY = process.env.REDIS_KEY || 'folia:netease:cookies';

/** 唯一的一份登录态。和第三方客户端一致：一个部署 = 一个账号。 */
let jar = {};

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
    'Access-Control-Max-Age': '86400',
};

const jarToHeader = (cookies) => Object.entries(cookies).map(([key, value]) => `${key}=${value}`).join('; ');

const absorbSetCookie = (setCookie) => {
    let changed = false;
    for (const cookie of [].concat(setCookie || [])) {
        const [pair] = cookie.split(';');
        const index = pair.indexOf('=');
        if (index <= 0) continue;
        const key = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (jar[key] !== value) {
            jar[key] = value;
            changed = true;
        }
    }
    return changed;
};

// ── 会话持久化：三个后端，同一套接口 ────────────────────────────────

let redisClient = null;
const loadRedis = async () => {
    if (!REDIS_URL) return null;
    if (redisClient) return redisClient;
    try {
        const { createClient } = await import('redis');
        const client = createClient({ url: REDIS_URL });
        client.on('error', error => console.warn('[folia-gateway] redis error', error.message));
        await client.connect();
        redisClient = client;
        return client;
    } catch (error) {
        console.warn('[folia-gateway] redis unavailable, falling back to memory', error.message);
        return null;
    }
};

const loadCookies = async () => {
    if (COOKIE_STORE === 'file') {
        try {
            if (fs.existsSync(COOKIE_JAR_FILE)) {
                jar = JSON.parse(fs.readFileSync(COOKIE_JAR_FILE, 'utf8')) || {};
                console.log(`[folia-gateway] restored ${Object.keys(jar).length} cookies from ${COOKIE_JAR_FILE}`);
            }
        } catch (error) {
            console.warn('[folia-gateway] cookie file unreadable', error.message);
        }
        return;
    }
    if (COOKIE_STORE === 'redis') {
        const client = await loadRedis();
        if (!client) return;
        try {
            const raw = await client.get(REDIS_KEY);
            if (raw) {
                jar = JSON.parse(raw) || {};
                console.log(`[folia-gateway] restored ${Object.keys(jar).length} cookies from redis`);
            }
        } catch (error) {
            console.warn('[folia-gateway] redis read failed', error.message);
        }
    }
};

const saveCookies = async () => {
    if (COOKIE_STORE === 'file') {
        try {
            fs.writeFileSync(COOKIE_JAR_FILE, JSON.stringify(jar), { mode: 0o600 });
        } catch (error) {
            console.warn('[folia-gateway] cookie file write failed', error.message);
        }
        return;
    }
    if (COOKIE_STORE === 'redis') {
        const client = redisClient || await loadRedis();
        if (!client) return;
        try {
            await client.set(REDIS_KEY, JSON.stringify(jar));
        } catch (error) {
            console.warn('[folia-gateway] redis write failed', error.message);
        }
    }
};

// ── 转发 ────────────────────────────────────────────────────────────

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

const forward = (pathname, method, headers, body) => new Promise((resolve, reject) => {
    const request = http.request({
        host: '127.0.0.1',
        port: UPSTREAM_PORT,
        path: pathname,
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

await serveNcmApi({ port: UPSTREAM_PORT, host: '127.0.0.1' });
await loadCookies();

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`);

    if (request.method === 'OPTIONS') {
        response.writeHead(204, corsHeaders).end();
        return;
    }

    if (url.pathname === '/health') {
        const loggedIn = Boolean(jar.MUSIC_U);
        json(response, 200, {
            ok: true,
            service: 'folia-netease-gateway',
            upstream: UPSTREAM_PORT,
            loggedIn,
            store: COOKIE_STORE,
        });
        return;
    }

    if (!url.pathname.startsWith('/api/')) {
        json(response, 404, { error: 'not found' });
        return;
    }

    const headers = {
        host: `127.0.0.1:${UPSTREAM_PORT}`,
        accept: request.headers.accept || '*/*',
    };
    if (request.headers['content-type']) headers['content-type'] = request.headers['content-type'];
    if (request.headers['x-router']) headers['x-router'] = request.headers['x-router'];
    const cookieHeader = jarToHeader(jar);
    if (cookieHeader) headers.cookie = cookieHeader;

    try {
        const result = await forward(
            url.pathname.replace(/^\/api/, '') + url.search,
            request.method,
            headers,
            request.method === 'GET' || request.method === 'HEAD' ? null : await readBody(request),
        );
        if (absorbSetCookie(result.headers['set-cookie'])) void saveCookies();
        response.writeHead(result.status, {
            ...corsHeaders,
            'Content-Type': result.headers['content-type'] || 'application/json; charset=utf-8',
            'Content-Length': result.body.length,
        });
        response.end(result.body);
    } catch (error) {
        json(response, 502, { error: 'upstream unreachable', detail: String((error && error.message) || error) });
    }
});

server.listen(PORT, () => {
    console.log(`[folia-gateway] listening on :${PORT}, upstream :${UPSTREAM_PORT}, cookie store: ${COOKIE_STORE}`);
});
