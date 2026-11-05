/**
 * Local MCP servers for the chat, like Claude Code's. Servers come from every place they are usually set up, live (no import):
 *  - Agentic: ~/.agentic/mcp.json (also the CLI's), and the project's .mcp.json and .agentic/mcp.json
 *  - Claude Code: ~/.claude.json (user servers and this project's), installed plugins' servers, Claude Desktop's config
 *  - VS Code: .vscode/mcp.json, the user's mcp.json and the "mcp" setting (${input:…} values asked once, kept as secrets)
 * A project's servers (its .mcp.json, .vscode/mcp.json) start only after the user allowed them once: a cloned repository
 * must not run commands by itself. Transports: stdio, Streamable HTTP and the older HTTP+SSE; hosted servers can sign in with
 * OAuth (mcpAuth.ts). Servers start in the background, all at once; a message waits a few seconds at most for them.
 * No VS Code import here, so node --test runs it.
 */
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { commandEnv } from './extras';
import { McpOAuth, OAuthConfig } from './mcpAuth';
import { enabledPlugins } from './plugins';

export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpState = 'off' | 'approval' | 'input' | 'starting' | 'connected' | 'failed' | 'signin';

/** One configured server, as found (values not expanded yet). */
export interface McpSpec {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string;
  args: string[];
  env: Record<string, string>;
  envFile?: string;
  cwd?: string;
  url?: string;
  headers: Record<string, string>;
  enabled: boolean;
  timeoutSeconds: number;
  requireApproval: boolean;
  oauth?: OAuthConfig;
  /** Where it was found ("Agentic", "Project .mcp.json", "Claude Code", "Claude Code plugin x", "VS Code", …). */
  source: string;
  file: string;
  /** In a file this app edits (~/.agentic/mcp.json, the project's .mcp.json / .agentic/mcp.json). */
  editable: boolean;
  /** From a project's files: started only once the user allowed it. */
  project: boolean;
  root?: string;
  /** VS Code ${input:…} prompts the server needs. */
  inputs: { id: string; description: string; password: boolean }[];
  pluginRoot?: string;
  /** The server's name in its file (the id can differ, e.g. plugin_x_y). */
  key: string;
}

export interface McpToolInfo { name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> }
export interface McpImage { mediaType: string; data: string }
export interface McpCallResult { ok: boolean; result: string; images: McpImage[] }

export interface StateLike { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> | Promise<void> }
export interface SecretsLike {
  get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
  store(key: string, value: string): Thenable<void> | Promise<void>;
  delete(key: string): Thenable<void> | Promise<void>;
}

export interface McpManagerOptions {
  roots: () => string[];
  log: (s: string) => void;
  state?: StateLike;
  secrets?: SecretsLike;
  /** Claude Code's and Claude Desktop's servers (setting agentic.mcp.includeClaude). */
  includeClaude?: () => boolean;
  /** VS Code's own MCP servers (setting agentic.mcp.includeVsCode). */
  includeVsCode?: () => boolean;
  /** VS Code's "mcp" setting: {servers, inputs}. */
  vscodeSetting?: () => any;
  /** VS Code's user folder (its mcp.json). */
  vscodeUserDir?: () => string | undefined;
  openBrowser?: (url: string) => unknown;
  /**
   * A server asks the user something while a tool runs (MCP elicitation): message and the fields it wants (a JSON schema's
   * properties). The answer: accept with the values, decline or cancel.
   */
  elicit?: (server: string, message: string, schema: any) => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }>;
  /** Something changed (a server connected, failed, its tools changed): pages and the device catalog refresh. */
  onChange?: () => void;
  home?: string;
  version?: string;
}

const PROTOCOL = '2025-06-18';

class MemoryState implements StateLike {
  private readonly map = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.map.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { this.map.set(key, value); }
}
class MemorySecrets implements SecretsLike {
  private readonly map = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.map.get(key); }
  async store(key: string, value: string): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
}

// ------------------------------------------------------------------ reading config files

const jsonCache = new Map<string, { stamp: string; value: any }>();
/** A JSON file (comments allowed, as in VS Code's), cached by its size and time (~/.claude.json can be large). */
export function readJsonFile(file: string): any {
  let st: fsSync.Stats;
  try { st = fsSync.statSync(file); } catch { return null; }
  const stamp = `${st.size}:${st.mtimeMs}`;
  const hit = jsonCache.get(file);
  if (hit && hit.stamp === stamp) return hit.value;
  let value: any = null;
  try {
    const text = fsSync.readFileSync(file, 'utf8').replace(/^﻿/, '');
    try { value = JSON.parse(text); } catch { value = JSON.parse(stripJsonComments(text)); }
  } catch { value = null; }
  jsonCache.set(file, { stamp, value });
  return value;
}

/** Removes // and /* comments and trailing commas outside strings (JSONC). */
export function stripJsonComments(text: string): string {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === '"') inStr = false; i++; continue; }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** The servers object of a config in any of the usual layouts: {mcpServers: {}}, {servers: {}} (VS Code) or {servers: [...]}. */
export function serversOf(json: any): Record<string, any> {
  if (!json || typeof json !== 'object') return {};
  if (json.mcpServers && typeof json.mcpServers === 'object' && !Array.isArray(json.mcpServers)) return json.mcpServers;
  if (Array.isArray(json.servers)) {
    const out: Record<string, any> = {};
    for (const s of json.servers) if (s && (s.id || s.name)) out[String(s.id || s.name)] = s;
    return out;
  }
  if (json.servers && typeof json.servers === 'object') return json.servers;
  return {};
}

export function cleanId(id: string): string {
  const s = String(id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return (s || 'server').slice(0, 40);
}

const samePath = (a: string, b: string) => {
  const n = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' || process.platform === 'darwin' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
};

interface Source { label: string; file: string; editable: boolean; project: boolean; root?: string; servers: Record<string, any>; inputs?: any[]; pluginRoot?: string; prefix?: string }

/** A server entry as a spec; null when it is not usable (no command, no URL). */
export function toSpec(key: string, raw: any, src: Pick<Source, 'label' | 'file' | 'editable' | 'project' | 'root' | 'pluginRoot' | 'prefix'>): McpSpec | null {
  if (!raw || typeof raw !== 'object') return null;
  const url = raw.url || raw.endpoint;
  const type = String(raw.type || raw.transport || (url ? 'http' : 'stdio')).toLowerCase();
  const transport: McpTransport = type === 'sse' ? 'sse' : type.includes('http') ? 'http' : 'stdio';
  if (transport === 'stdio' && !raw.command) return null;
  if (transport !== 'stdio' && !url) return null;
  const strMap = (o: any) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [k, String(v)]));
  const inputs: McpSpec['inputs'] = [];
  const all = JSON.stringify(raw);
  const re = /\$\{input:([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(all))) if (!inputs.some(i => i.id === m![1])) inputs.push({ id: m[1], description: m[1], password: true });
  return {
    id: cleanId((src.prefix || '') + (raw.id || key)), key, name: String(raw.name || key), transport,
    command: raw.command ? String(raw.command) : undefined, args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: strMap(raw.env), envFile: raw.envFile ? String(raw.envFile) : undefined, cwd: raw.cwd ? String(raw.cwd) : undefined,
    url: url ? String(url) : undefined, headers: strMap(raw.headers),
    enabled: raw.enabled !== false && raw.disabled !== true,
    timeoutSeconds: Number(raw.timeoutSeconds) > 0 ? Number(raw.timeoutSeconds) : 600,
    requireApproval: !!raw.requireApproval,
    oauth: raw.oauth && typeof raw.oauth === 'object' ? raw.oauth : undefined,
    source: src.label, file: src.file, editable: src.editable, project: src.project, root: src.root, inputs, pluginRoot: src.pluginRoot
  };
}

/** Variables in a value: ${VAR}, ${VAR:-default} (Claude Code), ${env:VAR}, ${workspaceFolder}, ${userHome}, ${input:id} (VS Code), %VAR% (Windows). */
export function expandVars(value: string, ctx: { env: NodeJS.ProcessEnv; root?: string; home: string; pluginRoot?: string; inputs?: Record<string, string> }, missing: string[] = []): string {
  let v = String(value ?? '');
  v = v.replace(/\$\{([^}]+)\}/g, (all, body: string) => {
    const [name, def] = body.includes(':-') ? [body.slice(0, body.indexOf(':-')), body.slice(body.indexOf(':-') + 2)] : [body, undefined];
    switch (name) {
      case 'workspaceFolder': case 'CLAUDE_PROJECT_DIR': return ctx.root || '';
      case 'workspaceFolderBasename': return ctx.root ? path.basename(ctx.root) : '';
      case 'userHome': return ctx.home;
      case 'pathSeparator': case '/': return path.sep;
      case 'CLAUDE_PLUGIN_ROOT': return ctx.pluginRoot || '';
    }
    if (name.startsWith('input:')) {
      const id = name.slice(6), got = ctx.inputs && ctx.inputs[id];
      if (got === undefined) { missing.push('input:' + id); return all; }
      return got;
    }
    const envName = name.startsWith('env:') ? name.slice(4) : name;
    const got = ctx.env[envName] ?? (process.platform === 'win32' ? Object.entries(ctx.env).find(([k]) => k.toUpperCase() === envName.toUpperCase())?.[1] : undefined);
    if (got !== undefined && got !== '') return got;
    if (def !== undefined) return def;
    missing.push(envName);
    return '';
  });
  if (process.platform === 'win32') v = v.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (all, n: string) => {
    const got = Object.entries(ctx.env).find(([k]) => k.toUpperCase() === n.toUpperCase());
    return got && got[1] !== undefined ? got[1] : all;
  });
  return v;
}

/** KEY=value lines of an .env file. */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fsSync.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* none */ }
  return out;
}

// ------------------------------------------------------------------ starting a program on Windows

/** The program to start: on Windows a name is looked up on PATH (PATHEXT), and .cmd/.bat scripts (npx, uvx) go through cmd.exe. */
export function resolveCommand(command: string, args: string[], env: NodeJS.ProcessEnv): { file: string; args: string[]; verbatim: boolean } {
  if (process.platform !== 'win32') return { file: command, args, verbatim: false };
  const exts = (env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase());
  const pathValue = env.PATH || env.Path || '';
  const candidates = (base: string) => path.extname(base) ? [base, ...exts.map(e => base + e)] : exts.map(e => base + e);
  let found: string | null = null;
  if (/[\\/]/.test(command) || path.isAbsolute(command)) {
    found = candidates(command).find(c => { try { return fsSync.statSync(c).isFile(); } catch { return false; } }) || command;
  } else {
    for (const dir of pathValue.split(';').filter(Boolean)) {
      const hit = candidates(path.join(dir, command)).find(c => { try { return fsSync.statSync(c).isFile(); } catch { return false; } });
      if (hit) { found = hit; break; }
    }
  }
  const file = found || command;
  if (/\.(cmd|bat)$/i.test(file)) {
    const q = (s: string) => /^[\w.\\/:=@+-]+$/.test(s) ? s : '"' + s.replace(/"/g, '""') + '"';
    return { file: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', '"' + [q(file), ...args.map(q)].join(' ') + '"'], verbatim: true };
  }
  return { file, args, verbatim: false };
}

// ------------------------------------------------------------------ one connection

/** A spec with its values filled in. */
interface Resolved { spec: McpSpec; command?: string; args: string[]; env: Record<string, string>; cwd?: string; url?: string; headers: Record<string, string> }

class SignInNeeded extends Error { }

/** Pictures and text of a tool result (or of a prompt / resource). */
export function contentToResult(r: any): McpCallResult {
  const text: string[] = [], images: McpImage[] = [];
  for (const p of (r && Array.isArray(r.content) ? r.content : [])) {
    if (!p || typeof p !== 'object') continue;
    switch (p.type) {
      case 'text': text.push(String(p.text ?? '')); break;
      case 'image': if (p.data) images.push({ mediaType: String(p.mimeType || 'image/png'), data: String(p.data) }); text.push(`[picture ${images.length}: ${p.mimeType || 'image'}]`); break;
      case 'audio': text.push(`[audio ${p.mimeType || ''}, ${Math.round(String(p.data || '').length * 3 / 4)} bytes]`); break;
      case 'resource': {
        const res = p.resource || {};
        text.push(res.text !== undefined ? `Resource ${res.uri || ''}:\n${res.text}` : `[resource ${res.uri || ''} ${res.mimeType || ''} (binary)]`);
        break;
      }
      case 'resource_link': text.push(`Link: ${p.name || ''} ${p.uri || ''}${p.description ? ' - ' + p.description : ''}`); break;
      default: text.push(`[${p.type}]`);
    }
  }
  if (!text.length && r && r.structuredContent !== undefined) text.push(JSON.stringify(r.structuredContent, null, 2));
  return { ok: !(r && r.isError), result: text.join('\n') || '(no output)', images };
}

export class McpConnection {
  state: McpState = 'starting';
  error = '';
  tools: McpToolInfo[] = [];
  instructions = '';
  serverName = '';
  wwwAuthenticate = '';
  /** What the server said it offers (initialize): tools, resources, prompts. */
  capabilities: Record<string, unknown> = {};
  prompts: { name: string; description?: string; arguments?: { name: string; description?: string; required?: boolean }[] }[] = [];
  readonly stderr: string[] = [];
  readonly started = Date.now();
  private proc?: ChildProcess;
  private buf = '';
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private sessionId?: string;
  private protocol = PROTOCOL;
  private readonly abort = new AbortController();
  private postUrl?: string;
  private endpointWaiter?: (url: string) => void;
  private stopped = false;

  constructor(readonly r: Resolved, private readonly opts: { roots: () => string[]; log: (s: string) => void; oauth?: McpOAuth; version: string; onChange: () => void;
    elicit?: McpManagerOptions['elicit'] }) { }

  get spec(): McpSpec { return this.r.spec; }

  async start(): Promise<void> {
    try {
      if (this.r.spec.transport === 'stdio') this.startStdio();
      else if (this.r.spec.transport === 'sse') await this.startSse();
      const init = await this.request('initialize', {
        protocolVersion: PROTOCOL, capabilities: { roots: { listChanged: true }, ...(this.opts.elicit ? { elicitation: {} } : {}) },
        clientInfo: { name: 'agentic-vscode', version: this.opts.version }
      }, 60_000);
      if (init && init.protocolVersion) this.protocol = String(init.protocolVersion);
      this.instructions = String(init && init.instructions || '');
      this.serverName = String(init && init.serverInfo && init.serverInfo.name || '');
      this.capabilities = init && init.capabilities && typeof init.capabilities === 'object' ? init.capabilities : {};
      await this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await this.listTools();
      if (this.capabilities.prompts) this.prompts = await this.listAll('prompts/list', 'prompts').catch(() => []);
      this.state = 'connected';
      this.error = '';
    } catch (e) {
      this.state = e instanceof SignInNeeded ? 'signin' : 'failed';
      this.error = e instanceof Error ? e.message : String(e);
      if (this.state === 'failed' && this.stderr.length) this.error += ' — ' + this.stderr.slice(-3).join(' ').slice(0, 400);
      this.stop();
    }
    this.opts.onChange();
  }

  async listTools(): Promise<void> {
    const all: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, 60_000);
      for (const t of (r && Array.isArray(r.tools) ? r.tools : [])) if (t && t.name) all.push(t);
      cursor = r && r.nextCursor ? String(r.nextCursor) : undefined;
      if (!cursor) break;
    }
    this.tools = all;
  }

  /** Every page of a list (resources/list, prompts/list …). */
  async listAll(method: string, key: string): Promise<any[]> {
    const all: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const r = await this.request(method, cursor ? { cursor } : {}, 60_000);
      for (const x of (r && Array.isArray(r[key]) ? r[key] : [])) all.push(x);
      cursor = r && r.nextCursor ? String(r.nextCursor) : undefined;
      if (!cursor) break;
    }
    return all;
  }

  async readResource(uri: string): Promise<McpCallResult> {
    const r = await this.request('resources/read', { uri }, Math.max(10, this.spec.timeoutSeconds) * 1000);
    const text: string[] = [], images: McpImage[] = [];
    for (const c of (r && Array.isArray(r.contents) ? r.contents : [])) {
      if (typeof c.text === 'string') text.push(c.text);
      else if (c.blob && /^image\//.test(String(c.mimeType || ''))) { images.push({ mediaType: String(c.mimeType), data: String(c.blob) }); text.push(`[picture: ${c.uri || uri}]`); }
      else if (c.blob) text.push(`[binary ${c.mimeType || ''} resource, ${Math.round(String(c.blob).length * 3 / 4)} bytes]`);
    }
    return { ok: true, result: text.join('\n') || '(empty)', images };
  }

  /** A prompt with its arguments, as the text of its messages. */
  async getPrompt(name: string, args: Record<string, string>): Promise<string> {
    const r = await this.request('prompts/get', { name, arguments: args }, 60_000);
    return (r && Array.isArray(r.messages) ? r.messages : []).map((m: any) => {
      const c = m && m.content;
      const body = c && c.type === 'text' ? c.text : c && c.type === 'resource' && c.resource && typeof c.resource.text === 'string' ? c.resource.text : c ? `[${c.type}]` : '';
      return (m.role === 'assistant' ? 'Assistant: ' : '') + body;
    }).join('\n\n');
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    if (this.state !== 'connected') return { ok: false, result: `The MCP server ${this.spec.name} is not connected (${this.state}${this.error ? ': ' + this.error : ''}).`, images: [] };
    try {
      return contentToResult(await this.request('tools/call', { name, arguments: args || {} }, Math.max(10, this.spec.timeoutSeconds) * 1000));
    } catch (e) { return { ok: false, result: e instanceof Error ? e.message : String(e), images: [] }; }
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<any> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: no answer within ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.send({ jsonrpc: '2.0', id, method, params }).catch(e => {
        const p = this.pending.get(id);
        if (p) { this.pending.delete(id); p.reject(e instanceof Error ? e : new Error(String(e))); }
      });
    });
  }

  // -------------------------------------------------------------- messages

  private dispatchText(text: string): void {
    let msg: any;
    try { msg = JSON.parse(text); } catch { return; }
    for (const m of Array.isArray(msg) ? msg : [msg]) this.dispatch(m);
  }

  private dispatch(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.method && msg.id !== undefined && msg.id !== null) { void this.answer(msg); return; }
    if (msg.method) {
      if (msg.method === 'notifications/tools/list_changed') this.listTools().then(() => this.opts.onChange(), () => { });
      else if (msg.method === 'notifications/message' && msg.params) this.opts.log(`MCP ${this.spec.name}: ${typeof msg.params.data === 'string' ? msg.params.data : JSON.stringify(msg.params.data)}`.slice(0, 500));
      return;
    }
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || 'MCP error ' + msg.error.code));
    else p.resolve(msg.result);
  }

  /** The server's own requests: ping and roots/list are answered; anything else is refused politely. */
  private async answer(msg: any): Promise<void> {
    let reply: any;
    switch (msg.method) {
      case 'ping': reply = { jsonrpc: '2.0', id: msg.id, result: {} }; break;
      case 'roots/list':
        reply = { jsonrpc: '2.0', id: msg.id, result: { roots: this.opts.roots().map(r => ({ uri: 'file:///' + r.replace(/\\/g, '/').replace(/^\/+/, ''), name: path.basename(r) })) } };
        break;
      case 'elicitation/create':
        // The server asks the user (a confirmation, a value it needs): VS Code asks, the answer goes back.
        if (this.opts.elicit) {
          try {
            const a = await this.opts.elicit(this.spec.name, String(msg.params && msg.params.message || ''), msg.params && msg.params.requestedSchema);
            reply = { jsonrpc: '2.0', id: msg.id, result: a.action === 'accept' ? { action: 'accept', content: a.content || {} } : { action: a.action } };
          } catch { reply = { jsonrpc: '2.0', id: msg.id, result: { action: 'cancel' } }; }
          break;
        }
        reply = { jsonrpc: '2.0', id: msg.id, result: { action: 'decline' } };
        break;
      default: reply = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by this client` } };
    }
    try { await this.send(reply); } catch { /* gone */ }
  }

  private async send(msg: any): Promise<void> {
    if (this.stopped) throw new Error('The MCP server was stopped.');
    switch (this.r.spec.transport) {
      case 'stdio':
        if (!this.proc || !this.proc.stdin || this.proc.exitCode !== null) throw new Error('The MCP server is not running.');
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
        return;
      case 'sse': return this.postSse(msg);
      default: return this.postHttp(msg, false);
    }
  }

  // -------------------------------------------------------------- stdio

  private startStdio(): void {
    const env = commandEnv(this.r.env);
    const run = resolveCommand(this.r.command || '', this.r.args, env);
    const cwd = this.r.cwd && fsSync.existsSync(this.r.cwd) ? this.r.cwd : (this.opts.roots()[0] || os.homedir());
    this.proc = spawn(run.file, run.args, { cwd, env, windowsHide: true, windowsVerbatimArguments: run.verbatim, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout?.on('data', (b: Buffer) => {
      this.buf += b.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (line) this.dispatchText(line);
      }
    });
    this.proc.stderr?.on('data', (b: Buffer) => {
      for (const line of b.toString('utf8').split(/\r?\n/)) if (line.trim()) this.stderr.push(line.slice(0, 1000));
      if (this.stderr.length > 200) this.stderr.splice(0, this.stderr.length - 200);
    });
    const failAll = (why: string) => { for (const p of this.pending.values()) p.reject(new Error(why)); this.pending.clear(); };
    this.proc.on('error', e => { this.error = e.message; failAll(`${this.spec.name} could not start: ${e.message}`); });
    this.proc.on('close', code => {
      if (this.stopped) return;
      const why = `The MCP server stopped (exit code ${code})` + (this.stderr.length ? ': ' + this.stderr.slice(-3).join(' ').slice(0, 400) : '.');
      if (this.state === 'connected') { this.state = 'failed'; this.error = why; this.opts.onChange(); }
      failAll(why);
    });
  }

  // -------------------------------------------------------------- HTTP

  private async headers(extra: Record<string, string>): Promise<Record<string, string>> {
    const h: Record<string, string> = { ...this.r.headers, ...extra };
    if (!Object.keys(h).some(k => k.toLowerCase() === 'authorization') && this.opts.oauth && this.r.url) {
      const t = await this.opts.oauth.token(this.r.url);
      if (t) h.Authorization = 'Bearer ' + t;
    }
    return h;
  }

  /** A 401: refresh the sign-in once, else the server needs a sign-in. */
  private async unauthorized(res: Response, retried: boolean): Promise<boolean> {
    this.wwwAuthenticate = res.headers.get('www-authenticate') || '';
    if (!retried && this.opts.oauth && this.r.url && await this.opts.oauth.token(this.r.url, true)) return true;
    throw new SignInNeeded(`${this.spec.name} needs you to sign in (MCP Servers → Sign in, or /mcp login ${this.spec.id}).`);
  }

  private async postHttp(msg: any, retried: boolean): Promise<void> {
    const extra: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    if (this.sessionId) extra['Mcp-Session-Id'] = this.sessionId;
    if (msg.method !== 'initialize') extra['MCP-Protocol-Version'] = this.protocol;
    const res = await fetch(this.r.url!, { method: 'POST', headers: await this.headers(extra), body: JSON.stringify(msg), signal: this.abort.signal });
    if (res.status === 401) { await res.body?.cancel().catch(() => { }); if (await this.unauthorized(res, retried)) return this.postHttp(msg, true); }
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${t ? ': ' + t.replace(/\s+/g, ' ').slice(0, 300) : ''}`);
    }
    if (res.status === 202 || msg.id === undefined) { await res.body?.cancel().catch(() => { }); return; }
    const type = res.headers.get('content-type') || '';
    if (type.includes('text/event-stream') && res.body) { await this.readEvents(res.body, (ev, data) => { if (ev === 'message' || !ev) this.dispatchText(data); }); return; }
    const text = await res.text();
    if (text.trim()) this.dispatchText(text);
  }

  private async readEvents(body: ReadableStream<Uint8Array>, on: (event: string, data: string) => void): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const flush = (block: string) => {
      let event = '', data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(':')) continue;
        const i = line.indexOf(':');
        const field = i < 0 ? line : line.slice(0, i), value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
        if (field === 'event') event = value; else if (field === 'data') data.push(value);
      }
      if (data.length) on(event, data.join('\n'));
    };
    try {
      for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let m: RegExpExecArray | null;
        while ((m = /\r?\n\r?\n/.exec(buf))) { flush(buf.slice(0, m.index)); buf = buf.slice(m.index + m[0].length); }
      }
      if (buf.trim()) flush(buf);
    } catch { /* closed */ }
  }

  private async startSse(retried = false): Promise<void> {
    const res = await fetch(this.r.url!, { headers: await this.headers({ Accept: 'text/event-stream' }), signal: this.abort.signal });
    if (res.status === 401) { await res.body?.cancel().catch(() => { }); if (await this.unauthorized(res, retried)) return this.startSse(true); }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} opening the event stream`);
    const endpoint = new Promise<string>((resolve, reject) => {
      this.endpointWaiter = resolve;
      setTimeout(() => reject(new Error('The server did not send its endpoint within 15 s.')), 15_000);
    });
    void this.readEvents(res.body, (ev, data) => {
      if (ev === 'endpoint') { this.postUrl = new URL(data.trim(), this.r.url).toString(); this.endpointWaiter?.(this.postUrl); }
      else this.dispatchText(data);
    }).then(() => {
      if (this.stopped) return;
      if (this.state === 'connected') { this.state = 'failed'; this.error = 'The event stream closed.'; this.opts.onChange(); }
    });
    await endpoint;
  }

  private async postSse(msg: any): Promise<void> {
    if (!this.postUrl) throw new Error('No endpoint yet.');
    const res = await fetch(this.postUrl, { method: 'POST', headers: await this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(msg), signal: this.abort.signal });
    await res.body?.cancel().catch(() => { });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const p of this.pending.values()) p.reject(new Error('The MCP server was stopped.'));
    this.pending.clear();
    if (this.r.spec.transport === 'http' && this.sessionId && this.r.url) {
      void fetch(this.r.url, { method: 'DELETE', headers: { ...this.r.headers, 'Mcp-Session-Id': this.sessionId }, signal: AbortSignal.timeout(3000) }).catch(() => { });
    }
    this.abort.abort();
    const pid = this.proc?.pid;
    if (pid && this.proc && this.proc.exitCode === null) {
      try {
        if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
        else this.proc.kill('SIGTERM');
      } catch { /* gone */ }
    }
  }
}

// ------------------------------------------------------------------ the servers

export class McpManager {
  private readonly conns = new Map<string, { key: string; conn: McpConnection; ready: Promise<void> }>();
  private readonly state: StateLike;
  private readonly secrets: SecretsLike;
  readonly oauth: McpOAuth;
  private specsCache: McpSpec[] = [];
  private readonly inputValues = new Map<string, string>();
  private inputsLoaded = false;
  private lastWaiting = '';

  constructor(private readonly opts: McpManagerOptions) {
    this.state = opts.state || new MemoryState();
    this.secrets = opts.secrets || new MemorySecrets();
    this.oauth = new McpOAuth(this.secrets, opts.openBrowser || (() => { throw new Error('No browser to sign in with.'); }), opts.log);
  }

  private home(): string { return this.opts.home || os.homedir(); }
  private changed(): void { try { this.opts.onChange?.(); } catch { /* ignore */ } }

  /** The editable Agentic files: the user's (~/.agentic/mcp.json) and a project's (.mcp.json). */
  userFile(): string { return path.join(this.home(), '.agentic', 'mcp.json'); }
  projectFile(root?: string): string { return path.join(root || this.opts.roots()[0] || this.home(), '.mcp.json'); }

  private sources(): Source[] {
    const home = this.home(), roots = this.opts.roots();
    const list: Source[] = [];
    const add = (label: string, file: string, servers: Record<string, any>, extra: Partial<Source> = {}) => {
      if (servers && Object.keys(servers).length) list.push({ label, file, editable: false, project: false, servers, ...extra });
    };
    if (this.opts.includeClaude ? this.opts.includeClaude() : true) {
      // Installed Claude Code plugins (Claude Code's and Agentic's own) that are on (/plugin; Agentic's choice wins over Claude Code's).
      for (const p of enabledPlugins(roots, home)) {
        const dir = p.dir, plugin = p.id.split('@')[0];
        const manifest = readJsonFile(path.join(dir, '.claude-plugin', 'plugin.json')) || {};
        let servers: Record<string, any> = { ...serversOf(readJsonFile(path.join(dir, '.mcp.json'))) };
        if (typeof manifest.mcpServers === 'string') servers = { ...servers, ...serversOf(readJsonFile(path.resolve(dir, manifest.mcpServers))) };
        else if (manifest.mcpServers && typeof manifest.mcpServers === 'object') servers = { ...servers, ...manifest.mcpServers };
        add('Claude Code plugin ' + plugin, path.join(dir, '.mcp.json'), servers, { pluginRoot: dir, prefix: `plugin_${plugin}_` });
      }
      const desktop = process.platform === 'win32' ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json')
        : process.platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
          : path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
      add('Claude Desktop', desktop, serversOf(readJsonFile(desktop)));
      const cj = readJsonFile(path.join(home, '.claude.json'));
      if (cj) {
        add('Claude Code', path.join(home, '.claude.json'), serversOf(cj));
        for (const [p, v] of Object.entries<any>(cj.projects || {})) {
          if (roots.some(r => samePath(r, p))) add('Claude Code (this project)', path.join(home, '.claude.json'), serversOf(v), { root: roots.find(r => samePath(r, p)) });
        }
      }
    }
    if (this.opts.includeVsCode ? this.opts.includeVsCode() : true) {
      const userDir = this.opts.vscodeUserDir?.();
      if (userDir) { const j = readJsonFile(path.join(userDir, 'mcp.json')); add('VS Code', path.join(userDir, 'mcp.json'), serversOf(j), { inputs: j && j.inputs }); }
      const setting = this.opts.vscodeSetting?.();
      if (setting) add('VS Code settings', 'settings.json', serversOf(setting), { inputs: setting.inputs });
      for (const r of roots) {
        const f = path.join(r, '.vscode', 'mcp.json'), j = readJsonFile(f);
        add('VS Code workspace', f, serversOf(j), { project: true, root: r, inputs: j && j.inputs });
      }
    }
    list.push({ label: 'Agentic', file: this.userFile(), editable: true, project: false, servers: serversOf(readJsonFile(this.userFile())) });
    for (const r of roots) {
      for (const f of [path.join(r, '.mcp.json'), path.join(r, '.agentic', 'mcp.json')]) {
        list.push({ label: f.includes('.agentic') ? 'Project .agentic/mcp.json' : 'Project .mcp.json', file: f, editable: true, project: true, root: r, servers: serversOf(readJsonFile(f)) });
      }
    }
    return list;
  }

  /** Every configured server; a later source wins for the same id. */
  configured(): McpSpec[] {
    const byId = new Map<string, McpSpec>();
    for (const src of this.sources()) {
      for (const [key, raw] of Object.entries(src.servers)) {
        const s = toSpec(key, raw, src);
        if (!s) continue;
        const prompts = Array.isArray(src.inputs) ? src.inputs : [];
        s.inputs = s.inputs.map(i => { const p = prompts.find((x: any) => x && x.id === i.id); return p ? { id: i.id, description: String(p.description || i.id), password: p.password !== false } : i; });
        byId.set(s.id, s);
      }
    }
    const off = new Set(this.state.get<string[]>('agentic.mcp.off') || []);
    const list = [...byId.values()].map(s => s.editable || !off.has(s.id) ? s : { ...s, enabled: false });
    this.specsCache = list;
    return list;
  }

  private approvalKey(s: McpSpec): string {
    return `${s.root || ''}|${s.id}|` + createHash('sha256').update(JSON.stringify([s.command, s.args, s.url])).digest('hex').slice(0, 16);
  }

  /** null: not a project server; true/false: allowed or refused; undefined: not asked yet. */
  approval(s: McpSpec): boolean | null | undefined {
    if (!s.project) return null;
    const key = this.approvalKey(s);
    if ((this.state.get<string[]>('agentic.mcp.denied') || []).includes(key)) return false;
    if ((this.state.get<string[]>('agentic.mcp.approved') || []).includes(key)) return true;
    // Allowed in Claude Code already (~/.claude.json enabledMcpjsonServers) counts.
    if (s.source === 'Project .mcp.json' && s.root) {
      const cj = readJsonFile(path.join(this.home(), '.claude.json'));
      const proj = cj && Object.entries<any>(cj.projects || {}).find(([p]) => samePath(p, s.root!));
      if (proj && (proj[1].enabledMcpjsonServers || []).includes(s.key)) return true;
      if (proj && (proj[1].disabledMcpjsonServers || []).includes(s.key)) return false;
    }
    return undefined;
  }

  async setApproval(id: string, allow: boolean): Promise<void> {
    const s = this.configured().find(x => x.id === id);
    if (!s) throw new Error('No MCP server ' + id);
    const key = this.approvalKey(s);
    const approved = (this.state.get<string[]>('agentic.mcp.approved') || []).filter(k => k !== key);
    const denied = (this.state.get<string[]>('agentic.mcp.denied') || []).filter(k => k !== key);
    (allow ? approved : denied).push(key);
    await this.state.update('agentic.mcp.approved', approved);
    await this.state.update('agentic.mcp.denied', denied);
    this.refresh();
  }

  private async loadInputs(): Promise<void> {
    if (this.inputsLoaded) return;
    this.inputsLoaded = true;
    for (const id of this.state.get<string[]>('agentic.mcp.inputIds') || []) {
      const v = await this.secrets.get('agentic.mcp.input:' + id);
      if (v !== undefined) this.inputValues.set(id, v);
    }
  }

  async setInput(id: string, value: string): Promise<void> {
    await this.secrets.store('agentic.mcp.input:' + id, value);
    const ids = new Set(this.state.get<string[]>('agentic.mcp.inputIds') || []); ids.add(id);
    await this.state.update('agentic.mcp.inputIds', [...ids]);
    this.inputValues.set(id, value);
    this.refresh();
  }

  missingInputs(s: McpSpec): McpSpec['inputs'] { return s.inputs.filter(i => !this.inputValues.has(i.id)); }

  /** The spec with its variables filled in; missing: what could not be filled. */
  resolve(s: McpSpec): { r: Resolved; missing: string[] } {
    const missing: string[] = [];
    const inputs = Object.fromEntries(this.inputValues);
    const base = { env: { ...process.env } as NodeJS.ProcessEnv, root: s.root || this.opts.roots()[0], home: this.home(), pluginRoot: s.pluginRoot, inputs };
    let env: Record<string, string> = {};
    if (s.envFile) env = { ...readEnvFile(expandVars(s.envFile, base, missing)) };
    for (const [k, v] of Object.entries(s.env)) env[k] = expandVars(v, { ...base, env: { ...base.env, ...env } }, missing);
    const ctx = { ...base, env: { ...base.env, ...env } };
    const x = (v: string) => expandVars(v, ctx, missing);
    const r: Resolved = {
      spec: s, command: s.command ? x(s.command) : undefined, args: s.args.map(x), env, cwd: s.cwd ? x(s.cwd) : undefined,
      url: s.url ? x(s.url) : undefined, headers: Object.fromEntries(Object.entries(s.headers).map(([k, v]) => [k, x(v)]))
    };
    // A header whose value came out empty (an unset optional token) is left out.
    for (const [k, v] of Object.entries(r.headers)) if (!v.trim() || /^Bearer\s*$/i.test(v.trim())) delete r.headers[k];
    return { r, missing: [...new Set(missing)] };
  }

  /** Starts what should run and stops what should not, in the background. */
  refresh(): void {
    const specs = this.configured();
    const wanted = new Set<string>();
    for (const s of specs) {
      if (!s.enabled || this.approval(s) === false || this.approval(s) === undefined || this.missingInputs(s).length) continue;
      const { r } = this.resolve(s);
      const key = JSON.stringify(r);
      wanted.add(s.id);
      const cur = this.conns.get(s.id);
      if (cur && cur.key === key) continue;
      cur?.conn.stop();
      const conn = new McpConnection(r, { roots: this.opts.roots, log: this.opts.log, oauth: this.oauth, version: this.opts.version || '1', onChange: () => this.changed(), elicit: this.opts.elicit });
      const ready = conn.start().then(() => this.opts.log(conn.state === 'connected' ? `MCP ${s.name}: ${conn.tools.length} tools` : `MCP ${s.name}: ${conn.state} ${conn.error}`));
      this.conns.set(s.id, { key, conn, ready });
    }
    for (const [id, c] of [...this.conns]) if (!wanted.has(id)) { c.conn.stop(); this.conns.delete(id); this.changed(); }
    // A project server that now waits to be allowed: the extension asks the user.
    const waiting = specs.filter(s => s.enabled && this.approval(s) === undefined).map(s => s.id).join(',');
    if (waiting !== this.lastWaiting) { this.lastWaiting = waiting; if (waiting) this.changed(); }
  }

  /** Before a message: the servers are started (in the background) and it waits for the ones starting up to waitMs. */
  async ensure(waitMs = 8000): Promise<void> {
    await this.loadInputs();
    this.refresh();
    const starting = [...this.conns.values()].filter(c => c.conn.state === 'starting').map(c => c.ready);
    if (starting.length) await Promise.race([Promise.all(starting), new Promise(r => setTimeout(r, waitMs))]);
  }

  async reconnect(id: string): Promise<void> {
    const c = this.conns.get(id);
    c?.conn.stop();
    this.conns.delete(id);
    await this.ensure(30_000);
  }

  connection(id: string): McpConnection | undefined { return this.conns.get(id)?.conn; }

  static toolName(server: string, tool: string): string { return `mcp__${server}__${tool}`.replace(/[^\w-]/g, '_').slice(0, 64); }

  definitions(): { name: string; description: string; parameters: Record<string, unknown>; 'x-risk': 'ask' | 'change' }[] {
    const list: { name: string; description: string; parameters: Record<string, unknown>; 'x-risk': 'ask' | 'change' }[] = [];
    for (const { conn } of this.conns.values()) {
      if (conn.state !== 'connected') continue;
      for (const t of conn.tools) {
        const schema: Record<string, unknown> = t.inputSchema && typeof t.inputSchema === 'object' ? { ...(t.inputSchema as Record<string, unknown>) } : { type: 'object', properties: {} };
        delete schema.$schema;
        if (!schema.type) schema.type = 'object';
        list.push({ name: McpManager.toolName(conn.spec.id, t.name), description: `[${conn.spec.name}] ${(t.description || '').slice(0, 1400)}`, parameters: schema,
          'x-risk': conn.spec.requireApproval ? 'ask' : 'change' });
      }
    }
    return list;
  }

  /** Servers that offer resources: the model lists and reads them with list_mcp_resources and read_mcp_resource. */
  resourceDefinitions(): { name: string; description: string; parameters: Record<string, unknown>; 'x-risk': 'read' }[] {
    const servers = [...this.conns.values()].filter(c => c.conn.state === 'connected' && c.conn.capabilities.resources).map(c => c.conn.spec.id);
    if (!servers.length) return [];
    return [
      { name: 'list_mcp_resources', 'x-risk': 'read', description: `List the resources (files, records, documents) the MCP servers offer: ${servers.join(', ')}. Read one with read_mcp_resource.`,
        parameters: { type: 'object', properties: { server: { type: 'string', enum: servers } } } },
      { name: 'read_mcp_resource', 'x-risk': 'read', description: 'Read a resource of an MCP server by its URI (list_mcp_resources shows them).',
        parameters: { type: 'object', properties: { server: { type: 'string', enum: servers }, uri: { type: 'string' } }, required: ['server', 'uri'] } }
    ];
  }

  private async resourceCall(name: string, a: any): Promise<McpCallResult> {
    const servers = [...this.conns.values()].filter(c => c.conn.state === 'connected' && c.conn.capabilities.resources).map(c => c.conn);
    const pick = (id: string) => servers.find(s => s.spec.id === id);
    try {
      if (name === 'read_mcp_resource') {
        const s = pick(String(a && a.server || ''));
        if (!s) return { ok: false, result: 'No connected server called that offers resources: ' + servers.map(x => x.spec.id).join(', '), images: [] };
        return await s.readResource(String(a.uri || ''));
      }
      const lines: string[] = [];
      for (const s of a && a.server ? servers.filter(x => x.spec.id === a.server) : servers) {
        const list = await s.listAll('resources/list', 'resources').catch(e => { lines.push(`${s.spec.id}: ${e.message}`); return []; });
        for (const r of list.slice(0, 200)) lines.push(`${s.spec.id}  ${r.uri}  ${r.name || ''}${r.mimeType ? ' (' + r.mimeType + ')' : ''}${r.description ? ' - ' + String(r.description).slice(0, 160) : ''}`);
        const templates = await s.listAll('resources/templates/list', 'resourceTemplates').catch(() => []);
        for (const r of templates.slice(0, 50)) lines.push(`${s.spec.id}  ${r.uriTemplate}  (template) ${r.name || ''}`);
      }
      return { ok: true, result: lines.length ? lines.join('\n') : 'No resources.', images: [] };
    } catch (e) { return { ok: false, result: e instanceof Error ? e.message : String(e), images: [] }; }
  }

  /** The servers' prompts, as slash commands: /mcp__server__prompt. */
  promptCommands(): { name: string; description: string }[] {
    const out: { name: string; description: string }[] = [];
    for (const { conn } of this.conns.values()) {
      if (conn.state !== 'connected') continue;
      for (const p of conn.prompts) {
        const args = (p.arguments || []).map(x => x.required ? `<${x.name}>` : `[${x.name}]`).join(' ');
        out.push({ name: McpManager.toolName(conn.spec.id, p.name), description: `[${conn.spec.name}] ${p.description || p.name}${args ? ' ' + args : ''}`.slice(0, 200) });
      }
    }
    return out;
  }

  /** /mcp__server__prompt args: the prompt's text (its arguments filled from the words, in order; the last one takes the rest). */
  async expandPrompt(content: string): Promise<{ name: string; prompt: string } | null> {
    const m = /^\s*\/(mcp__[\w-]+)(?:\s+([\s\S]*))?$/.exec(content || '');
    if (!m) return null;
    for (const { conn } of this.conns.values()) {
      for (const p of conn.prompts) {
        if (McpManager.toolName(conn.spec.id, p.name) !== m[1]) continue;
        const words = (m[2] || '').trim() ? (m[2] || '').trim().split(/\s+/) : [];
        const names = (p.arguments || []).map(x => x.name);
        const args: Record<string, string> = {};
        names.forEach((n, i) => { if (i < words.length) args[n] = i === names.length - 1 ? words.slice(i).join(' ') : words[i]; });
        return { name: m[1], prompt: await conn.getPrompt(p.name, args) };
      }
    }
    return null;
  }

  /** What connected servers tell the model about themselves (their initialize instructions). */
  instructions(): string {
    const parts: string[] = [];
    for (const { conn } of this.conns.values()) if (conn.state === 'connected' && conn.instructions.trim()) parts.push(`- ${conn.spec.name} (mcp__${conn.spec.id}__*): ${conn.instructions.trim().slice(0, 2000)}`);
    return parts.length ? '\nWhat your MCP servers say about using them:\n' + parts.join('\n') + '\n' : '';
  }

  async call(name: string, args: unknown): Promise<McpCallResult | null> {
    if (name === 'list_mcp_resources' || name === 'read_mcp_resource') return this.resourceCall(name, args);
    for (const { conn } of this.conns.values()) for (const t of conn.tools) {
      if (McpManager.toolName(conn.spec.id, t.name) === name) return conn.callTool(t.name, args);
    }
    return null;
  }

  /** For /doctor. */
  status(): { name: string; ok: boolean; detail: string }[] {
    return this.snapshot().filter(s => s.enabled).map(s => ({ name: s.name, ok: s.state === 'connected', detail: s.state === 'connected' ? `${s.tools.length} tools` : `${s.state}${s.error ? ': ' + s.error : ''}` }));
  }

  /** Every server with its state, for the MCP Servers page and /mcp. */
  snapshot(): any[] {
    return (this.specsCache.length ? this.specsCache : this.configured()).map(s => {
      const c = this.conns.get(s.id)?.conn;
      const appr = this.approval(s);
      const missing = this.missingInputs(s);
      const state: McpState = !s.enabled ? 'off' : appr === undefined || appr === false ? 'approval' : missing.length ? 'input' : c ? c.state : 'starting';
      const { missing: unset } = this.resolve(s);
      return {
        id: s.id, name: s.name, source: s.source, file: s.file, editable: s.editable, project: s.project, root: s.root, transport: s.transport,
        command: s.command, args: s.args, url: s.url, enabled: s.enabled, requireApproval: s.requireApproval, timeoutSeconds: s.timeoutSeconds,
        env: Object.keys(s.env), headers: Object.keys(s.headers), approval: appr, denied: appr === false, inputs: missing,
        state, error: c ? c.error : '', unset: unset.filter(u => !u.startsWith('input:')),
        tools: c && c.state === 'connected' ? c.tools.map(t => ({ name: t.name, description: (t.description || '').slice(0, 300) })) : [],
        oauth: s.transport !== 'stdio', signin: c ? c.state === 'signin' : false, server: c ? c.serverName : '', stderr: c ? c.stderr.slice(-60) : []
      };
    });
  }

  /** Switches a server on or off: in its file when this app edits it, else remembered here. */
  async setEnabled(id: string, on: boolean): Promise<void> {
    const s = this.configured().find(x => x.id === id);
    if (!s) throw new Error('No MCP server ' + id);
    if (s.editable) {
      const j = readJsonFile(s.file) || {};
      const servers = serversOf(j);
      const entry = servers[s.key];
      if (entry) { if (on) { delete entry.disabled; delete entry.enabled; } else entry.disabled = true; writeServers(s.file, j, servers); }
    } else {
      const off = new Set(this.state.get<string[]>('agentic.mcp.off') || []);
      if (on) off.delete(id); else off.add(id);
      await this.state.update('agentic.mcp.off', [...off]);
    }
    this.refresh();
    this.changed();
  }

  /** Adds or replaces a server in the user's (~/.agentic/mcp.json) or the project's (.mcp.json) file. */
  upsert(name: string, entry: Record<string, unknown>, scope: 'user' | 'project' = 'user', root?: string): string {
    const file = scope === 'project' ? this.projectFile(root) : this.userFile();
    const j = readJsonFile(file) || {};
    const servers = serversOf(j);
    const key = name.trim() || 'server';
    servers[key] = entry;
    writeServers(file, j, servers);
    // Added by the user here: a project server is allowed right away.
    const s = this.configured().find(x => x.file === file && x.key === key);
    if (s && s.project) {
      const approved = new Set(this.state.get<string[]>('agentic.mcp.approved') || []);
      approved.add(this.approvalKey(s));
      void this.state.update('agentic.mcp.approved', [...approved]);
    }
    this.refresh();
    this.changed();
    return s ? s.id : cleanId(key);
  }

  remove(id: string): boolean {
    const s = this.configured().find(x => x.id === id);
    if (!s || !s.editable) return false;
    const j = readJsonFile(s.file) || {};
    const servers = serversOf(j);
    delete servers[s.key];
    writeServers(s.file, j, servers);
    this.refresh();
    this.changed();
    return true;
  }

  async signIn(id: string): Promise<void> {
    const s = this.configured().find(x => x.id === id);
    if (!s || !s.url) throw new Error('Only HTTP servers sign in.');
    const { r } = this.resolve(s);
    await this.oauth.signIn(r.url!, this.connection(id)?.wwwAuthenticate, s.oauth || {});
    await this.reconnect(id);
  }

  async signOut(id: string): Promise<void> {
    const s = this.configured().find(x => x.id === id);
    if (!s || !s.url) return;
    await this.oauth.signOut(this.resolve(s).r.url!);
    await this.reconnect(id);
  }

  dispose(): void { for (const c of this.conns.values()) c.conn.stop(); this.conns.clear(); }
}

/** Writes the servers back in the file's layout (mcpServers unless it used VS Code's servers), keeping its other keys. */
function writeServers(file: string, json: any, servers: Record<string, any>): void {
  const out = json && typeof json === 'object' ? { ...json } : {};
  if (out.servers && !Array.isArray(out.servers) && !out.mcpServers) out.servers = servers; else { delete out.servers; out.mcpServers = servers; }
  fsSync.mkdirSync(path.dirname(file), { recursive: true });
  fsSync.writeFileSync(file, JSON.stringify(out, null, 2) + '\n', 'utf8');
  jsonCache.delete(file);
}
