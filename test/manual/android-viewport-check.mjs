// test/manual/android-viewport-check.mjs
// Renders the mobile build in Chromium at phone viewports and reports what does not fit. The
// Android shell serves the page to a WebView whose CSS viewport is `physical px / dpr`, so a
// 1080x2400 phone at dpr 3 is exactly 360x800 CSS pixels - the same numbers used here.
//
//   node test/manual/android-viewport-check.mjs [width] [height] [dpr] [out.png]

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const webRoot = path.join(projectRoot, 'dist');

const width = Number(process.argv[2] || 360);
const height = Number(process.argv[3] || 800);
const dpr = Number(process.argv[4] || 3);
const output = process.argv[5] || path.join(projectRoot, `docs/android-viewport-${width}x${height}.png`);
const port = Number(process.env.SMOKE_PORT || 4174);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
    '.webmanifest': 'application/manifest+json',
};

// A real, decodable WAV: the player page is only worth measuring when playback actually starts, and
// a fake body would put an error toast over the layout.
const makeWav = (seconds = 3, rate = 8000) => {
    const samples = seconds * rate;
    const data = Buffer.alloc(samples * 2);
    for (let index = 0; index < samples; index += 1) {
        data.writeInt16LE(Math.round(Math.sin((index / rate) * 2 * Math.PI * 330) * 3000), index * 2);
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
};

const WAV = makeWav();

const server = http.createServer(async (request, response) => {
    const requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
    if (requestPath.startsWith('/saf/')) {
        response.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': WAV.length });
        response.end(WAV);
        return;
    }
    const relative = requestPath === '/' ? '/index.html' : requestPath;
    const filePath = path.join(webRoot, path.normalize(relative));
    if (!filePath.startsWith(webRoot)) {
        response.writeHead(403).end();
        return;
    }
    try {
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error('not a file');
        response.writeHead(200, {
            'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
            'Content-Length': info.size,
        });
        createReadStream(filePath).pipe(response);
    } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
});

const FAKE_NATIVE = `
(() => {
    // Skip the first-launch sequence: it has its own layout and is not what this harness measures.
    const seeded = {
        folia_last_seen_guide_version: '0.7.20',
        folia_last_seen_ponder_onboarding_version: '0.7.20',
        playback_entry_view: 'player',
        playback_entry_view_chosen: 'true',
        library_suite_prompt_seen: 'true',
    };
    try {
        for (const [key, value] of Object.entries(seeded)) localStorage.setItem(key, value);
        if (${JSON.stringify(process.env.SEAM_ANCHOR || '')}) {
            localStorage.setItem('library_wall_seam_anchor', ${JSON.stringify(process.env.SEAM_ANCHOR || '')});
        }
    } catch {}
    const tree = {
        '': [{ name: 'Test Album', dir: true }, { name: 'loose-track.mp3', dir: false }],
        'Test Album': [
            { name: '01 - Opening.mp3', dir: false },
            { name: '01 - Opening.lrc', dir: false },
            { name: 'cover.jpg', dir: false },
        ],
    };
    window.FoliaNative = {
        invoke(method, paramsJson, callbackId) {
            const params = JSON.parse(paramsJson || '{}');
            setTimeout(() => {
                const settle = (ok, payload) => window.__foliaNativeSettle(callbackId, ok, payload);
                switch (method) {
                    case 'device.info':
                        return settle(true, JSON.stringify({ sdkInt: 34, model: 'Viewport', manufacturer: 'Playwright', webViewPackage: 'fake 120', notificationsEnabled: true }));
                    case 'saf.check':
                        return settle(true, JSON.stringify({ granted: true }));
                    case 'saf.pick':
                        return settle(true, JSON.stringify({ canceled: false, uri: 'content://fake/tree/root', name: 'Fake Library' }));
                    case 'saf.list':
                        return settle(true, JSON.stringify({ ok: true, name: params.path || 'Fake Library', entries: tree[params.path || ''] || [] }));
                    case 'saf.open':
                        return settle(true, JSON.stringify({ ok: true, name: params.path, size: ${WAV.length}, modified: Date.now(), mime: 'audio/wav', token: 'token-' + Date.now() }));
                    default:
                        return settle(true, JSON.stringify({ ok: true }));
                }
            }, 5);
        },
    };
})();
`;

// The three numbers that decide whether a phone layout is broken: horizontal overflow, the narrowest
// interactive target, and anything that sticks out of the viewport.
const MEASURE = `(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const overflowing = [];
    for (const element of document.querySelectorAll('body *')) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right > vw + 1 || rect.left < -1) {
            overflowing.push({
                tag: element.tagName,
                cls: String(element.className).slice(0, 48),
                left: Math.round(rect.left),
                right: Math.round(rect.right),
            });
            if (overflowing.length >= 8) break;
        }
    }
    const targets = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .map(element => {
            const rect = element.getBoundingClientRect();
            return { w: Math.round(rect.width), h: Math.round(rect.height), text: (element.innerText || element.getAttribute('aria-label') || '').trim().slice(0, 12) };
        })
        .filter(target => target.w > 0 && target.h > 0);
    const small = targets.filter(target => target.w < 40 || target.h < 40).slice(0, 8);
    return {
        viewport: [vw, vh],
        dpr: window.devicePixelRatio,
        scrollWidth: document.documentElement.scrollWidth,
        horizontalOverflow: document.documentElement.scrollWidth > vw + 1,
        overflowing,
        interactiveCount: targets.length,
        smallTargets: small,
    };
})()`;

const main = async () => {
    await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', error => (error ? reject(error) : resolve())));
    const browser = await chromium.launch({ channel: 'chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ content: FAKE_NATIVE });
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 90_000 });
    await page.waitForFunction(() => !document.getElementById('app-splash'), undefined, { timeout: 90_000 }).catch(() => undefined);
    await page.waitForTimeout(2500);

    const closeButton = page.getByRole('button', { name: /关闭|Close/i }).first();
    if (await closeButton.count() > 0) {
        await closeButton.click({ timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(800);
    }

    // VIEW=settings renders the settings surface, which is the layout most at risk on a narrow
    // screen: it is a full-height sheet with its own sidebar.
    if (process.env.VIEW === 'settings') {
        await page.evaluate(() => {
            const settings = document.querySelector('[aria-label="设置"]');
            settings?.click();
        });
        await page.waitForTimeout(1500);
        const tab = process.env.SETTINGS_TAB;
        if (tab) {
            await page.evaluate((wanted) => {
                const candidates = Array.from(document.querySelectorAll('button, [role="tab"]'))
                    .filter(element => (element.innerText || '').trim() === wanted);
                candidates[0]?.click();
            }, tab);
            await page.waitForTimeout(1200);
        }
    }

    // VIEW=player imports the fake library through the SAF bridge and starts playback, so the
    // full-screen lyric stage can be measured at this viewport.
    if (process.env.VIEW === 'player') {
        const clickByText = async (text) => {
            await page.evaluate((wanted) => {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
                    .filter(element => (element.innerText || '').trim().includes(wanted));
                candidates.sort((left, right) => (left.innerText || '').length - (right.innerText || '').length);
                candidates[0]?.click();
            }, text);
            await page.waitForTimeout(1200);
        };
        const clickByLabel = async (label) => {
            await page.evaluate((wanted) => {
                Array.from(document.querySelectorAll('button'))
                    .find(element => element.getAttribute('aria-label') === wanted)?.click();
            }, label);
            await page.waitForTimeout(1200);
        };

        await clickByText('本地');
        await clickByLabel('更多');
        await clickByText('导入文件夹');
        await page.waitForTimeout(4000);
        await clickByText('全部歌曲');
        await clickByText('播放全部');
        await page.waitForTimeout(2500);
    }

    const report = await page.evaluate(MEASURE);
    if (process.env.EVAL) {
        console.log(JSON.stringify(await page.evaluate(process.env.EVAL), null, 2));
    }
    await page.screenshot({ path: output });
    await browser.close();
    await new Promise(resolve => server.close(resolve));

    console.log(JSON.stringify({ ...report, errors: errors.slice(0, 5), screenshot: output }, null, 2));
};

await main();
