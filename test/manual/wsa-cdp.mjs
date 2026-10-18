// test/manual/wsa-cdp.mjs
// Drives the Folia WebView running under WSA through its Chrome DevTools endpoint, using the raw
// protocol: Playwright's CDP client expects browser-context management that a WebView does not
// implement, but Runtime.evaluate and Input.dispatchMouseEvent are enough.
//
//   adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
//   node test/manual/wsa-cdp.mjs text
//   node test/manual/wsa-cdp.mjs tap "下一步"      # trusted touch press at the element centre
//   node test/manual/wsa-cdp.mjs tapxy 800 560
//   node test/manual/wsa-cdp.mjs eval "document.title"

import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';

const [, , action, ...rest] = process.argv;
const argument = rest.join(' ');
const endpoint = process.env.WSA_CDP || 'http://127.0.0.1:9222';

const getJson = (path) => new Promise((resolve, reject) => {
    http.get(`${endpoint}${path}`, response => {
        let body = '';
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });
    }).on('error', reject);
});

const connect = async () => {
    const targets = await getJson('/json');
    const page = targets.find(target => String(target.url).includes('appassets')) ?? targets[0];
    if (!page?.webSocketDebuggerUrl) throw new Error('No debuggable WebView page found');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
    });

    let id = 0;
    const pending = new Map();
    socket.on('message', raw => {
        const message = JSON.parse(String(raw));
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
    });

    const send = (method, params) => new Promise((resolve, reject) => {
        id += 1;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });

    const evaluate = async (expression) => {
        const result = await send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true,
        });
        if (result.exceptionDetails) {
            throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        }
        return result.result?.value;
    };

    return { socket, send, evaluate };
};

const main = async () => {
    const { socket, send, evaluate } = await connect();

    // A real press and release at the element's centre: `element.click()` misses controls that only
    // react to pointer events, and this is also what a finger produces on the device.
    const tapAt = async (x, y) => {
        const base = { x, y, button: 'left', clickCount: 1 };
        await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
        await new Promise(resolve => setTimeout(resolve, 60));
        await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
    };

    const centreOfText = (text) => evaluate(`(() => {
        const wanted = ${JSON.stringify(text)};
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
            .filter(element => (element.innerText || '').trim().includes(wanted))
            .filter(element => element.getBoundingClientRect().width > 0)
            .sort((left, right) => (left.innerText || '').length - (right.innerText || '').length);
        const match = candidates[0];
        if (!match) return null;
        const rect = match.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: (match.innerText || '').trim().slice(0, 40) };
    })()`);

    switch (action) {
        case 'text': {
            const text = await evaluate('(document.body.innerText || "").replace(/\\n{2,}/g, "\\n")');
            console.log(String(text).slice(0, 5000));
            break;
        }
        case 'click': {
            const clicked = await evaluate(`(() => {
                const wanted = ${JSON.stringify(argument)};
                const candidates = Array.from(document.querySelectorAll('button, [role="button"], a, div, span'))
                    .filter(element => (element.innerText || '').trim().includes(wanted))
                    .sort((left, right) => (left.innerText || '').length - (right.innerText || '').length);
                if (!candidates.length) return false;
                candidates[0].click();
                return true;
            })()`);
            if (!clicked) throw new Error(`Nothing clickable contains "${argument}"`);
            console.log('clicked');
            break;
        }
        case 'tap': {
            const centre = await centreOfText(argument);
            if (!centre) throw new Error(`No element contains "${argument}"`);
            await tapAt(centre.x, centre.y);
            console.log(`tapped ${centre.text} at ${Math.round(centre.x)},${Math.round(centre.y)}`);
            break;
        }
        case 'tapxy': {
            const [x, y] = rest.map(Number);
            await tapAt(x, y);
            console.log(`tapped ${x},${y}`);
            break;
        }
        case 'eval': {
            const value = await evaluate(argument);
            console.log(JSON.stringify(value, null, 2));
            break;
        }
        case 'key': {
            const key = argument || 'Escape';
            await send('Input.dispatchKeyEvent', {
                type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0,
            });
            await send('Input.dispatchKeyEvent', {
                type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'Escape' ? 27 : 0,
            });
            console.log(`pressed ${key}`);
            break;
        }
        case 'shot': {
            // Captures the WebView itself (no WSA window clipping), at the device pixel ratio.
            const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
            const output = argument || 'wsa-shot.png';
            await writeFile(output, Buffer.from(result.data, 'base64'));
            console.log(`wrote ${output}`);
            break;
        }
        case 'wait': {
            await new Promise(resolve => setTimeout(resolve, Number(argument || 1000)));
            console.log('waited');
            break;
        }
        default:
            console.log('usage: node test/manual/wsa-cdp.mjs <text|click|tap|tapxy|eval|wait> [argument]');
    }

    socket.close();
};

await main();
