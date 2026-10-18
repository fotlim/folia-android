// test/manual/fake-backend.mjs
// A stand-in for the self-hosted music APIs, used to check that Android discovery finds a backend on
// the network and that the WebView is allowed to talk plain http to it. Answers the health paths the
// providers probe, on the ports those services use by default.
//
//   node test/manual/fake-backend.mjs [--host 0.0.0.0] [--port 3400]

import http from 'node:http';

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const host = readArg('host', '0.0.0.0');
const ports = [Number(readArg('port', '3400'))];

const server = http.createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://localhost');
    const payload = {
        status: 1,
        code: 200,
        message: 'fake backend',
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
    };
    const body = JSON.stringify(payload);
    response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Access-Control-Allow-Origin': '*',
    });
    response.end(body);
    console.log(`[fake-backend] ${request.method} ${request.url} -> 200`);
});

for (const port of ports) {
    server.listen(port, host, () => console.log(`[fake-backend] listening on http://${host}:${port}`));
}
