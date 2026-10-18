// test/manual/android-shell-smoke.mjs
// Boots the mobile build in Chromium with a fake `FoliaNative` host, so the parts of the Android
// port that live in JavaScript - the bridge, the SAF directory picker, the media-session hook - get
// exercised without a device. Not a replacement for the on-device checklist; it catches "the app
// does not start at all" and "the shim is not installed" before anyone installs an APK.

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const webRoot = path.join(projectRoot, 'dist');
const port = Number(process.env.SMOKE_PORT || 4173);

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

const server = http.createServer(async (request, response) => {
    const requestPath = decodeURIComponent((request.url || '/').split('?')[0]);

    // The shell streams a picked document through /saf/<token>; answer it with bytes so `getFile()`
    // is exercised end to end.
    if (requestPath.startsWith('/saf/')) {
        const body = Buffer.from('fake audio payload');
        response.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': body.length });
        response.end(body);
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

// The fake shell: a directory tree with one "mp3" and one ".lrc", plus the media hooks the app calls.
const FAKE_TREE = {
    '': [
        { name: 'Test Album', dir: true },
        { name: 'loose-track.mp3', dir: false },
    ],
    'Test Album': [
        { name: '01 - Opening.mp3', dir: false },
        { name: '01 - Opening.lrc', dir: false },
        { name: 'cover.jpg', dir: false },
    ],
};

const FAKE_NATIVE = `
(() => {
    const timers = new Map();
    window.__foliaSmokeLog = [];
    const tree = ${JSON.stringify(FAKE_TREE)};
    const settle = (id, ok, payload) => {
        if (!window.__foliaNativeSettle) {
            timers.set(id, () => window.__foliaNativeSettle(id, ok, payload));
            return;
        }
        window.__foliaNativeSettle(id, ok, payload);
    };
    window.FoliaNative = {
        invoke(method, paramsJson, callbackId) {
            window.__foliaSmokeLog.push(method);
            const params = JSON.parse(paramsJson || '{}');
            setTimeout(() => {
                switch (method) {
                    case 'device.info':
                        return settle(callbackId, true, JSON.stringify({ sdkInt: 34, model: 'Smoke', manufacturer: 'Playwright', webViewPackage: 'fake 120', notificationsEnabled: true }));
                    case 'saf.check':
                        return settle(callbackId, true, JSON.stringify({ granted: true }));
                    case 'saf.pick':
                        return settle(callbackId, true, JSON.stringify({ canceled: false, uri: 'content://fake/tree/root', name: 'Fake Library' }));
                    case 'saf.list': {
                        const entries = tree[params.path || ''] || [];
                        return settle(callbackId, true, JSON.stringify({ ok: true, name: params.path || 'Fake Library', entries }));
                    }
                    case 'saf.open':
                        return settle(callbackId, true, JSON.stringify({ ok: true, name: params.path, size: 1024, modified: Date.now(), mime: 'audio/mpeg', token: 'token-' + Date.now() }));
                    case 'media.update':
                    case 'media.clear':
                    case 'notifications.request':
                    case 'app.background':
                    case 'saf.release':
                    case 'servers.openSettings':
                        return settle(callbackId, true, JSON.stringify({ ok: true }));
                    default:
                        return settle(callbackId, false, JSON.stringify({ message: 'unknown ' + method }));
                }
            }, 5);
        },
    };
    window.addEventListener('DOMContentLoaded', () => {
        for (const [id, run] of timers) {
            if (window.__foliaNativeSettle) {
                timers.delete(id);
                run();
            }
        }
    });
})();
`;

const main = async () => {
    await new Promise((resolve, reject) => server.listen(port, '127.0.0.1', error => (error ? reject(error) : resolve())));

    // `channel: 'chromium'` selects the full Chromium build (the same engine family as the Android
    // WebView) instead of Playwright's headless shell.
    const browser = await chromium.launch({
        channel: 'chromium',
        args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    });
    const page = await browser.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 });

    const errors = [];
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => {
        const text = message.text();
        if (message.type() === 'error') errors.push(`console: ${text}`);
    });

    await page.addInitScript({ content: FAKE_NATIVE });
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load', timeout: 90_000 });

    await page.waitForFunction(
        () => !document.getElementById('app-splash') || document.getElementById('app-splash')?.classList.contains('is-hiding'),
        undefined,
        { timeout: 90_000 },
    ).catch(() => undefined);

    await page.waitForTimeout(2500);

    // First run shows the release notes over the home screen; dismiss them so the screenshot shows
    // the actual layout at phone size.
    const closeButton = page.getByRole('button', { name: /关闭|Close/i }).first();
    if (await closeButton.count() > 0) {
        await closeButton.click({ timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(600);
    }

    const probe = await page.evaluate(() => ({
        nativeSettleInstalled: typeof window.__foliaNativeSettle === 'function',
        transportHookInstalled: typeof window.__foliaNativeTransport === 'function',
        backHookInstalled: typeof window.__foliaNativeBackPressed === 'function',
        directoryPickerInstalled: typeof window.showDirectoryPicker === 'function'
            && String(window.showDirectoryPicker).includes('saf.pick'),
        shellDataset: document.documentElement.dataset.foliaShell || null,
        rootChildren: document.getElementById('root')?.childElementCount ?? 0,
        splashVisible: Boolean(document.getElementById('app-splash')),
        calls: (window.__foliaSmokeLog || []).slice(0, 12),
    }));

    // Drive the SAF shim the way `localMusicService` does: pick a directory, walk it, descend into a
    // subdirectory, resolve one file handle, and read its contents through the stream route.
    const safProbe = { root: [], sub: [], file: null };
    safProbe.root = await page.evaluate(async () => {
        const handle = await window.showDirectoryPicker();
        const names = [];
        for await (const entry of handle.values()) names.push(`${entry.kind}:${entry.name}`);
        return names;
    });
    safProbe.sub = await page.evaluate(async () => {
        const handle = await window.showDirectoryPicker();
        const album = await handle.getDirectoryHandle('Test Album');
        const names = [];
        for await (const entry of album.values()) names.push(entry.name);
        const fileHandle = await album.getFileHandle('01 - Opening.lrc');
        return names.map(name => `${name} (${fileHandle.name})`);
    });

    // `getFile()` is what the import and playback paths call; it goes through the stream route.
    safProbe.file = await page.evaluate(async () => {
        const handle = await window.showDirectoryPicker();
        const album = await handle.getDirectoryHandle('Test Album');
        const fileHandle = await album.getFileHandle('loose.mp3').catch(() => album.getFileHandle('01 - Opening.mp3'));
        const file = await fileHandle.getFile();
        return { name: file.name, size: file.size, type: file.type, text: await file.text() };
    });

    const screenshotPath = path.join(projectRoot, 'docs', 'android-smoke.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });

    await browser.close();
    await new Promise(resolve => server.close(resolve));

    const report = { probe, safProbe, errors: errors.slice(0, 20), screenshotPath };
    console.log(JSON.stringify(report, null, 2));

    const failed = !probe.nativeSettleInstalled
        || !probe.directoryPickerInstalled
        || !probe.backHookInstalled
        || probe.rootChildren === 0
        || (probe.splashVisible && probe.rootChildren === 0)
        || safProbe.root.length !== 2
        || safProbe.sub.length !== 3
        || safProbe.file?.size !== 18;
    process.exit(failed ? 1 : 0);
};

await main();
