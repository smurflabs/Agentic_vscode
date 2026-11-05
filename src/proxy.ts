/**
 * The local web server the chat view shows (like the Agentic desktop app's): everything that is not ours is forwarded to
 * the Agentic server with the API key added here, so the page never sees the key and needs no sign-in. Streams in both
 * directions, so chat answers (server-sent events), live updates and videos arrive as they happen. Web app pages get the
 * VS Code layer (layer.css, layer.js) added to their <head>; /vscode/* serves those files and /api/local/* is the
 * extension's own API for that layer, guarded by a per-launch token.
 */
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';
import { URL } from 'url';

export interface LocalHandler {
  (method: string, route: string, body: any, query: URLSearchParams): Promise<{
    status?: number; json?: unknown; body?: Buffer; type?: string;
    /** A server-sent event stream (Claude Code's answer): write each event; signal ends when the page goes away. */
    stream?: (write: (text: string) => void, signal: AbortSignal) => Promise<void>
  }>;
}

export interface ProxyOptions {
  /** The Agentic server's address without a trailing slash, or '' when none is set. */
  baseUrl: () => string;
  apiKey: () => string | undefined;
  /** Per-launch secret the layer sends as X-Vscode-Token with /api/local requests. */
  token: string;
  /** Tags put before </head> of every web app page. */
  headTags: () => string;
  /** /vscode/<name>: the layer's files. */
  staticFile: (name: string) => { body: Buffer; type: string } | undefined;
  /** /api/local/<route>. */
  local: LocalHandler;
  log?: (line: string) => void;
}

// Accept-Encoding is set here (pages must arrive uncompressed to add the layer); cookies are not used (the API key is).
const SKIP_REQUEST = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'cookie', 'origin', 'referer',
  'authorization', 'x-api-key', 'x-vscode-token', 'upgrade', 'proxy-connection', 'te', 'expect', 'accept-encoding']);
// HTTPS-only and framing headers from the server's front mean nothing for (or would block) the local page in VS Code.
const SKIP_RESPONSE = new Set(['transfer-encoding', 'connection', 'keep-alive', 'www-authenticate', 'set-cookie', 'server',
  'alt-svc', 'strict-transport-security', 'nel', 'report-to', 'x-frame-options', 'content-length']);

export class LocalProxy {
  private server?: http.Server;
  private _port = 0;
  private readonly agentHttp = new http.Agent({ keepAlive: true });
  private readonly agentHttps = new https.Agent({ keepAlive: true });

  constructor(private readonly o: ProxyOptions) { }

  get port(): number { return this._port; }
  get origin(): string { return `http://127.0.0.1:${this._port}`; }

  async start(): Promise<number> {
    if (this.server) return this._port;
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch(err => {
        this.o.log?.(`proxy error ${req.method} ${req.url}: ${err && err.message || err}`);
        if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); }
        try { res.end(JSON.stringify({ error: { message: String(err && err.message || err) } })); } catch { /* closed */ }
      });
    });
    // Answers stream for minutes (goals, long tool runs): no server-side timeouts.
    server.requestTimeout = 0;
    server.headersTimeout = 60000;
    server.keepAliveTimeout = 65000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this._port = (server.address() as { port: number }).port;
    return this._port;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    this.agentHttp.destroy();
    this.agentHttps.destroy();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = url.pathname;
    if (p.startsWith('/vscode/')) return this.serveStatic(p.slice('/vscode/'.length), res);
    if (p.startsWith('/api/local/')) return this.serveLocal(req, res, p.slice('/api/local/'.length), url.searchParams);
    return this.forward(req, res, url);
  }

  private serveStatic(name: string, res: http.ServerResponse): void {
    const f = /^[\w.-]+$/.test(name) ? this.o.staticFile(name) : undefined;
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': f.type, 'Cache-Control': 'no-store', 'Content-Length': f.body.length });
    res.end(f.body);
  }

  private async serveLocal(req: http.IncomingMessage, res: http.ServerResponse, route: string, query: URLSearchParams): Promise<void> {
    if (req.headers['x-vscode-token'] !== this.o.token) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Missing or wrong VS Code token.' } }));
      return;
    }
    const raw = await readBody(req);
    let body: any = undefined;
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = undefined; } }
    let r: Awaited<ReturnType<LocalHandler>>;
    try { r = await this.o.local((req.method || 'GET').toUpperCase(), route, body, query); }
    catch (e: any) { r = { status: 500, json: { error: { message: e && e.message || String(e) } } }; }
    if (r.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      const gone = new AbortController();
      res.on('close', () => gone.abort());
      try { await r.stream(text => { if (!res.writableEnded) res.write(text); }, gone.signal); }
      catch (e: any) { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type: 'agentic_error', message: e && e.message || String(e) })}\n\n`); }
      if (!res.writableEnded) res.end();
      return;
    }
    if (r.body) {
      res.writeHead(r.status || 200, { 'Content-Type': r.type || 'application/octet-stream', 'Content-Length': r.body.length });
      res.end(r.body);
      return;
    }
    const text = JSON.stringify(r.json ?? {});
    res.writeHead(r.status || 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const base = this.o.baseUrl();
    if (!base) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No Agentic server is set. Run "Agentic: Sign In" in VS Code.');
      return Promise.resolve();
    }
    const target = new URL(base + url.pathname + url.search);
    const document = isDocument(req);
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const n = name.toLowerCase();
      if (SKIP_REQUEST.has(n) || value === undefined) continue;
      // Pages are always fetched fresh: they carry this launch's token.
      if (document && (n === 'if-none-match' || n === 'if-modified-since')) continue;
      headers[n] = value;
    }
    headers['host'] = target.host;
    headers['accept-encoding'] = document ? 'identity' : 'gzip, deflate, br';
    const key = this.o.apiKey();
    if (key) headers['authorization'] = 'Bearer ' + key;

    const secure = target.protocol === 'https:';
    const client = secure ? https : http;
    return new Promise<void>((resolve) => {
      const up = client.request({
        protocol: target.protocol, hostname: target.hostname, port: target.port || (secure ? 443 : 80),
        path: target.pathname + target.search, method: req.method, headers,
        agent: secure ? this.agentHttps : this.agentHttp
      }, upRes => {
        this.relay(req, res, upRes, url, base).then(resolve, err => {
          this.o.log?.(`relay error ${url.pathname}: ${err && err.message || err}`);
          try { res.destroy(); } catch { /* gone */ }
          resolve();
        });
      });
      up.on('error', err => {
        this.o.log?.(`upstream error ${req.method} ${url.pathname}: ${err.message}`);
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
        try { res.end(JSON.stringify({ error: { message: `Cannot reach the Agentic server (${base}): ${err.message}` } })); } catch { /* closed */ }
        resolve();
      });
      // The page went away (navigation, closed view): stop the upstream request too (ends a streamed answer's reader).
      res.on('close', () => { if (!res.writableEnded) up.destroy(); });
      req.pipe(up);
    });
  }

  private async relay(req: http.IncomingMessage, res: http.ServerResponse, upRes: http.IncomingMessage, url: URL, base: string): Promise<void> {
    const status = upRes.statusCode || 502;
    const out: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(upRes.headers)) {
      const n = name.toLowerCase();
      if (SKIP_RESPONSE.has(n) || value === undefined) continue;
      if (n === 'location') { out[n] = localLocation(String(value), base); continue; }
      if (n === 'content-security-policy') { out[n] = withoutFrameAncestors(String(value)); continue; }
      out[n] = value;
    }
    const type = String(upRes.headers['content-type'] || '').toLowerCase();
    const isHtml = type.startsWith('text/html') && !url.pathname.toLowerCase().startsWith('/sandbox');

    if (isHtml && req.method !== 'HEAD') {
      // A page: add the VS Code layer before </head>.
      let bytes = await decode(await readBody(upRes), String(upRes.headers['content-encoding'] || ''));
      const html = injectHead(bytes.toString('utf8'), this.o.headTags());
      bytes = Buffer.from(html, 'utf8');
      delete out['content-encoding'];
      delete out['etag'];
      out['cache-control'] = 'no-store';
      out['content-length'] = bytes.length;
      res.writeHead(status, out);
      res.end(bytes);
      return;
    }
    if (upRes.headers['content-length'] !== undefined && !type.startsWith('text/event-stream')) out['content-length'] = upRes.headers['content-length'];
    if (type.startsWith('text/event-stream')) { out['cache-control'] = 'no-cache'; out['x-accel-buffering'] = 'no'; }
    res.writeHead(status, out);
    res.flushHeaders();
    // Piped chunk by chunk: server-sent events reach the page as they arrive, and big media respects backpressure.
    await new Promise<void>((resolve) => {
      upRes.pipe(res);
      upRes.on('end', () => resolve());
      upRes.on('error', () => { try { res.destroy(); } catch { /* gone */ } resolve(); });
      // The server went away mid-stream (it restarted): end the page's response too, so its EventSource notices and reconnects.
      upRes.on('aborted', () => { try { res.destroy(); } catch { /* gone */ } resolve(); });
      upRes.on('close', () => { if (!res.writableEnded) { try { res.end(); } catch { /* gone */ } } resolve(); });
      res.on('close', () => { upRes.destroy(); resolve(); });
    });
  }
}

function isDocument(req: http.IncomingMessage): boolean {
  const dest = String(req.headers['sec-fetch-dest'] || '');
  if (dest === 'document' || dest === 'iframe') return true;
  return (req.method === 'GET') && String(req.headers['accept'] || '').includes('text/html');
}

export function injectHead(html: string, tags: string): string {
  const at = html.search(/<\/head>/i);
  return at < 0 ? html : html.slice(0, at) + tags + html.slice(at);
}

/** A redirect to the server's own address stays inside the local page. */
export function localLocation(location: string, base: string): string {
  return location.toLowerCase().startsWith(base.toLowerCase()) ? location.slice(base.length) || '/' : location;
}

/** The page is shown inside VS Code's webview (a frame): drop a frame-ancestors rule that would refuse that. */
export function withoutFrameAncestors(csp: string): string {
  return csp.split(';').map(s => s.trim()).filter(s => s && !/^frame-ancestors\b/i.test(s)).join('; ');
}

function readBody(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function decode(bytes: Buffer, encoding: string): Promise<Buffer> {
  const e = encoding.trim().toLowerCase();
  const run = (fn: (b: Buffer, cb: (err: Error | null, r: Buffer) => void) => void) =>
    new Promise<Buffer>((resolve, reject) => fn(bytes, (err, r) => err ? reject(err) : resolve(r)));
  if (e === 'gzip' || e === 'x-gzip') return run(zlib.gunzip);
  if (e === 'deflate') return run(zlib.inflate);
  if (e === 'br') return run(zlib.brotliDecompress);
  return Promise.resolve(bytes);
}
