// Tests for the local MCP servers (src/tools/mcp.ts, mcpAuth.ts): where servers are found (Agentic, Claude Code, its plugins,
// VS Code), variables, project servers waiting to be allowed, stdio with server requests and pictures, Streamable HTTP with
// an OAuth sign-in, and the older HTTP+SSE transport. No VS Code needed: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { McpManager, expandVars, toSpec, serversOf, stripJsonComments, resolveCommand, contentToResult } = require('../out/tools/mcp');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-mcp-'));
const write = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)); };
const FAKE = path.join(__dirname, 'fixtures', 'mcp-stdio-server.js');
const node = process.execPath;
const manager = (home, root, extra = {}) => new McpManager({ roots: () => [root], log: () => { }, home, includeVsCode: () => true, includeClaude: () => true, ...extra });
const waitFor = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

test('variables: ${VAR}, ${VAR:-default}, ${env:X}, VS Code folders and inputs; missing ones are named', () => {
  const ctx = { env: { TOKEN: 'abc', EMPTY: '' }, root: '/work/app', home: '/home/me', inputs: { key: 's3cret' }, pluginRoot: '/plug' };
  assert.strictEqual(expandVars('Bearer ${TOKEN}', ctx), 'Bearer abc');
  assert.strictEqual(expandVars('${NOPE:-fallback}', ctx), 'fallback');
  assert.strictEqual(expandVars('${EMPTY:-x}', ctx), 'x');
  assert.strictEqual(expandVars('${env:TOKEN}/${workspaceFolder}/${userHome}', ctx), 'abc//work/app//home/me');
  assert.strictEqual(expandVars('${input:key}', ctx), 's3cret');
  assert.strictEqual(expandVars('${CLAUDE_PLUGIN_ROOT}/server.js', ctx), '/plug/server.js');
  const missing = [];
  expandVars('${GITHUB_TOKEN} ${input:other}', ctx, missing);
  assert.deepStrictEqual(missing, ['GITHUB_TOKEN', 'input:other']);
  if (process.platform === 'win32') assert.strictEqual(expandVars('%TOKEN%-%NOT_SET%', ctx), 'abc-%NOT_SET%');
});

test('config layouts: mcpServers, VS Code servers (JSONC), the desktop list; transports from type or url', () => {
  assert.deepStrictEqual(Object.keys(serversOf({ mcpServers: { a: {} } })), ['a']);
  assert.deepStrictEqual(Object.keys(serversOf({ servers: { b: {} } })), ['b']);
  assert.deepStrictEqual(Object.keys(serversOf({ servers: [{ id: 'c' }] })), ['c']);
  assert.deepStrictEqual(JSON.parse(stripJsonComments('{ // c\n "a": "http://x", /* b */ "b": [1,],\n}')), { a: 'http://x', b: [1] });
  const src = { label: 'x', file: 'f', editable: false, project: false };
  assert.strictEqual(toSpec('h', { url: 'https://x/mcp' }, src).transport, 'http');
  assert.strictEqual(toSpec('s', { type: 'sse', url: 'https://x/sse' }, src).transport, 'sse');
  assert.strictEqual(toSpec('t', { command: 'npx', args: ['-y', 'x'] }, src).transport, 'stdio');
  assert.strictEqual(toSpec('bad', { type: 'stdio' }, src), null);
  assert.deepStrictEqual(toSpec('i', { command: 'x', env: { K: '${input:api-key}' } }, src).inputs.map(i => i.id), ['api-key']);
  const r = contentToResult({ content: [{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'resource', resource: { uri: 'file:///x', text: 'body' } }] });
  assert.strictEqual(r.images.length, 1);
  assert.match(r.result, /picture 1/);
  assert.match(r.result, /Resource file:\/\/\/x:\nbody/);
});

test('servers come from Agentic, Claude Code (user and this project), plugins and VS Code; project servers wait to be allowed', async () => {
  const home = tmp(), root = tmp();
  write(path.join(home, '.agentic', 'mcp.json'), { mcpServers: { mine: { command: 'node', args: ['a.js'] } } });
  write(path.join(home, '.claude.json'), { mcpServers: { claudeuser: { type: 'http', url: 'https://example.com/mcp' } },
    projects: { [root.replace(/\\/g, '/')]: { mcpServers: { claudelocal: { command: 'node' } }, enabledMcpjsonServers: ['approvedbyclaude'] } } });
  const plugin = path.join(home, '.claude', 'plugins', 'cache', 'm', 'tools', '1.0.0');
  write(path.join(plugin, '.mcp.json'), { mcpServers: { db: { command: '${CLAUDE_PLUGIN_ROOT}/db.exe' } } });
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'tools@m': [{ scope: 'user', installPath: plugin }] } });
  write(path.join(root, '.mcp.json'), { mcpServers: { fromrepo: { command: 'evil', args: ['--x'] }, approvedbyclaude: { command: 'node' } } });
  write(path.join(root, '.vscode', 'mcp.json'), '{ // VS Code\n "servers": { "vsws": { "type": "stdio", "command": "node", "env": { "K": "${input:key}" } } }, "inputs": [{ "id": "key", "type": "promptString", "description": "Your key", "password": true }] }');
  const m = manager(home, root);
  const specs = m.configured();
  const by = id => specs.find(s => s.id === id);
  assert.ok(by('mine') && by('mine').editable && !by('mine').project);
  assert.strictEqual(by('claudeuser').source, 'Claude Code');
  assert.strictEqual(by('claudelocal').source, 'Claude Code (this project)');
  assert.strictEqual(by('plugin_tools_db').source, 'Claude Code plugin tools');
  assert.strictEqual(m.resolve(by('plugin_tools_db')).r.command, plugin + '/db.exe');
  assert.strictEqual(by('vsws').inputs[0].description, 'Your key');
  assert.strictEqual(m.approval(by('fromrepo')), undefined, 'a repository server is not started before the user allows it');
  assert.strictEqual(m.approval(by('approvedbyclaude')), true, 'allowed in Claude Code already');
  assert.strictEqual(m.approval(by('mine')), null);
  const snap = m.snapshot();
  assert.strictEqual(snap.find(s => s.id === 'fromrepo').state, 'approval');
  assert.strictEqual(snap.find(s => s.id === 'vsws').state, 'approval');
  await m.setApproval('vsws', true);
  assert.strictEqual(m.snapshot().find(s => s.id === 'vsws').state, 'input');
  await m.setApproval('fromrepo', false);
  assert.strictEqual(m.snapshot().find(s => s.id === 'fromrepo').denied, true);
  // Off for a server from another app is remembered here; its file is not touched.
  await m.setEnabled('claudeuser', false);
  assert.strictEqual(m.configured().find(s => s.id === 'claudeuser').enabled, false);
  assert.ok(fs.readFileSync(path.join(home, '.claude.json'), 'utf8').includes('claudeuser'));
  // Without Claude Code's servers.
  const m2 = manager(home, root, { includeClaude: () => false });
  assert.ok(!m2.configured().some(s => s.id === 'claudeuser' || s.id === 'plugin_tools_db'));
  m.dispose(); m2.dispose();
});

test('stdio: connects, answers roots/list, pages tools, returns pictures, fills env from ${VAR}; upsert and remove', async () => {
  const home = tmp(), root = tmp();
  process.env.AGENTIC_TEST_SECRET = 'tok-123';
  const m = manager(home, root);
  const id = m.upsert('fake', { command: node, args: [FAKE, '${AGENTIC_TEST_SECRET:-none}', 'arg with space'], env: { FAKE_TOKEN: '${AGENTIC_TEST_SECRET}' } }, 'user');
  assert.strictEqual(id, 'fake');
  await m.ensure(15000);
  const s = m.snapshot().find(x => x.id === 'fake');
  assert.strictEqual(s.state, 'connected', s.error);
  assert.deepStrictEqual(s.tools.map(t => t.name), ['echo', 'shot', 'roots', 'env', 'ask']);
  assert.match(m.instructions(), /Use echo for tests/);
  const defs = m.definitions();
  assert.ok(defs.some(d => d.name === 'mcp__fake__echo'));
  assert.strictEqual((await m.call('mcp__fake__echo', { text: 'hi' })).result, 'echo: hi');
  const shot = await m.call('mcp__fake__shot', {});
  assert.strictEqual(shot.images.length, 1);
  assert.strictEqual(shot.images[0].mediaType, 'image/png');
  const roots = JSON.parse((await m.call('mcp__fake__roots', {})).result);
  assert.ok(roots.roots[0].uri.startsWith('file:///'));
  assert.strictEqual((await m.call('mcp__fake__env', {})).result, 'tok-123|tok-123|arg with space');
  assert.match(s.stderr.join('\n'), /fake server starting tok-123/);
  await m.setEnabled('fake', false);
  assert.strictEqual(m.definitions().length, 0);
  assert.ok(JSON.parse(fs.readFileSync(m.userFile(), 'utf8')).mcpServers.fake.disabled);
  assert.ok(m.remove('fake'));
  assert.ok(!m.configured().some(x => x.id === 'fake'));
  m.dispose();
});

test('a project server added by the user here is allowed; a missing program fails with a clear state', async () => {
  const home = tmp(), root = tmp();
  const m = manager(home, root);
  m.upsert('local', { command: node, args: [FAKE] }, 'project');
  m.upsert('missing', { command: 'definitely-not-a-program-xyz' }, 'user');
  await m.ensure(15000);
  await waitFor(() => m.snapshot().find(s => s.id === 'missing').state === 'failed');
  const snap = m.snapshot();
  assert.strictEqual(snap.find(s => s.id === 'local').state, 'connected');
  assert.strictEqual(snap.find(s => s.id === 'missing').state, 'failed');
  m.dispose();
});

test('windows: npx-style .cmd scripts start through cmd.exe with quoted arguments', { skip: process.platform !== 'win32' }, () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'tool.cmd'), '@echo off\r\necho %*\r\n');
  const r = resolveCommand('tool', ['-y', 'a b', 'C:\\x'], { PATH: dir, PATHEXT: '.EXE;.CMD' });
  assert.ok(r.verbatim);
  assert.match(r.args[3], /tool\.cmd" -y "a b" C:\\x"$/);
});

// ------------------------------------------------------------------ a hosted server with an OAuth sign-in

function oauthServer() {
  let base = '';
  const codes = new Map();
  const tokens = new Set();
  let sessions = 0, refreshed = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
    const json = (status, obj, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return json(200, { resource: base + '/mcp', authorization_servers: [base] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register' });
    if (url.pathname === '/register') { const j = JSON.parse(body); return json(201, { client_id: 'client-1', redirect_uris: j.redirect_uris }); }
    if (url.pathname === '/authorize') {
      const code = 'code-' + crypto.randomBytes(4).toString('hex');
      codes.set(code, url.searchParams.get('code_challenge'));
      assert.strictEqual(url.searchParams.get('resource'), base + '/mcp');
      res.writeHead(302, { Location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` }); return res.end();
    }
    if (url.pathname === '/token') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'refresh_token') { refreshed++; const t = 'tok-r' + refreshed; tokens.add(t); return json(200, { access_token: t, expires_in: 3600 }); }
      const challenge = codes.get(f.get('code'));
      const ok = challenge && crypto.createHash('sha256').update(f.get('code_verifier')).digest('base64url') === challenge;
      if (!ok) return json(400, { error: 'invalid_grant' });
      tokens.add('tok-1');
      return json(200, { access_token: 'tok-1', refresh_token: 'refresh-1', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.pathname === '/mcp') {
      const auth = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!tokens.has(auth)) { res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` }); return res.end(); }
      if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
      const m = JSON.parse(body);
      if (m.id === undefined) { res.writeHead(202); return res.end(); }
      if (m.method === 'initialize') {
        // Answered as an event stream, with a session id.
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'sess-' + (++sessions) });
        res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'hosted' } } })}\n\n`);
        return;
      }
      assert.ok(req.headers['mcp-session-id'], 'the session id goes with every request after initialize');
      if (m.method === 'tools/list') return json(200, { jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'whoami', inputSchema: { type: 'object' } }] } });
      if (m.method === 'tools/call') return json(200, { jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'you are ' + auth }] } });
    }
    res.writeHead(404); res.end();
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r({ server, base: () => base, tokens }); }));
}

test('Streamable HTTP: a 401 asks for a sign-in; OAuth (metadata, registration, PKCE, browser) signs in and the tools work', async () => {
  const { server, base, tokens } = await oauthServer();
  const home = tmp(), root = tmp();
  const opened = [];
  const m = manager(home, root, { openBrowser: async url => { opened.push(url); await fetch(url); } });
  m.upsert('hosted', { type: 'http', url: base() + '/mcp' }, 'user');
  await m.ensure(10000);
  let s = m.snapshot().find(x => x.id === 'hosted');
  assert.strictEqual(s.state, 'signin', s.error);
  await m.signIn('hosted');
  s = m.snapshot().find(x => x.id === 'hosted');
  assert.strictEqual(s.state, 'connected', s.error);
  assert.strictEqual(opened.length, 1);
  assert.match(opened[0], /code_challenge_method=S256/);
  assert.strictEqual((await m.call('mcp__hosted__whoami', {})).result, 'you are tok-1');
  // A token the server no longer takes: refreshed once, then it works again.
  tokens.delete('tok-1');
  assert.strictEqual((await m.call('mcp__hosted__whoami', {})).result, 'you are tok-r1');
  m.dispose();
  server.closeAllConnections();
  server.close();
});

test('HTTP+SSE (older servers): the endpoint event, then answers on the stream', async () => {
  let stream = null;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'GET' && url.pathname === '/sse') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      stream = res;
      res.write('event: endpoint\ndata: /messages?sid=1\n\n');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/messages') {
      const body = await new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => r(b)); });
      const m = JSON.parse(body);
      res.writeHead(202); res.end();
      const reply = r => stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result: r })}\n\n`);
      if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'old' } });
      else if (m.method === 'tools/list') reply({ tools: [{ name: 'ping_me' }] });
      else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: 'pong' }] });
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const home = tmp(), root = tmp();
  const m = manager(home, root);
  m.upsert('old', { type: 'sse', url: `http://127.0.0.1:${server.address().port}/sse` }, 'user');
  await m.ensure(10000);
  const s = m.snapshot().find(x => x.id === 'old');
  assert.strictEqual(s.state, 'connected', s.error);
  assert.strictEqual((await m.call('mcp__old__ping_me', {})).result, 'pong');
  m.dispose();
  if (stream) stream.end();
  server.closeAllConnections();
  server.close();
});

test('resources, prompts as /commands, and a question from the server (elicitation)', async () => {
  const home = tmp(), root = tmp();
  const asked = [];
  const m = manager(home, root, { elicit: async (server, message, schema) => { asked.push([server, message, Object.keys(schema.properties)]); return { action: 'accept', content: { branch: 'main' } }; } });
  m.upsert('fake', { command: node, args: [FAKE] }, 'user');
  await m.ensure(15000);
  assert.deepStrictEqual(m.resourceDefinitions().map(d => d.name), ['list_mcp_resources', 'read_mcp_resource']);
  assert.match((await m.call('list_mcp_resources', {})).result, /fake {2}memo:\/\/one {2}One/);
  assert.strictEqual((await m.call('read_mcp_resource', { server: 'fake', uri: 'memo://one' })).result, 'content of memo://one');
  assert.deepStrictEqual(m.promptCommands().map(c => c.name), ['mcp__fake__review']);
  const p = await m.expandPrompt('/mcp__fake__review src/app.js security issues');
  assert.strictEqual(p.prompt, 'Review src/app.js for security issues');
  assert.strictEqual(await m.expandPrompt('/not_a_prompt x'), null);
  assert.strictEqual((await m.call('mcp__fake__ask', {})).result, 'answer: {"action":"accept","content":{"branch":"main"}}');
  assert.deepStrictEqual(asked, [['fake', 'Which branch?', ['branch']]]);
  m.dispose();
});
