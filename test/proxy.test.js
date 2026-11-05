// The local proxy against a fake Agentic server: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const zlib = require('zlib');
const { LocalProxy, withoutFrameAncestors, localLocation, injectHead } = require('../out/proxy');

function fakeServer() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === '/chat') {
        const html = '<!doctype html><html><head><title>Agentic</title></head><body>app</body></html>';
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Content-Encoding': 'gzip', 'ETag': '"abc"',
          'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; img-src *",
          'Set-Cookie': 'sid=1', 'Strict-Transport-Security': 'max-age=1'
        });
        res.end(zlib.gzipSync(html));
      } else if (req.url === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let n = 0;
        const t = setInterval(() => {
          n++;
          res.write(`event: delta\ndata: {"n":${n}}\n\n`);
          if (n === 3) { clearInterval(t); res.end(); }
        }, 150);
      } else if (req.url === '/api/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ auth: req.headers.authorization, cookie: req.headers.cookie || null, body }));
      } else if (req.url === '/redir') {
        res.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/chat` });
        res.end();
      } else {
        res.writeHead(404); res.end();
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      const chunks = []; const times = [];
      res.on('data', c => { chunks.push(c); times.push(Date.now()); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8'), times }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('proxy: pages get the layer; keys, cookies and framing blockers are handled', async (t) => {
  const up = await fakeServer();
  const localCalls = [];
  const proxy = new LocalProxy({
    baseUrl: () => up.base, apiKey: () => 'k123', token: 'tok',
    headTags: () => '<script src="/vscode/layer.js" defer></script>',
    staticFile: name => name === 'layer.js' ? { body: Buffer.from('/*layer*/'), type: 'text/javascript' } : undefined,
    local: async (method, route, body) => { localCalls.push({ method, route, body }); return { json: { ok: true, route } }; }
  });
  const port = await proxy.start();
  t.after(() => { proxy.stop(); up.server.close(); });

  // A page: decompressed, layer injected before </head>, fresh, and framable inside VS Code.
  const page = await request(port, 'GET', '/chat', { headers: { Accept: 'text/html', Cookie: 'sid=browser', 'Accept-Encoding': 'gzip, zstd' } });
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /<script src="\/vscode\/layer.js" defer><\/script><\/head>/);
  assert.strictEqual(page.headers['content-encoding'], undefined);
  assert.strictEqual(page.headers['etag'], undefined);
  assert.strictEqual(page.headers['x-frame-options'], undefined);
  assert.strictEqual(page.headers['set-cookie'], undefined);
  assert.strictEqual(page.headers['strict-transport-security'], undefined);
  assert.strictEqual(page.headers['cache-control'], 'no-store');
  assert.doesNotMatch(page.headers['content-security-policy'], /frame-ancestors/);
  assert.match(page.headers['content-security-policy'], /img-src \*/);
  const sentPage = up.seen.find(s => s.url === '/chat');
  assert.strictEqual(sentPage.headers['accept-encoding'], 'identity');
  assert.strictEqual(sentPage.headers.authorization, 'Bearer k123');
  assert.strictEqual(sentPage.headers.cookie, undefined);

  // API calls carry the key, never the browser's cookie or its own Authorization.
  const echo = await request(port, 'POST', '/api/echo', { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer page-supplied', Cookie: 'x=1' }, body: '{"hello":1}' });
  assert.deepStrictEqual(JSON.parse(echo.text), { auth: 'Bearer k123', cookie: null, body: '{"hello":1}' });

  // Server-sent events arrive as they are written, not all at the end.
  const sse = await request(port, 'GET', '/api/stream', { headers: { Accept: 'text/event-stream' } });
  assert.strictEqual((sse.text.match(/event: delta/g) || []).length, 3);
  assert.ok(sse.times.length >= 2, 'streamed in more than one chunk');
  assert.ok(sse.times[sse.times.length - 1] - sse.times[0] >= 200, 'chunks spread over time');

  // Redirects to the server's own address stay on the local page.
  const redir = await request(port, 'GET', '/redir');
  assert.strictEqual(redir.status, 302);
  assert.strictEqual(redir.headers.location, '/chat');

  // The layer's files, and nothing else under /vscode/.
  assert.strictEqual((await request(port, 'GET', '/vscode/layer.js')).text, '/*layer*/');
  assert.strictEqual((await request(port, 'GET', '/vscode/..%2Fpackage.json')).status, 404);
  assert.strictEqual((await request(port, 'GET', '/vscode/other.js')).status, 404);

  // /api/local needs this launch's token.
  assert.strictEqual((await request(port, 'POST', '/api/local/chat/prepare', { body: '{}' })).status, 403);
  assert.strictEqual((await request(port, 'POST', '/api/local/chat/prepare', { headers: { 'X-Vscode-Token': 'wrong' }, body: '{}' })).status, 403);
  const ok = await request(port, 'POST', '/api/local/chat/run', { headers: { 'X-Vscode-Token': 'tok', 'Content-Type': 'application/json' }, body: '{"name":"read_file"}' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(localCalls.pop(), { method: 'POST', route: 'chat/run', body: { name: 'read_file' } });
  // The token never reaches the Agentic server.
  assert.ok(up.seen.every(s => s.headers['x-vscode-token'] === undefined));
});

test('proxy: an unreachable server is a clear 502, no server set is a 503', async (t) => {
  let base = 'http://127.0.0.1:1';
  const proxy = new LocalProxy({ baseUrl: () => base, apiKey: () => 'k', token: 't', headTags: () => '', staticFile: () => undefined, local: async () => ({ json: {} }) });
  const port = await proxy.start();
  t.after(() => proxy.stop());
  const down = await request(port, 'GET', '/api/chat/meta');
  assert.strictEqual(down.status, 502);
  assert.match(JSON.parse(down.text).error.message, /Cannot reach the Agentic server/);
  base = '';
  assert.strictEqual((await request(port, 'GET', '/chat')).status, 503);
});

test('header helpers', () => {
  assert.strictEqual(withoutFrameAncestors("default-src 'self'; frame-ancestors 'none'"), "default-src 'self'");
  assert.strictEqual(localLocation('https://a.example/chat?x=1', 'https://a.example'), '/chat?x=1');
  assert.strictEqual(localLocation('https://other/x', 'https://a.example'), 'https://other/x');
  assert.strictEqual(injectHead('<html><HEAD></HEAD></html>', 'X'), '<html><HEAD>X</HEAD></html>');
  assert.strictEqual(injectHead('<p>no head</p>', 'X'), '<p>no head</p>');
});

test('proxy: a live stream ends for the page when the server goes away mid-stream (it then reconnects)', async () => {
  // The server sends one event, then its process dies (the socket is cut, no proper end).
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: hello\ndata: {}\n\n');
    setTimeout(() => req.socket.destroy(), 200);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const proxy = new LocalProxy({ baseUrl: () => base, apiKey: () => 'k', token: 't', headTags: () => '', staticFile: () => undefined, local: async () => ({ json: {} }) });
  const port = await proxy.start();
  try {
    const ended = await Promise.race([
      new Promise(resolve => {
        const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/events/stream' }, res => {
          res.on('data', () => { });
          res.on('end', () => resolve('ended'));
          res.on('error', () => resolve('ended'));
          res.on('aborted', () => resolve('ended'));
          res.on('close', () => resolve('ended'));
        });
        req.on('error', () => resolve('ended'));
        req.end();
      }),
      new Promise(resolve => setTimeout(() => resolve('hanging'), 4000))
    ]);
    assert.strictEqual(ended, 'ended');
  } finally { proxy.stop(); server.close(); }
});
