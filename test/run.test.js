// Tests for running the project (Run in Chat, the preview tool): detection, launch.json, the static server and runs.
// No VS Code needed: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const run = require('../out/tools/runner');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-run-'));
function dir(name, files) {
  const d = path.join(base, name);
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), text); }
  return d;
}
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const waitFor = async (cond, ms = 20000) => { for (let t = 0; t < ms; t += 100) { if (cond()) return true; await new Promise(r => setTimeout(r, 100)); } return cond(); };
const shell = process.platform === 'win32'
  ? { exe: 'powershell.exe', args: c => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', c] }
  : { exe: 'bash', args: c => ['-c', c] };

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('detect: package.json scripts with the lock file\'s package manager; no static site next to a dev server', () => {
  const d = dir('node', { 'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build', test: 'vitest' } }), 'yarn.lock': '', 'index.html': '' });
  const list = run.detectRunConfigs(d);
  assert.deepStrictEqual(list.map(c => [c.name, c.command, c.kind]), [['Dev server', 'yarn run dev', 'web'], ['Build', 'yarn run build', 'app'], ['Tests', 'yarn run test', 'test']]);
});

test('detect: a static site, Python, .NET (bin skipped, one test entry), Go and a Makefile', () => {
  assert.deepStrictEqual(run.detectRunConfigs(dir('static', { 'index.html': '<p>x</p>' })).map(c => [c.kind, c.command]), [['static', undefined]]);
  const py = run.detectRunConfigs(dir('py', { 'main.py': 'from fastapi import FastAPI\n', 'conftest.py': '' }));
  assert.ok(py.some(c => c.command === 'python -m uvicorn main:app --reload' && c.port === 8000) && py.some(c => c.command === 'python -m pytest'));
  const dn = run.detectRunConfigs(dir('dotnet', {
    'src/Web/Web.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>', 'tests/A/A.csproj': '<PackageReference Include="xunit" />',
    'tests/B/B.csproj': '<PackageReference Include="Microsoft.NET.Test.Sdk" />', 'bin/Old/Old.csproj': '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>'
  }));
  assert.ok(dn.some(c => c.kind === 'web' && c.command.includes('Web.csproj')), JSON.stringify(dn));
  assert.strictEqual(dn.filter(c => c.command === 'dotnet test').length, 1);
  assert.ok(!dn.some(c => c.command && c.command.includes('Old.csproj')));
  const go = run.detectRunConfigs(dir('go', { 'go.mod': 'module x', Makefile: 'build:\n\tx\nserve:\n\tx\n' }));
  assert.deepStrictEqual(go.map(c => c.command), ['go run .', 'go test ./...', 'make serve']);
});

test('launch.json: Claude Code\'s (comments, trailing commas, runtimeExecutable), ours first, unique ids', () => {
  const d = dir('launch', { '.claude/launch.json': '{\n // dev\n "configurations": [{"name": "Dev", "runtimeExecutable": "npm", "runtimeArgs": ["run", "dev"], "port": 3000,},],\n}' });
  let list = run.launchConfigs(d);
  assert.deepStrictEqual(list.map(c => [c.name, c.command, c.kind, c.port, c.source]), [['Dev', 'npm run dev', 'web', 3000, '.claude/launch.json']]);
  fs.mkdirSync(path.join(d, '.agentic'));
  fs.writeFileSync(path.join(d, '.agentic', 'launch.json'), JSON.stringify({ configurations: [{ name: 'E2E tests', command: 'npx playwright test', cwd: 'web' }, { name: 'E2E tests', command: 'x' }, { name: 'no command' }] }));
  list = run.runConfigs(d);
  assert.deepStrictEqual(list.map(c => [c.id, c.kind, c.source]), [['e2e-tests', 'test', '.agentic/launch.json'], ['e2e-tests-2', 'test', '.agentic/launch.json']]);
  assert.strictEqual(list[0].cwd, path.join(d, 'web'));
  assert.deepStrictEqual(run.runConfigs(undefined), []);
});

test('findUrl: dev server lines (colour codes, 0.0.0.0, trailing punctuation); not other hosts', () => {
  assert.strictEqual(run.findUrl('\u001b[32m  ➜  Local:   \u001b[1mhttp://localhost:5173/\u001b[22m'), 'http://localhost:5173/');
  assert.strictEqual(run.findUrl('Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...'), 'http://localhost:8000/');
  assert.strictEqual(run.findUrl(' * Running on http://127.0.0.1:5000.'), 'http://127.0.0.1:5000');
  assert.strictEqual(run.findUrl('see https://example.com/docs'), undefined);
});

test('ensureLaunchFile: written from what was detected, kept when it exists', () => {
  const d = dir('ensure', { 'app.py': 'import flask\n' });
  const file = run.ensureLaunchFile(d);
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(j.configurations, [{ name: 'Web app', command: 'python app.py', cwd: '.', kind: 'web', port: 5000 }]);
  fs.writeFileSync(file, '{"configurations": []}');
  assert.strictEqual(run.ensureLaunchFile(d), file);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{"configurations": []}');
});

test('static server: content types, no caching, folders, nothing outside the folder', async () => {
  const d = dir('site', { 'index.html': '<title>Game</title>', 'app.mjs': 'export {}', 'sub/index.html': 'sub page' });
  fs.writeFileSync(path.join(base, 'secret.txt'), 'do not serve');
  const s = await run.serveFolder(d);
  try {
    let r = await fetch(s.url);
    assert.strictEqual(r.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
    assert.match(await r.text(), /Game/);
    assert.strictEqual((await fetch(s.url + 'app.mjs')).headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.strictEqual(await (await fetch(s.url + 'sub/')).text(), 'sub page');
    for (const p of ['..%2fsecret.txt', '%2e%2e/secret.txt', '..%5csecret.txt']) {
      r = await fetch(s.url + p);
      assert.notStrictEqual(r.status, 200, p);
      assert.doesNotMatch(await r.text(), /do not serve/);
    }
  } finally { s.close(); }
});

test('runs: a dev server\'s address from its output, its log, stop; a quiet server by its port; tests with their exit code', async () => {
  const port = await freePort(), quiet = await freePort();
  const d = dir('web', {
    'server.js': `require('http').createServer((q, r) => r.end('hello')).listen(${port}, '127.0.0.1', () => console.log('\\x1b[32mReady on http://localhost:${port}\\x1b[0m'));`,
    'quiet.js': `require('http').createServer((q, r) => r.end('quiet')).listen(${quiet}, '127.0.0.1');`,
    '.agentic/launch.json': JSON.stringify({ configurations: [
      { name: 'Dev server', command: 'node server.js', kind: 'web' }, { name: 'Quiet', command: 'node quiet.js', port: quiet },
      { name: 'Unit tests', command: 'node -e "console.log(\'2 failed\'); process.exit(3)"' }] })
  });
  const seen = { started: [], ended: [], out: '' };
  const r = new run.ProjectRunner(() => d, () => shell);
  r.hooks = { started: c => seen.started.push(c.id), ended: (id, code) => seen.ended.push([id, code]), output: (id, t) => { seen.out += t; } };
  try {
    await r.start('dev-server');
    assert.ok(await waitFor(() => (r.status().find(s => s.id === 'dev-server') || {}).url), JSON.stringify(r.status()));
    assert.strictEqual(r.status()[0].url, `http://localhost:${port}`);
    assert.strictEqual(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'hello');
    const log = r.log('dev-server', 0);
    assert.match(log.text, /^> node server\.js\n/);
    assert.match(log.text, /Ready on/);
    assert.doesNotMatch(log.text, /\u001b/);
    assert.match(seen.out, /\u001b\[32m/, 'the terminal gets the colours');
    assert.strictEqual(r.log('dev-server', log.end).text, '');
    await r.start('quiet');
    assert.ok(await waitFor(() => (r.status().find(s => s.id === 'quiet') || {}).url === `http://localhost:${quiet}/`), JSON.stringify(r.status()));
    // The model's tool: status, tests (they end with their own exit code), an unknown name, stop.
    let t = await r.tool({ action: 'status' });
    assert.match(t.result, new RegExp(`Dev server \\[web\\]: node server\\.js - running at http://localhost:${port}`));
    t = await r.tool({ action: 'start', name: 'unit tests' });
    assert.strictEqual(t.ok, false);
    assert.match(t.result, /exit code 3/);
    assert.match(t.result, /2 failed/);
    assert.deepStrictEqual(r.status().find(s => s.id === 'unit-tests').exitCode, 3);
    t = await r.tool({ action: 'start', name: 'nope' });
    assert.match(t.result, /Known: Dev server \(node server\.js\)/);
    t = await r.tool({ action: 'open', url: 'file:///etc/passwd' }, async () => { });
    assert.strictEqual(t.ok, false);
    let shown = null;
    t = await r.tool({ action: 'open', url: `http://localhost:${port}/` }, async u => { shown = u; });
    assert.strictEqual(shown, `http://localhost:${port}/`);
    t = await r.tool({ action: 'stop' });
    assert.strictEqual(t.result, 'Stopped 2.');
    await new Promise(res => setTimeout(res, 1000));
    let gone = false;
    try { await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }); } catch { gone = true; }
    assert.ok(gone, 'stop ends the process tree');
    assert.deepStrictEqual(seen.started, ['dev-server', 'quiet', 'unit-tests']);
    assert.ok(seen.ended.some(([id, code]) => id === 'unit-tests' && code === 3), JSON.stringify(seen.ended));
    assert.strictEqual(r.stop('dev-server'), false, 'stopping twice');
  } finally { r.stopAll(); }
});

test('runs: no commands when they are switched off (the static site still runs)', async () => {
  const d = dir('off', { 'index.html': 'x', '.agentic/launch.json': JSON.stringify({ configurations: [{ name: 'Site', kind: 'static' }, { name: 'App', command: 'node -v' }] }) });
  const r = new run.ProjectRunner(() => d, () => shell, () => false);
  try {
    await assert.rejects(r.start('app'), /switched off/);
    await r.start('site');
    assert.match(r.status()[0].url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  } finally { r.stopAll(); }
});

/** Reads a zip back (local headers; stored or deflated) - enough to check what zipFiles wrote. */
function unzip(buf) {
  const zlib = require('zlib');
  const out = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8), size = buf.readUInt32LE(at + 18), nameLen = buf.readUInt16LE(at + 26), extra = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 30, at + 30 + nameLen);
    const body = buf.subarray(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    out[name] = (method === 8 ? zlib.inflateRawSync(body) : body).toString('utf8');
    at += 30 + nameLen + extra + size;
  }
  assert.strictEqual(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'the zip ends with its directory');
  return out;
}

test('projects: every workspace folder, what each can share, ids for the second folder\'s ways to run', () => {
  const built = dir('built', { 'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }), 'index.html': '<script type=module src=/src/main.js></script>', 'dist/index.html': '<p>built</p>' });
  const unbuilt = dir('unbuilt', { 'package.json': JSON.stringify({ scripts: { dev: 'vite', build: 'vite build' } }), 'index.html': 'source' });
  const site = dir('plain', { 'index.html': '<p>plain</p>' });
  assert.strictEqual(run.shareFolder(built), 'dist');
  assert.strictEqual(run.shareFolder(unbuilt), undefined, 'its index.html is the dev source: it needs a build first');
  assert.strictEqual(run.shareFolder(site), '.');
  const r = new run.ProjectRunner(() => [built, site], () => shell);
  r.keyPrefix = () => 'dev1';
  const ps = r.projects();
  assert.deepStrictEqual(ps.map(p => [p.name, p.share]), [['built', 'dist'], ['plain', '.']]);
  assert.strictEqual(ps[0].key, 'dev1:' + run.projectId(built));
  assert.notStrictEqual(ps[0].id, ps[1].id);
  const cfgs = r.configs();
  assert.deepStrictEqual(cfgs.map(c => [c.id, c.projectName]), [['dev-server', 'built'], ['build', 'built'], ['plain-static-site', 'plain']]);
});

test('share: the website is zipped (no node_modules or hidden files) and uploaded with the project\'s key', async () => {
  const d = dir('shareme', { 'index.html': '<title>Shared</title>', 'js/app.js': 'export const x = 1;'.repeat(50), 'node_modules/big/index.js': 'x', '.env': 'SECRET=1', 'img/a.svg': '<svg/>' });
  const r = new run.ProjectRunner(() => [d], () => shell);
  r.keyPrefix = () => 'vs1';
  let sent = null;
  r.uploader = async (zip, q) => { sent = { files: unzip(zip), q }; return { link: { title: q.title, url: 'https://agentic.example/a/tok123' }, updated: false }; };
  const res = await r.share('shareme');
  assert.strictEqual(res.link.url, 'https://agentic.example/a/tok123');
  assert.deepStrictEqual(Object.keys(sent.files).sort(), ['img/a.svg', 'index.html', 'js/app.js']);
  assert.strictEqual(sent.files['js/app.js'], 'export const x = 1;'.repeat(50));
  assert.deepStrictEqual(sent.q, { title: 'shareme', source: 'shareme', key: 'vs1:' + run.projectId(d) });
  // The model's tool says where the link is; a project without a website says what is missing.
  const t = await r.tool({ action: 'share' });
  assert.match(t.result, /Shared shareme: https:\/\/agentic\.example\/a\/tok123/);
  const none = new run.ProjectRunner(() => [dir('nosite', { 'main.go': 'package main' })], () => shell);
  none.uploader = r.uploader;
  await assert.rejects(none.share(''), /no website to share/);
  assert.strictEqual((await none.tool({ action: 'share' })).ok, false);
});
