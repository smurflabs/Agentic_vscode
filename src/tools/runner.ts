/**
 * Running the user's project (the Run chip in Chat and the model's preview tool), like Claude Desktop's preview. How to run
 * it comes from .agentic/launch.json or Claude Code's .claude/launch.json, else from the project's files: package.json
 * scripts, a static site (served by a small built-in server, since ES modules do not load from file://), Python, .NET,
 * Go, Rust, a Makefile. A web app's address comes from its output (or its port); the extension shows it in VS Code's
 * Simple Browser next to the chat. No VS Code API here, so the tests run in plain Node.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as path from 'path';
import * as zlib from 'zlib';
import { spawn, ChildProcess } from 'child_process';
import { commandEnv } from './extras';

export type RunKind = 'web' | 'static' | 'app' | 'test';

export interface RunConfig {
  id: string;
  name: string;
  /** The command line (in the user's shell); undefined for the built-in static server. */
  command?: string;
  cwd: string;
  kind: RunKind;
  port?: number;
  url?: string;
  /** .agentic/launch.json, .claude/launch.json or "detected". */
  source: string;
  /** The project (workspace folder) it belongs to: its id and name. */
  project?: string;
  projectName?: string;
}

/** A project (a workspace folder) and what of it Share uploads ("." = the folder itself; undefined = nothing yet). */
export interface RunProject { id: string; name: string; path: string; share?: string; key: string }

/** Uploads a website (a zip) to the Agentic server: {link, updated}. */
export type SiteUploader = (zip: Buffer, q: { title: string; source: string; key: string }) => Promise<any>

export interface RunStatus { id: string; name: string; kind: RunKind; command?: string; running: boolean; url?: string; exitCode?: number; startedUtc: string }
export interface RunLog { text: string; end: number; running: boolean; exitCode?: number; url?: string }

export interface Shell { exe: string; args: (cmd: string) => string[] }

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[a-z0-9-]+\.local)(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

export function stripAnsi(s: string): string { return s.replace(ANSI_RE, ''); }

/** The first local web address in a line of output (0.0.0.0 and [::] become localhost). */
export function findUrl(line: string): string | undefined {
  const m = URL_RE.exec(stripAnsi(line));
  return m ? m[0].replace(/[.,]+$/, '').replace(/\/\/(0\.0\.0\.0|\[::\])/, '//localhost') : undefined;
}

function readJson(file: string): any {
  try {
    // launch.json may have comments and trailing commas (VS Code's own launch.json does).
    const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
    return JSON.parse(stripJsonComments(text).replace(/,\s*([}\]])/g, '$1'));
  } catch { return null; }
}

/** Removes // and /* comments outside strings. */
export function stripJsonComments(text: string): string {
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out;
}

const quote = (s: string) => /\s/.test(s) && !s.startsWith('"') ? `"${s}"` : s;

/** .agentic/launch.json, else .claude/launch.json: {configurations: [{name, command | runtimeExecutable + runtimeArgs, cwd, port, url, kind}]}. */
export function launchConfigs(root: string): RunConfig[] {
  for (const rel of ['.agentic/launch.json', '.claude/launch.json']) {
    const j = readJson(path.join(root, rel));
    if (!j || !Array.isArray(j.configurations)) continue;
    const list: RunConfig[] = [];
    for (const e of j.configurations) {
      if (!e || typeof e !== 'object') continue;
      let command: string | undefined = typeof e.command === 'string' && e.command.trim() ? e.command : undefined;
      if (!command && typeof e.runtimeExecutable === 'string' && e.runtimeExecutable.trim()) {
        command = [e.runtimeExecutable, ...(Array.isArray(e.runtimeArgs) ? e.runtimeArgs.filter((a: unknown) => typeof a === 'string') : [])].map(quote).join(' ');
      }
      const port = Number.isInteger(e.port) && e.port > 0 ? e.port : undefined;
      const url = typeof e.url === 'string' ? e.url : undefined;
      const name = typeof e.name === 'string' && e.name.trim() ? e.name : (command || 'Run');
      let kind = typeof e.kind === 'string' ? e.kind.toLowerCase() : '';
      if (!['web', 'static', 'app', 'test'].includes(kind)) kind = /\btests?\b/i.test(name) ? 'test' : (port || url ? 'web' : 'app');
      if (!command && kind !== 'static') continue;
      const cwd = path.resolve(root, typeof e.cwd === 'string' && e.cwd.trim() ? e.cwd : '.');
      list.push({ id: '', name, command, cwd, kind: kind as RunKind, port, url, source: rel });
    }
    if (list.length) return list;
  }
  return [];
}

function head(file: string): string {
  try { const fd = fs.openSync(file, 'r'); const b = Buffer.alloc(200_000); const n = fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); return b.toString('utf8', 0, n); } catch { return ''; }
}

/** Files matching a pattern a few folders deep, skipping build, dependency and hidden folders. */
function findFiles(root: string, re: RegExp, depth: number): string[] {
  const skip = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'target', 'venv', 'packages', 'out', 'AppData', 'Library']);
  const found: string[] = [];
  const walk = (dir: string, level: number) => {
    if (found.length > 40) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) if (e.isFile() && re.test(e.name)) found.push(path.join(dir, e.name));
    if (level >= depth) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name)) walk(path.join(dir, e.name), level + 1);
  };
  walk(root, 1);
  return found;
}

/** What the project's files show: package.json scripts, a static site, Python, .NET, Go, Rust, a Makefile. */
export function detectRunConfigs(root: string): RunConfig[] {
  const list: RunConfig[] = [];
  const add = (name: string, command: string, kind: RunKind, port?: number) => {
    if (list.some(c => c.command === command && c.kind === kind)) return;
    list.push({ id: '', name, command, cwd: root, kind, port, source: 'detected' });
  };
  const has = (rel: string) => fs.existsSync(path.join(root, rel));
  if (has('package.json')) {
    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') || has('bun.lock') ? 'bun' : 'npm';
    const scripts = (readJson(path.join(root, 'package.json')) || {}).scripts || {};
    for (const [s, label] of [['dev', 'Dev server'], ['start', 'Start'], ['serve', 'Serve'], ['preview', 'Preview the build']]) {
      if (typeof scripts[s] === 'string') add(label, `${pm} run ${s}`, 'web');
    }
    if (typeof scripts.build === 'string') add('Build', `${pm} run build`, 'app');
    if (typeof scripts.test === 'string') add('Tests', `${pm} run test`, 'test');
  }
  if (has('index.html') && !list.some(c => c.kind === 'web')) list.push({ id: '', name: 'Static site', cwd: root, kind: 'static', source: 'detected' });
  if (has('manage.py')) add('Django server', 'python manage.py runserver', 'web', 8000);
  for (const f of ['app.py', 'main.py', 'server.py']) {
    if (!has(f)) continue;
    const code = head(path.join(root, f));
    const stem = f.slice(0, -3);
    if (/\bfastapi\b/i.test(code)) add('Web app', `python -m uvicorn ${stem}:app --reload`, 'web', 8000);
    else if (/\bflask\b/i.test(code)) add('Web app', `python ${f}`, 'web', 5000);
    else if (!list.some(c => c.command && c.command.startsWith('python '))) add('Run ' + f, `python ${f}`, 'app');
  }
  const testsDir = path.join(root, 'tests');
  if (has('pytest.ini') || has('conftest.py') || (has('pyproject.toml') && head(path.join(root, 'pyproject.toml')).includes('pytest')) ||
    (fs.existsSync(testsDir) && (() => { try { return fs.readdirSync(testsDir).some(n => /^test_.*\.py$/.test(n)); } catch { return false; } })())) {
    add('Tests', 'python -m pytest', 'test');
  }
  let testAdded = false;
  for (const p of findFiles(root, /\.(cs|vb|fs)proj$/i, 3)) {
    const xml = head(p);
    const rel = path.relative(root, p);
    const nice = path.basename(p).replace(/\.\w+$/, '');
    if (/Microsoft\.NET\.Test\.Sdk|xunit|nunit|MSTest/i.test(xml)) { if (!testAdded) add('Tests', 'dotnet test', 'test'); testAdded = true; }
    else if (xml.includes('Microsoft.NET.Sdk.Web')) add(`Web app (${nice})`, `dotnet run --project "${rel}"`, 'web');
    else if (/<OutputType>\s*(Exe|WinExe)\s*<\/OutputType>/i.test(xml)) add(`Run ${nice}`, `dotnet run --project "${rel}"`, 'app');
  }
  if (has('go.mod')) { add('Run', 'go run .', 'app'); add('Tests', 'go test ./...', 'test'); }
  if (has('Cargo.toml')) { add('Run', 'cargo run', 'app'); add('Tests', 'cargo test', 'test'); }
  if (has('Makefile')) {
    for (const m of head(path.join(root, 'Makefile')).matchAll(/^(run|dev|start|serve|test):/gm)) {
      add('make ' + m[1], 'make ' + m[1], m[1] === 'test' ? 'test' : m[1] === 'run' ? 'app' : 'web');
    }
  }
  return list;
}

/** The project's configurations with stable, unique ids (from the names); at most 12. */
export function runConfigs(root: string | undefined): RunConfig[] {
  return root ? allRunConfigs([root]) : [];
}

/**
 * The configurations of every project (at most six folders, 12 each), with stable, unique ids: the first project's from
 * their names, the others' with their folder's name first.
 */
export function allRunConfigs(roots: string[]): RunConfig[] {
  const all: RunConfig[] = [];
  const projects = roots.slice(0, 6);
  for (const root of projects) {
    let list = launchConfigs(root);
    if (!list.length) list = detectRunConfigs(root);
    for (const c of list.slice(0, 12)) { c.project = projectId(root); c.projectName = path.basename(root); all.push(c); }
  }
  const seen = new Set<string>();
  for (const c of all) {
    const name = c.project === projectId(projects[0]) ? c.name : `${c.projectName} ${c.name}`;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'run';
    let unique = id, n = 2;
    while (seen.has(unique)) unique = `${id}-${n++}`;
    seen.add(unique);
    c.id = unique;
  }
  return all.slice(0, 40);
}

export function projectId(root: string): string {
  return 'p' + crypto.createHash('sha1').update(path.resolve(root).replace(/[\\/]+$/, '').toLowerCase(), 'utf8').digest('hex').slice(0, 10);
}

/**
 * What Share uploads: the build (dist, build, out, _site, public, www) when it has index.html, else the project itself when
 * it is a static site (index.html, and no package.json whose build makes the real site).
 */
export function shareFolder(root: string): string | undefined {
  for (const d of ['dist', 'build', 'out', '_site', 'public', 'www']) if (fs.existsSync(path.join(root, d, 'index.html'))) return d;
  if (!fs.existsSync(path.join(root, 'index.html'))) return undefined;
  if (fs.existsSync(path.join(root, 'package.json')) && head(path.join(root, 'package.json')).includes('"build"')) return undefined;
  return '.';
}

// ------------------------------------------------------------------ sharing a website: a zip of its files

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** A zip (deflated where that is smaller) of files with forward-slash names. */
export function zipFiles(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const deflated = zlib.deflateRawSync(f.data);
    const packed = deflated.length < f.data.length;
    const body = packed ? deflated : f.data;
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(packed ? 8 : 0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(packed ? 8 : 0, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0x21, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt16LE(0, 30); cen.writeUInt16LE(0, 32); cen.writeUInt16LE(0, 34); cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cenBuf, end]);
}

/** A folder's files for sharing (no node_modules, .git or hidden files and folders): at most maxBytes and 3000 files. */
export function zipSite(folder: string, maxBytes = 25 * 1024 * 1024): Buffer {
  const skip = new Set(['node_modules', '__pycache__', 'bin', 'obj']);
  const files: { name: string; data: Buffer }[] = [];
  let total = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(full); continue; }
      if (!e.isFile()) continue;
      const data = fs.readFileSync(full);
      total += data.length;
      if (total > maxBytes) throw new Error(`The website is larger than ${Math.round(maxBytes / 1048576)} MB.`);
      if (files.length >= 3000) throw new Error('The website has more than 3000 files.');
      files.push({ name: path.relative(folder, full).split(path.sep).join('/'), data });
    }
  };
  walk(folder);
  if (!files.length) throw new Error('There are no files to share.');
  return zipFiles(files);
}

/** .agentic/launch.json, written from what was detected when it is not there yet; returns its path. */
export function ensureLaunchFile(root: string): string {
  const file = path.join(root, '.agentic', 'launch.json');
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const configurations = detectRunConfigs(root).filter(c => c.command).map(c => ({ name: c.name, command: c.command, cwd: '.', kind: c.kind, ...(c.port ? { port: c.port } : {}) }));
  fs.writeFileSync(file, JSON.stringify({ version: '0.0.1', configurations }, null, 2) + '\n');
  return file;
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

// ------------------------------------------------------------------ the built-in server for a static site

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.wasm': 'application/wasm', '.xml': 'application/xml', '.pdf': 'application/pdf'
};

/** Serves one folder on 127.0.0.1 (a free port) with the right content types and no caching; nothing outside it. */
export function serveFolder(root: string): Promise<{ url: string; close: () => void }> {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    let rel: string;
    try { rel = decodeURIComponent(new URL(req.url || '/', 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
    let full = path.resolve(base, '.' + rel);
    const inside = full === base || full.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
    if (inside) { try { if (fs.statSync(full).isDirectory()) full = path.join(full, 'index.html'); } catch { /* not there */ } }
    let st: fs.Stats | undefined;
    try { st = fs.statSync(full); } catch { st = undefined; }
    if (!inside || !st || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(full).on('error', () => res.destroy()).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => { server.close(); server.closeAllConnections?.(); } });
    });
  });
}

// ------------------------------------------------------------------ runs

interface Run {
  config: RunConfig;
  proc?: ChildProcess;
  site?: { url: string; close: () => void };
  out: string;
  /** Characters cut from the start of out (log positions stay the same). */
  dropped: number;
  url?: string;
  exitCode?: number;
  stopped: boolean;
  started: Date;
}

export interface RunHooks {
  /** New output of a run (as it comes; with colour codes, for a terminal). */
  output?(id: string, text: string): void;
  started?(config: RunConfig): void;
  ended?(id: string, exitCode: number): void;
}

export class ProjectRunner {
  private readonly runs = new Map<string, Run>();
  hooks: RunHooks = {};

  /** Sends a website to the Agentic server (set by the workspace tools); the device's id goes before each project's key. */
  uploader?: SiteUploader;
  keyPrefix: () => string = () => '';

  /** root: the project folder, or every workspace folder (the first is the main one). */
  constructor(private readonly root: () => string | string[] | undefined, private readonly shell: () => Shell, private readonly allowCommands: () => boolean = () => true) { }

  private roots(): string[] { const r = this.root(); return Array.isArray(r) ? r : r ? [r] : []; }

  configs(): RunConfig[] { return allRunConfigs(this.roots()); }

  /** The projects (workspace folders) and what each can share. */
  projects(): RunProject[] {
    return this.roots().slice(0, 6).map(root => ({ id: projectId(root), name: path.basename(root), path: root, share: shareFolder(root), key: `${this.keyPrefix()}:${projectId(root)}` }));
  }

  /** A project's website as a public link (the same link when it was shared before): {link, updated}. */
  async share(idOrName: string): Promise<any> {
    const q = (idOrName || '').toLowerCase();
    const p = this.projects().find(x => x.id === idOrName || x.name.toLowerCase() === q) || (q ? this.projects().find(x => x.name.toLowerCase().includes(q)) : this.projects()[0]);
    if (!p) throw new Error('No such project.');
    if (!p.share) throw new Error(`${p.name} has no website to share yet: it needs index.html, or a build (npm run build makes dist).`);
    if (!this.uploader) throw new Error('Sharing needs the Agentic server.');
    const zip = zipSite(path.resolve(p.path, p.share));
    return this.uploader(zip, { title: p.name, source: p.name, key: p.key });
  }

  /** .agentic/launch.json of the project (written from what was detected when missing). */
  ensureLaunchFile(): string {
    const root = this.roots()[0];
    if (!root) throw new Error('Open a folder first: launch.json is kept in the project folder.');
    return ensureLaunchFile(root);
  }

  private find(idOrName: string): RunConfig | undefined {
    const list = this.configs(), q = (idOrName || '').toLowerCase();
    return list.find(c => c.id === q || c.name.toLowerCase() === q) || (q ? list.find(c => c.name.toLowerCase().includes(q)) : undefined);
  }

  /** Starts a configuration (stopping it first when it runs); its output is kept and a web app's address found in it. */
  async start(idOrName: string): Promise<RunConfig> {
    const cfg = this.find(idOrName);
    if (!cfg) throw new Error(`No run configuration "${idOrName}". Known: ${this.configs().map(c => c.name).join(', ') || 'none (write .agentic/launch.json)'}.`);
    if (cfg.kind !== 'static' && !this.allowCommands()) throw new Error('Running commands is switched off in the VS Code settings (agentic.tools.allowCommands).');
    this.stop(cfg.id);
    const run: Run = { config: cfg, out: '', dropped: 0, stopped: false, started: new Date() };
    this.runs.set(cfg.id, run);
    this.hooks.started?.(cfg);
    const add = (text: string) => {
      this.hooks.output?.(cfg.id, text);
      run.out += stripAnsi(text).replace(/\r(?!\n)/g, '\n');
      if (run.out.length > 2_000_000) { const cut = run.out.length - 1_000_000; run.out = run.out.slice(cut); run.dropped += cut; }
    };
    if (cfg.kind === 'static') {
      run.site = await serveFolder(cfg.cwd);
      run.url = run.site.url;
      add(`Serving ${cfg.cwd} at ${run.url}\n`);
      return cfg;
    }
    const sh = this.shell();
    // PowerShell -Command ends with 1 for any failure: the run keeps the command's own exit code (tests report theirs).
    const command = /(^|[\\/])(pwsh|powershell)(\.exe)?$/i.test(sh.exe)
      ? cfg.command + '\n$ok = $?; if (-not $ok) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }' : cfg.command!;
    const env: NodeJS.ProcessEnv = commandEnv({ BROWSER: 'none', NO_COLOR: '1', FORCE_COLOR: '0' });
    if (cfg.port) env.PORT = String(cfg.port);
    add(`> ${cfg.command}\n`);
    const proc = spawn(sh.exe, sh.args(command), { cwd: cfg.cwd, windowsHide: true, detached: process.platform !== 'win32', env });
    run.proc = proc;
    let partial = '';
    const onData = (b: Buffer) => {
      const text = b.toString('utf8');
      add(text);
      if (run.url || (cfg.kind !== 'web' && cfg.kind !== 'app')) return;
      // Whole lines only: a chunk may end in the middle of an address.
      const lines = (partial + stripAnsi(text)).split(/\r?\n|\r/);
      partial = (lines.pop() || '').slice(-2000);
      for (const l of lines) { const u = findUrl(l); if (u) { run.url = u; break; } }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', e => { add(`\n${e.message}\n`); if (run.exitCode === undefined) { run.exitCode = -1; this.hooks.ended?.(cfg.id, -1); } });
    proc.on('close', code => {
      if (partial && !run.url && (cfg.kind === 'web' || cfg.kind === 'app')) run.url = findUrl(partial);
      if (run.exitCode === undefined) { run.exitCode = code ?? -1; this.hooks.ended?.(cfg.id, run.exitCode); }
    });
    // A configured address or port: it is the page once the port answers.
    if (cfg.kind === 'web' && (cfg.url || cfg.port)) void this.waitForPort(run);
    return cfg;
  }

  private async waitForPort(run: Run): Promise<void> {
    let u: URL;
    try { u = new URL(run.config.url || `http://localhost:${run.config.port}/`); } catch { return; }
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname;
    for (let i = 0; i < 240; i++) {
      if (run.url || run.exitCode !== undefined || run.stopped) return;
      const open = await new Promise<boolean>(resolve => {
        const s = net.connect({ host, port });
        const done = (v: boolean) => { s.destroy(); resolve(v); };
        s.setTimeout(1000, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
      });
      if (open) { if (!run.url) run.url = u.toString(); return; }
      await new Promise(r => setTimeout(r, 500));
    }
  }

  private static running(r: Run): boolean { return !r.stopped && (!!r.site || (!!r.proc && r.exitCode === undefined)); }

  /** Stops a run; false when it was not running. */
  stop(id: string): boolean {
    const r = this.runs.get(id);
    if (!r || !ProjectRunner.running(r)) return false;
    r.stopped = true;
    r.site?.close();
    if (r.proc && r.exitCode === undefined) killTree(r.proc.pid);
    if (r.exitCode === undefined) r.exitCode = r.site ? 0 : -1;
    r.out += '(stopped)\n';
    this.hooks.ended?.(id, r.exitCode);
    return true;
  }

  stopAll(): number { let n = 0; for (const id of [...this.runs.keys()]) if (this.stop(id)) n++; return n; }

  status(): RunStatus[] {
    return [...this.runs.values()].sort((a, b) => a.started.getTime() - b.started.getTime()).map(r => {
      const live = ProjectRunner.running(r);
      return { id: r.config.id, name: r.config.name, kind: r.config.kind, command: r.config.command, running: live, url: r.url, exitCode: live ? undefined : r.exitCode, startedUtc: r.started.toISOString() };
    });
  }

  /** A run's output from a position (what the log shows as it comes). */
  log(id: string, from: number): RunLog {
    const r = this.runs.get(id);
    if (!r) return { text: '', end: 0, running: false };
    let start = Math.max(0, (from || 0) - r.dropped);
    if (r.out.length - start > 200_000) start = r.out.length - 200_000;
    const live = ProjectRunner.running(r);
    return { text: r.out.slice(start), end: r.dropped + r.out.length, running: live, exitCode: live ? undefined : r.exitCode, url: r.url };
  }

  /** The last lines of a run's output. */
  tail(id: string, lines = 40): string {
    const r = this.runs.get(id);
    return r ? r.out.split('\n').slice(-lines).join('\n') : '';
  }

  /**
   * The model's preview tool: status | start {name} | open {url} | stop {name?} | share {name?: the project}. start waits for
   * a web app's address (a minute at most), for tests to end (ten minutes), or a few seconds for an app; a page is shown
   * with show().
   */
  async tool(a: Record<string, any>, show: ((url: string, title: string) => Promise<void>) | undefined): Promise<{ ok: boolean; result: string }> {
    const action = String(a.action || 'status').toLowerCase();
    if (action === 'share') {
      try {
        const name = String(a.name || '').trim();
        const p = name ? undefined : this.projects().find(x => x.share);
        const r = await this.share(name || (p ? p.id : ''));
        const link = r && (r.link || r);
        return { ok: true, result: `${r && r.updated ? 'Updated' : 'Shared'} ${link && link.title}: ${link && link.url} - anyone with this link can open it.` };
      } catch (e) { return { ok: false, result: e instanceof Error ? e.message : String(e) }; }
    }
    if (action === 'open') {
      let u: URL;
      try { u = new URL(String(a.url || '')); } catch { return { ok: false, result: 'url must be an http(s) address.' }; }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, result: 'url must be an http(s) address.' };
      if (!show) return { ok: false, result: 'There is no preview here.' };
      await show(u.toString(), u.host);
      return { ok: true, result: `Showing ${u} in the preview.` };
    }
    if (action === 'stop') {
      const name = String(a.name || '').trim();
      const ids = name ? this.configs().filter(c => c.id === name.toLowerCase() || c.name.toLowerCase().includes(name.toLowerCase())).map(c => c.id) : [...this.runs.keys()];
      const n = ids.filter(id => this.stop(id)).length;
      return { ok: true, result: n ? `Stopped ${n}.` : 'Nothing was running.' };
    }
    if (action === 'start') {
      const name = String(a.name || '').trim();
      const configs = this.configs();
      const cfg = name ? this.find(name) : configs.find(c => c.kind === 'web' || c.kind === 'static');
      if (!cfg) return { ok: false, result: `No run configuration ${name}. Known: ${configs.length ? configs.map(c => `${c.name} (${c.command || 'built-in server'})`).join(', ') : 'none (write .agentic/launch.json)'}.` };
      await this.start(cfg.id);
      const r = this.runs.get(cfg.id)!;
      const web = cfg.kind === 'web' || cfg.kind === 'static';
      const deadline = Date.now() + (cfg.kind === 'test' ? 600 : cfg.kind === 'app' ? 8 : 60) * 1000;
      while (Date.now() < deadline && r.exitCode === undefined && !(web && r.url)) await new Promise(res => setTimeout(res, 300));
      if (r.url && web && show) await show(r.url, cfg.name).catch(() => { });
      const state = r.exitCode !== undefined ? `It ended with exit code ${r.exitCode}.` : r.url ? `It runs at ${r.url}${web && show ? ' and shows in the preview' : ''}.` : 'It is running.';
      return { ok: !r.exitCode, result: `Started ${cfg.name} (${cfg.command || 'built-in server'}). ${state}\nLast output:\n${this.tail(cfg.id)}` };
    }
    const configs = this.configs();
    const lines = [configs.length ? `Run configurations (${configs[0].source}):` : 'No run configurations: write .agentic/launch.json.'];
    for (const c of configs) {
      const r = this.runs.get(c.id);
      const live = r && ProjectRunner.running(r);
      lines.push(`- ${c.name} [${c.kind}]: ${c.command || 'built-in server'}${live ? ' - running' + (r!.url ? ' at ' + r!.url : '') : ''}`);
    }
    return { ok: true, result: lines.join('\n') };
  }
}
