/**
 * Sign-in for hosted MCP servers (OAuth 2.1, as the MCP specification and Claude Code do it):
 *  - the server's 401 names its protected-resource metadata (or it is at /.well-known/oauth-protected-resource), which names
 *    the authorization server; that server's metadata gives the endpoints
 *  - the app registers itself (dynamic client registration) unless the config gives a client id
 *  - the browser signs in (authorization code with PKCE) and comes back to a one-time server on 127.0.0.1
 *  - tokens are kept in VS Code's secret storage and refreshed before they run out
 * No VS Code import here, so node --test can run it against a fake server.
 */
import * as http from 'http';
import { createHash, randomBytes } from 'crypto';

export interface SecretsLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

/** Fixed OAuth settings from the server's config ("oauth": {clientId, clientSecret, scope, callbackPort}). */
export interface OAuthConfig { clientId?: string; clientSecret?: string; scope?: string; callbackPort?: number }

interface Endpoints { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; scope?: string; resource: string }
interface Saved {
  access_token: string; refresh_token?: string; expires_at?: number; token_type?: string;
  client_id: string; client_secret?: string; token_endpoint: string; resource: string; issuer: string;
}

/** A plain in-memory store (tests, or when VS Code gives none). */
export class MemorySecrets implements SecretsLike {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.map.get(key); }
  async store(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
}

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function getJson(url: string): Promise<any | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'MCP-Protocol-Version': '2025-06-18' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** The resource a token is for: the server URL without query or fragment (RFC 8707). */
export function canonicalResource(serverUrl: string): string {
  const u = new URL(serverUrl);
  u.hash = ''; u.search = '';
  const s = u.toString();
  return u.pathname === '/' ? s.replace(/\/$/, '') : s;
}

/** Where to sign in for this server: protected-resource metadata, then the authorization server's metadata (or the usual paths). */
export async function discoverEndpoints(serverUrl: string, wwwAuthenticate?: string): Promise<Endpoints> {
  const u = new URL(serverUrl);
  const origin = u.origin;
  const path = u.pathname.replace(/\/$/, '');
  const named = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate || '');
  const scopeHint = /scope="([^"]+)"/i.exec(wwwAuthenticate || '');
  let prm: any = null;
  for (const c of [named ? new URL(named[1], serverUrl).toString() : '', path ? `${origin}/.well-known/oauth-protected-resource${path}` : '', `${origin}/.well-known/oauth-protected-resource`]) {
    if (!c) continue;
    prm = await getJson(c);
    if (prm) break;
  }
  const issuer = String(prm && Array.isArray(prm.authorization_servers) && prm.authorization_servers[0] || origin).replace(/\/$/, '');
  const iu = new URL(issuer);
  const ipath = iu.pathname.replace(/\/$/, '');
  const candidates = ipath
    ? [`${iu.origin}/.well-known/oauth-authorization-server${ipath}`, `${iu.origin}/.well-known/openid-configuration${ipath}`, `${issuer}/.well-known/openid-configuration`]
    : [`${iu.origin}/.well-known/oauth-authorization-server`, `${iu.origin}/.well-known/openid-configuration`];
  let as: any = null;
  for (const c of candidates) { as = await getJson(c); if (as && as.authorization_endpoint) break; as = null; }
  const scopes = scopeHint ? scopeHint[1] : prm && Array.isArray(prm.scopes_supported) ? prm.scopes_supported.join(' ') : undefined;
  return {
    issuer,
    authorization_endpoint: as ? as.authorization_endpoint : `${iu.origin}/authorize`,
    token_endpoint: as ? as.token_endpoint : `${iu.origin}/token`,
    registration_endpoint: as ? as.registration_endpoint : `${iu.origin}/register`,
    scope: scopes,
    resource: prm && prm.resource ? String(prm.resource) : canonicalResource(serverUrl)
  };
}

/** A one-time server on 127.0.0.1 that receives the browser's redirect (code and state). */
function callbackServer(port: number): Promise<{ port: number; wait: (state: string, ms: number) => Promise<string>; close: () => void }> {
  return new Promise((resolve, reject) => {
    let got: ((q: URLSearchParams) => void) | null = null;
    const early: URLSearchParams[] = [];
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const ok = url.searchParams.has('code');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Agentic</title><body style="font:16px system-ui;padding:40px">` +
        (ok ? '<b>Signed in.</b> You can close this tab and go back to Agentic.' : '<b>Sign-in failed:</b> ' + String(url.searchParams.get('error_description') || url.searchParams.get('error') || 'no code').replace(/[<>&]/g, '')) + '</body>');
      if (got) got(url.searchParams); else early.push(url.searchParams);
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: actual,
        close: () => server.close(),
        wait: (state, ms) => new Promise<string>((ok, fail) => {
          const timer = setTimeout(() => fail(new Error('The sign-in was not finished within ' + Math.round(ms / 60000) + ' minutes.')), ms);
          const handle = (q: URLSearchParams) => {
            if (q.get('state') !== state) return;
            clearTimeout(timer);
            const code = q.get('code');
            if (code) ok(code); else fail(new Error('Sign-in refused: ' + (q.get('error_description') || q.get('error') || 'no code')));
          };
          got = handle;
          for (const q of early.splice(0)) handle(q);
        })
      });
    });
  });
}

async function postForm(url: string, form: Record<string, string>, basic?: { id: string; secret: string }): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (basic) headers.Authorization = 'Basic ' + Buffer.from(`${encodeURIComponent(basic.id)}:${encodeURIComponent(basic.secret)}`).toString('base64');
  const res = await fetch(url, { method: 'POST', headers, body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  let j: any = null; try { j = JSON.parse(text); } catch { j = Object.fromEntries(new URLSearchParams(text)); }
  if (!res.ok || !j || j.error) throw new Error(`The token endpoint refused: ${j && (j.error_description || j.error) || 'HTTP ' + res.status}`);
  return j;
}

export class McpOAuth {
  constructor(private readonly secrets: SecretsLike, private readonly openBrowser: (url: string) => unknown,
    private readonly log: (s: string) => void = () => { }) { }

  private key(serverUrl: string): string { return 'agentic.mcp.oauth:' + canonicalResource(serverUrl); }

  private async load(serverUrl: string): Promise<Saved | null> {
    try { const t = await this.secrets.get(this.key(serverUrl)); return t ? JSON.parse(t) as Saved : null; } catch { return null; }
  }

  async signedIn(serverUrl: string): Promise<boolean> { return !!(await this.load(serverUrl)); }

  async signOut(serverUrl: string): Promise<void> { await this.secrets.delete(this.key(serverUrl)); }

  /** The access token to send (refreshed when it runs out within a minute); undefined when not signed in or refresh failed. */
  async token(serverUrl: string, forceRefresh = false): Promise<string | undefined> {
    const s = await this.load(serverUrl);
    if (!s) return undefined;
    if (!forceRefresh && (!s.expires_at || s.expires_at > Date.now() + 60_000)) return s.access_token;
    if (!s.refresh_token) return forceRefresh ? undefined : s.access_token;
    try {
      const form: Record<string, string> = { grant_type: 'refresh_token', refresh_token: s.refresh_token, client_id: s.client_id, resource: s.resource };
      if (s.client_secret) form.client_secret = s.client_secret;
      const j = await postForm(s.token_endpoint, form);
      const next: Saved = { ...s, access_token: j.access_token, refresh_token: j.refresh_token || s.refresh_token,
        expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined, token_type: j.token_type };
      await this.secrets.store(this.key(serverUrl), JSON.stringify(next));
      return next.access_token;
    } catch (e) {
      this.log(`MCP sign-in refresh for ${serverUrl} failed: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  }

  /** Signs in through the browser and keeps the tokens. */
  async signIn(serverUrl: string, wwwAuthenticate?: string, cfg: OAuthConfig = {}, timeoutMs = 300_000): Promise<string> {
    const ep = await discoverEndpoints(serverUrl, wwwAuthenticate);
    const cb = await callbackServer(cfg.callbackPort || 0);
    try {
      const redirect = `http://127.0.0.1:${cb.port}/callback`;
      let clientId = cfg.clientId, clientSecret = cfg.clientSecret;
      if (!clientId) {
        if (!ep.registration_endpoint) throw new Error('This server does not let apps register themselves: give "oauth": {"clientId": …} in its config.');
        const res = await fetch(ep.registration_endpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, signal: AbortSignal.timeout(30000),
          body: JSON.stringify({ client_name: 'Agentic', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' })
        });
        const j: any = await res.json().catch(() => null);
        if (!res.ok || !j || !j.client_id) throw new Error(`The server refused to register Agentic: ${j && (j.error_description || j.error) || 'HTTP ' + res.status}`);
        clientId = String(j.client_id);
        if (j.client_secret) clientSecret = String(j.client_secret);
      }
      const verifier = b64url(randomBytes(48));
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      const state = b64url(randomBytes(16));
      const auth = new URL(ep.authorization_endpoint);
      const q: Record<string, string> = { response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state, resource: ep.resource };
      const scope = cfg.scope || ep.scope;
      if (scope) q.scope = scope;
      for (const [k, v] of Object.entries(q)) auth.searchParams.set(k, v);
      this.log(`MCP sign-in: opening ${auth.origin} for ${serverUrl}`);
      await this.openBrowser(auth.toString());
      const code = await cb.wait(state, timeoutMs);
      const form: Record<string, string> = { grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: ep.resource };
      if (clientSecret) form.client_secret = clientSecret;
      const j = await postForm(ep.token_endpoint, form);
      if (!j.access_token) throw new Error('The token endpoint sent no access token.');
      const saved: Saved = { access_token: j.access_token, refresh_token: j.refresh_token, token_type: j.token_type,
        expires_at: j.expires_in ? Date.now() + Number(j.expires_in) * 1000 : undefined,
        client_id: clientId, client_secret: clientSecret, token_endpoint: ep.token_endpoint, resource: ep.resource, issuer: ep.issuer };
      await this.secrets.store(this.key(serverUrl), JSON.stringify(saved));
      return saved.access_token;
    } finally { cb.close(); }
  }
}
