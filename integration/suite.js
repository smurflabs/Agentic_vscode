// Runs inside VS Code's extension host (see run.js): the extension activates, and the workspace tools work through the
// real VS Code APIs against a temporary workspace.
const vscode = require('vscode');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

exports.run = async function run() {
  const results = [];
  const t = async (name, fn) => {
    try { await fn(); results.push('ok   ' + name); }
    catch (e) { results.push('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
  };
  const ws = process.env.AGENTIC_IT_WS;
  const ext = vscode.extensions.getExtension('smurflabs.agentic-vscode');

  await t('extension is found and activates', async () => {
    assert.ok(ext, 'extension not found');
    await ext.activate();
    assert.ok(ext.isActive);
  });

  await t('commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['agentic.openChat', 'agentic.openChatInEditor', 'agentic.newChat', 'agentic.signIn', 'agentic.signOut',
      'agentic.askAboutSelection', 'agentic.explainSelection', 'agentic.fixSelection', 'agentic.reviewFile', 'agentic.fixProblems',
      'agentic.addFileToChat', 'agentic.reload', 'agentic.openInBrowser', 'agentic.showLog', 'agentic.chatView.focus', 'agentic.chatViewSecondary.focus', 'agentic.openMultitask', 'agentic.checkForUpdates',
      'agentic.runProject']) {
      assert.ok(all.includes(c), 'missing ' + c);
    }
  });

  await t('the chat view opens (sign-in screen) without errors', async () => {
    await vscode.commands.executeCommand('agentic.openChat');
  });

  const { WorkspaceTools } = require(path.join(ext.extensionPath, 'out', 'tools', 'workspaceTools'));
  const tools = new WorkspaceTools({ baseUrl: () => '', apiKey: () => undefined, log: () => { }, commandsChannel: vscode.window.createOutputChannel('agentic-it') });
  const run = (name, args) => tools.run(name, JSON.stringify(args));

  await t('workspace folder is the temp workspace', async () => {
    assert.deepStrictEqual(tools.roots().map(r => r.toLowerCase()), [ws.toLowerCase()]);
  });

  await t('definitions + instructions', async () => {
    const names = tools.definitions().map(d => d.name);
    for (const n of ['read_file', 'edit_file', 'run_command', 'run_command_background', 'command_output', 'vscode_diagnostics', 'vscode_editor_context']) assert.ok(names.includes(n), n);
    assert.match(tools.instructions(), /Workspace folders/);
  });

  await t('read_file: numbered lines', async () => {
    const r = await run('read_file', { path: 'hello.txt' });
    assert.ok(r.ok, r.result);
    assert.match(r.result, / {5}2\tbeta/);
  });

  await t('list_dir and glob_files', async () => {
    const l = await run('list_dir', {});
    assert.ok(l.ok && /hello\.txt/.test(l.result), l.result);
    const g = await run('glob_files', { pattern: '**/*.txt' });
    assert.ok(g.ok && /hello\.txt/.test(g.result) && /dup\.txt/.test(g.result), g.result);
  });

  await t('grep', async () => {
    const r = await run('grep', { pattern: 'gam+a' });
    assert.ok(r.ok, r.result);
    assert.match(r.result, /hello\.txt:3: gamma/);
  });

  await t('write_file creates a file (and its folders) through VS Code', async () => {
    const r = await run('write_file', { path: 'new/dir/made.txt', content: 'one\ntwo\n' });
    assert.ok(r.ok, r.result);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'new', 'dir', 'made.txt'), 'utf8'), 'one\ntwo\n');
  });

  await t('write_file overwrites an existing file in its editor, keeping its line endings', async () => {
    const r = await run('write_file', { path: 'new/dir/made.txt', content: 'three\nfour\n' });
    assert.ok(r.ok && /Overwrote/.test(r.result), r.result);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'new', 'dir', 'made.txt'), 'utf8'), 'three\nfour\n');
  });

  await t('edit_file changes the file on disk and in the editor, saved', async () => {
    const r = await run('edit_file', { path: 'hello.txt', old_string: 'beta', new_string: 'BETA' });
    assert.ok(r.ok, r.result);
    assert.strictEqual(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8'), 'alpha\nBETA\ngamma\n');
    const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath.toLowerCase() === path.join(ws, 'hello.txt').toLowerCase());
    assert.ok(doc && !doc.isDirty && doc.getText().includes('BETA'));
  });

  await t('edit_file refuses an ambiguous match', async () => {
    await run('read_file', { path: 'dup.txt' });   // read before change (Claude Code's rule)
    const r = await run('edit_file', { path: 'dup.txt', old_string: 'dup', new_string: 'x' });
    assert.ok(!r.ok);
    assert.match(r.result, /matches 2 places/);
  });

  await t('the edit can be undone in the editor', async () => {
    const o = await run('open_file', { path: 'hello.txt', line: 2 });
    assert.ok(o.ok, o.result);
    await vscode.commands.executeCommand('undo');
    const ed = vscode.window.activeTextEditor;
    assert.ok(ed && ed.document.getText().includes('beta'), 'undo did not restore: ' + (ed && ed.document.getText()));
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  await t('open_file with find selects that text (a click on an edit in the chat)', async () => {
    const r = await run('open_file', { path: 'hello.txt', find: 'gamma' });
    assert.ok(r.ok, r.result);
    const ed = vscode.window.activeTextEditor;
    assert.strictEqual(ed && ed.document.getText(ed.selection), 'gamma');
    assert.match(r.result, /at line 3/);
  });

  await t('editor context names the active file and cursor', async () => {
    await run('open_file', { path: 'hello.txt', line: 3 });
    const r = await run('vscode_editor_context', {});
    assert.ok(r.ok, r.result);
    assert.match(r.result, /Active file: hello\.txt/);
    assert.match(r.result, /Cursor: line 3/);
  });

  await t('read_file sees unsaved changes in an open editor', async () => {
    const ed = vscode.window.activeTextEditor;
    await ed.edit(b => b.insert(new vscode.Position(0, 0), 'UNSAVED '));
    const r = await run('read_file', { path: 'hello.txt' });
    assert.match(r.result, /UNSAVED alpha/);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  await t('diagnostics', async () => {
    const r = await run('vscode_diagnostics', { path: 'hello.txt' });
    assert.ok(r.ok, r.result);
    assert.match(r.result, /No errors in hello\.txt/);
  });

  await t('paths outside the workspace are refused', async () => {
    const r = await run('read_file', { path: '../outside.txt' });
    assert.ok(!r.ok);
    assert.match(r.result, /outside the workspace/);
  });

  await t('background command: output while it runs, then kill', async () => {
    const r = await run('run_command', { command: process.platform === 'win32' ? 'echo bg-start; Start-Sleep 30' : 'echo bg-start; sleep 30', background: true });
    assert.ok(r.ok, r.result);
    const id = /as (bg\d+)/.exec(r.result)[1];
    let out = '';
    for (let i = 0; i < 40 && !out.includes('bg-start'); i++) { await new Promise(res => setTimeout(res, 250)); out += (await run('command_output', { id })).result; }
    assert.match(out, /bg-start/);
    assert.match(out, /running for/);
    const k = await run('kill_command', { id });
    assert.match(k.result, /Stopped/);
  });

  await t('run_command hands a long command over to the background instead of stopping it', async () => {
    const r = await run('run_command', { command: process.platform === 'win32' ? 'echo slow-start; Start-Sleep 60' : 'echo slow-start; sleep 60', wait_seconds: 5 });
    assert.ok(r.ok, r.result);
    assert.match(r.result, /Still running after 5 s/);
    assert.match(r.result, /slow-start/);
    const id = /as (bg\d+)/.exec(r.result)[1];
    assert.match((await run('command_output', { id })).result, /running for/);
    assert.match((await run('kill_command', { id })).result, /Stopped/);
  });

  await t('run_command_background starts a command and returns at once', async () => {
    const r = await run('run_command_background', { command: process.platform === 'win32' ? 'Start-Sleep 30' : 'sleep 30' });
    assert.ok(r.ok, r.result);
    const id = /as (bg\d+)/.exec(r.result)[1];
    assert.match((await run('command_output', {})).result, new RegExp(id + ': .*running for'));
    assert.match((await run('kill_command', { id })).result, /Stopped/);
  });

  await t('edit_notebook replaces, inserts and deletes cells', async () => {
    const nb = { cells: [{ cell_type: 'code', source: ['print(1)'], metadata: {}, outputs: [], execution_count: null }], metadata: {}, nbformat: 4, nbformat_minor: 5 };
    fs.writeFileSync(path.join(ws, 'nb.ipynb'), JSON.stringify(nb));
    await run('read_file', { path: 'nb.ipynb' });   // read before change (Claude Code's rule)
    let r = await run('edit_notebook', { path: 'nb.ipynb', cell: 0, source: 'print(2)' });
    assert.ok(r.ok, r.result);
    r = await run('edit_notebook', { path: 'nb.ipynb', cell: 1, mode: 'insert', source: '# Title', cell_type: 'markdown' });
    assert.ok(r.ok, r.result);
    let saved = JSON.parse(fs.readFileSync(path.join(ws, 'nb.ipynb'), 'utf8'));
    assert.strictEqual(saved.cells.length, 2);
    assert.match([].concat(saved.cells[0].source).join(''), /print\(2\)/);
    assert.strictEqual(saved.cells[1].cell_type, 'markdown');
    r = await run('edit_notebook', { path: 'nb.ipynb', cell: 0, mode: 'delete' });
    assert.ok(r.ok, r.result);
    saved = JSON.parse(fs.readFileSync(path.join(ws, 'nb.ipynb'), 'utf8'));
    assert.strictEqual(saved.cells.length, 1);
    assert.ok(!(await run('edit_notebook', { path: 'nb.ipynb', cell: 9 })).ok);
  });

  await t('PreToolUse hook (exit 2) blocks a call; skills, commands and @mentions reach the instructions', async () => {
    fs.mkdirSync(path.join(ws, '.agentic', 'skills', 'deploy'), { recursive: true });
    fs.mkdirSync(path.join(ws, '.agentic', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agentic', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\nRun the deploy script.');
    fs.writeFileSync(path.join(ws, '.agentic', 'commands', 'fixit.md'), 'Fix the bug in $ARGUMENTS now.');
    const block = process.platform === 'win32' ? "[Console]::Error.WriteLine('no writes here'); exit 2" : 'echo "no writes here" >&2; exit 2';
    fs.writeFileSync(path.join(ws, '.agentic', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: block }] }] } }));
    try {
      const r = await run('write_file', { path: 'blocked.txt', content: 'x' });
      assert.ok(!r.ok);
      assert.match(r.result, /no writes here/);
      assert.ok(!fs.existsSync(path.join(ws, 'blocked.txt')));
      assert.ok((await run('read_file', { path: 'hello.txt' })).ok, 'other tools still run');
      const defs = await tools.allDefinitions();
      assert.ok(defs.some(d => d.name === 'Skill'));
      assert.match((await run('Skill', { skill: 'deploy' })).result, /Run the deploy script/);
      const ins = await tools.allInstructions('/fixit login.js please, see @hello.txt');
      assert.match(ins, /Fix the bug in login\.js please, see @hello\.txt now\./);
      assert.match(ins, /File the user mentioned: @hello\.txt/);
      assert.ok((await tools.listFiles('hello')).some(p => p.endsWith('hello.txt')));
    } finally { fs.rmSync(path.join(ws, '.agentic'), { recursive: true, force: true }); }
  });

  await t('edits are reviewed only in Manual mode, and not when the call was just approved', async () => {
    let asked = 0;
    tools.reviewChange = async () => { asked++; return false; };
    try {
      // Manual: the diff is shown; rejected, the file stays as it was.
      const r = await tools.run('edit_file', JSON.stringify({ path: 'hello.txt', old_string: 'gamma', new_string: 'GAMMA' }), undefined, { mode: 'manual' });
      assert.ok(!r.ok);
      assert.match(r.result, /rejected/);
      assert.strictEqual(asked, 1);
      assert.ok(fs.readFileSync(path.join(ws, 'hello.txt'), 'utf8').includes('gamma'));
      // Auto never asks.
      const auto = await tools.run('write_file', JSON.stringify({ path: 'auto.txt', content: 'x' }), undefined, { mode: 'auto' });
      assert.ok(auto.ok, auto.result);
      // Manual, but the user just approved this call in the chat: no second question.
      const ok2 = await tools.run('write_file', JSON.stringify({ path: 'approved.txt', content: 'y' }), undefined, { mode: 'manual', approved: true });
      assert.ok(ok2.ok, ok2.result);
      // No mode (an older server): never asks.
      const old = await tools.run('write_file', JSON.stringify({ path: 'old.txt', content: 'z' }));
      assert.ok(old.ok, old.result);
      assert.strictEqual(asked, 1);
    } finally { tools.reviewChange = undefined; }
  });

  await t('a change accepted in part: the file gets what the user kept, and the model hears it', async () => {
    const file = path.join(ws, 'part.txt');
    fs.writeFileSync(file, 'one\ntwo\n');
    // The user reverted one change in the diff before accepting: the review answers with the text as they left it.
    tools.reviewChange = async (full, before, after) => after.replace('KEEP-NOT', 'kept-not');
    try {
      assert.ok((await run('read_file', { path: 'part.txt' })).ok);
      const w = await tools.run('write_file', JSON.stringify({ path: 'part.txt', content: 'one\nTWO\nKEEP-NOT\n' }), undefined, { mode: 'manual' });
      assert.ok(w.ok, w.result);
      assert.match(w.result, /accepted only part/);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one\nTWO\nkept-not\n');
      assert.ok((await run('read_file', { path: 'part.txt' })).ok);
      tools.reviewChange = async () => true;
      const e = await tools.run('edit_file', JSON.stringify({ path: 'part.txt', old_string: 'TWO', new_string: 'TWO-B' }), undefined, { mode: 'manual' });
      assert.ok(e.ok && !/accepted only part/.test(e.result), e.result);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one\nTWO-B\nkept-not\n');
      // Apply from the chat (a code block): reviewed first; rejected, nothing is written.
      tools.reviewChange = async () => false;
      const no = await tools.applyFromChat('part.txt', 'replaced\n');
      assert.ok(!no.applied && /rejected/.test(no.result), no.result);
      tools.reviewChange = async () => true;
      const yes = await tools.applyFromChat('part.txt', 'replaced\n');
      assert.ok(yes.applied, yes.result);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), 'replaced\n');
    } finally { tools.reviewChange = undefined; fs.rmSync(file, { force: true }); }
  });

  await t('the light bulb: Fix with Agentic on a problem, Explain and Fix on a selection', async () => {
    const uri = vscode.Uri.file(path.join(ws, 'hello.txt'));
    const coll = vscode.languages.createDiagnosticCollection('agentic-it');
    coll.set(uri, [new vscode.Diagnostic(new vscode.Range(1, 0, 1, 4), 'beta is not defined', vscode.DiagnosticSeverity.Error)]);
    try {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
      const onProblem = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, new vscode.Range(1, 1, 1, 1));
      assert.ok(onProblem.some(a => /^Fix with Agentic: beta is not defined/.test(a.title)), onProblem.map(a => a.title).join(' | '));
      const onSel = await vscode.commands.executeCommand('vscode.executeCodeActionProvider', uri, new vscode.Range(0, 0, 2, 0));
      assert.ok(onSel.some(a => a.title === 'Explain with Agentic') && onSel.some(a => a.title === 'Fix with Agentic'), onSel.map(a => a.title).join(' | '));
      assert.ok((await vscode.commands.getCommands(true)).includes('agentic.fixDiagnostic'));
    } finally { coll.dispose(); }
  });

  await t('the IDE bridge for the CLI: lock file, the selection, problems, open; a wrong token is refused', async () => {
    const os = require('os');
    const dir = process.env.AGENTIC_IDE_DIR || path.join(os.homedir(), '.agentic', 'ide');
    let lock = null;
    for (let i = 0; i < 50 && !lock; i++) {
      lock = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
        .find(j => j && j.pid === process.pid) || null;
      if (!lock) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(lock, 'no lock file for this VS Code in ' + dir);
    assert.ok(lock.workspaceFolders.some(f => f.toLowerCase() === ws.toLowerCase()), JSON.stringify(lock.workspaceFolders));
    const call = (method, route, body, token = lock.token) => fetch(`http://127.0.0.1:${lock.port}${route}`, {
      method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.strictEqual((await call('GET', '/state', null, 'wrong')).status, 401);
    const uri = vscode.Uri.file(path.join(ws, 'hello.txt'));
    const ed = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    ed.selection = new vscode.Selection(1, 0, 2, 5);
    const st = await (await call('GET', '/state')).json();
    assert.strictEqual(st.selection.startLine, 2);
    assert.strictEqual(st.selection.text, ed.document.getText(ed.selection));
    assert.ok(st.selection.text.length > 0, 'the selection is empty');
    assert.strictEqual(st.activeFile.toLowerCase(), uri.fsPath.toLowerCase());
    const coll = vscode.languages.createDiagnosticCollection('agentic-it2');
    coll.set(uri, [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), 'alpha is odd', vscode.DiagnosticSeverity.Warning)]);
    try {
      const diags = await (await call('GET', '/diagnostics?path=' + encodeURIComponent(uri.fsPath))).json();
      assert.ok(diags.some(d => d.message === 'alpha is odd' && d.line === 1 && d.severity === 'warning'), JSON.stringify(diags));
    } finally { coll.dispose(); }
    assert.ok((await call('POST', '/open', { path: 'hello.txt', line: 3 })).ok);
    assert.strictEqual(vscode.window.activeTextEditor.selection.active.line, 2);
  });

  await t('run_command runs in the workspace', async () => {
    const r = await run('run_command', { command: 'echo agentic-ok' });
    assert.ok(r.ok, r.result);
    assert.match(r.result, /Exit code 0/);
    assert.match(r.result, /agentic-ok/);
  });

  await t('run_command reports a failing exit code', async () => {
    const r = await run('run_command', { command: process.platform === 'win32' ? 'exit 3' : 'exit 3' });
    assert.ok(!r.ok);
    assert.match(r.result, /Exit code 3/);
  });

  await t('MCP Servers command and page commands are registered', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const c of ['agentic.mcpServers', 'agentic.addMcpServer', 'agentic.liteMode', 'agentic.fullMode', 'agentic.toggleChatMode']) assert.ok(all.includes(c), 'missing ' + c);
  });

  await t('vscode_command lists and runs VS Code commands', async () => {
    const listed = await run('vscode_command', { list: 'workbench.action.files.save' });
    assert.ok(listed.ok && listed.result.includes('workbench.action.files.save'), listed.result);
    const r = await run('vscode_command', { command: 'workbench.action.files.saveAll' });
    assert.ok(r.ok, r.result);
  });

  await t('ide_navigate: symbols and definitions from the language server', async () => {
    fs.writeFileSync(path.join(ws, 'nav.js'), 'function greet(name) {\n  return "hi " + name;\n}\ngreet("x");\n');
    let r;
    // The JavaScript language server may need a moment to start.
    for (let i = 0; i < 40; i++) {
      r = await run('ide_navigate', { action: 'symbols', path: 'nav.js' });
      if (r.ok && r.result.includes('greet')) break;
      await new Promise(res => setTimeout(res, 500));
    }
    assert.match(r.result, /greet/);
    const d = await run('ide_navigate', { action: 'definition', path: 'nav.js', line: 4, symbol: 'greet' });
    assert.ok(d.ok && /nav\.js:1:/.test(d.result), d.result);
  });

  await t('a project .mcp.json server waits to be allowed (it does not start by itself)', async () => {
    fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { repo: { command: 'node', args: ['-e', 'process.exit(1)'] } } }));
    await tools.mcp.ensure(0);
    const s = tools.mcp.snapshot().find(x => x.id === 'repo');
    assert.ok(s, 'the server is listed');
    assert.strictEqual(s.state, 'approval');
    assert.ok(!tools.mcp.definitions().some(d => d.name.startsWith('mcp__repo__')));
    fs.unlinkSync(path.join(ws, '.mcp.json'));
  });

  await t('agentic_api without a server says so', async () => {
    const r = await run('agentic_api', { method: 'GET', path: '/api/chat/meta' });
    assert.ok(!r.ok);
    assert.match(r.result, /No Agentic server/);
  });

  await t('the layer path: /api/local prepare + run through the proxy into the tools', async () => {
    const { LocalProxy } = require(path.join(ext.extensionPath, 'out', 'proxy'));
    const { localApi } = require(path.join(ext.extensionPath, 'out', 'localApi'));
    const config = { deviceId: () => 'vscode-test', machineName: () => 'test (VS Code)' };
    const proxy = new LocalProxy({ baseUrl: () => '', apiKey: () => undefined, token: 'tok', headTags: () => '', staticFile: () => undefined, local: localApi(tools, config, '0.0.0', () => { }) });
    const port = await proxy.start();
    try {
      const call = async (route, body) => {
        const res = await fetch(`http://127.0.0.1:${port}/api/local/${route}`, { method: 'POST', headers: { 'X-Vscode-Token': 'tok', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, json: await res.json() };
      };
      const prep = await call('chat/prepare', {});
      assert.strictEqual(prep.status, 200);
      assert.strictEqual(prep.json.device, 'vscode-test');
      assert.ok(prep.json.tools.some(d => d.name === 'edit_file' && d['x-risk'] === 'change'));
      // Arguments arrive as the model wrote them: a JSON string.
      const ran = await call('chat/run', { name: 'grep', arguments: JSON.stringify({ pattern: 'alpha' }) });
      assert.strictEqual(ran.status, 200);
      assert.ok(ran.json.ok, ran.json.result);
      assert.match(ran.json.result, /hello\.txt:1: alpha/);
      // Copy buttons: VS Code copies (the webview does not let the page use the clipboard).
      const copied = await call('clipboard', { text: 'copied from the chat' });
      assert.strictEqual(copied.status, 200);
      assert.strictEqual(await vscode.env.clipboard.readText(), 'copied from the chat');
      const denied = await fetch(`http://127.0.0.1:${port}/api/local/chat/run`, { method: 'POST', body: '{}' });
      assert.strictEqual(denied.status, 403);
    } finally { proxy.stop(); }
  });

  await t('Dictation mode: VS Code records the microphone, the server turns the turn into text', async () => {
    const { LocalProxy } = require(path.join(ext.extensionPath, 'out', 'proxy'));
    const { localApi } = require(path.join(ext.extensionPath, 'out', 'localApi'));
    const { SpeechInput } = require(path.join(ext.extensionPath, 'out', 'speech'));
    const http = require('http');
    // The Agentic server's speech-to-text: it gets a WAV with the user's key.
    let got = null;
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        got = { url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks) };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: 'hello from the server' }));
      });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const mic = `"${process.execPath}" "${path.join(ext.extensionPath, 'test', 'fake-mic.js')}" q600,t1200,q6000`;
    const speech = new SpeechInput(() => mic);
    const config = { deviceId: () => 'vscode-test', machineName: () => 'test', baseUrl: () => base, apiKey: () => 'it-key' };
    const proxy = new LocalProxy({ baseUrl: () => '', apiKey: () => undefined, token: 'tok', headTags: () => '', staticFile: () => undefined,
      local: localApi(tools, config, '0.0.0', () => { }, () => false, speech) });
    const port = await proxy.start();
    const lapi = async (method, route, body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/local/${route}`, { method, headers: { 'X-Vscode-Token': 'tok', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json() };
    };
    try {
      const states = [];
      const poll = setInterval(async () => { try { states.push((await lapi('GET', 'speech/state')).json.state); } catch { /* next */ } }, 100);
      const heard = await lapi('POST', 'speech/listen', { silenceMs: 700, sensitivity: 5, language: 'en' });
      clearInterval(poll);
      assert.strictEqual(heard.status, 200, JSON.stringify(heard.json));
      assert.strictEqual(heard.json.text, 'hello from the server');
      assert.ok(states.includes('listening'), states.join(','));
      assert.strictEqual(got.auth, 'Bearer it-key');
      assert.match(got.url, /^\/api\/chat\/transcribe\?name=speech\.wav&language=en$/);
      assert.strictEqual(got.body.toString('ascii', 0, 4), 'RIFF');
      // Pause: the turn is thrown away and nothing goes to the server.
      got = null;
      const turn = lapi('POST', 'speech/listen', { silenceMs: 700 });
      await new Promise(r => setTimeout(r, 400));
      await lapi('POST', 'speech/stop', { discard: true });
      assert.strictEqual((await turn).json.text, '');
      assert.strictEqual(got, null);
      await lapi('POST', 'speech/release', {});
      assert.strictEqual((await lapi('GET', 'speech/state')).json.state, 'idle');
    } finally { proxy.stop(); srv.close(); speech.release(); }
    // The Images, Music and Audio tabs open in an editor tab.
    const cmds = await vscode.commands.getCommands(true);
    for (const id of ['agentic.openImages', 'agentic.openMusic', 'agentic.openAudio']) assert.ok(cmds.includes(id), id);
  });

  await t('run the project: launch.json, the run routes, a terminal per run (closing it stops the run), tests, the preview', async () => {
    const { attachTerminals, showPreview } = require(path.join(ext.extensionPath, 'out', 'runView'));
    const { LocalProxy } = require(path.join(ext.extensionPath, 'out', 'proxy'));
    const { localApi } = require(path.join(ext.extensionPath, 'out', 'localApi'));
    const site = path.join(ws, 'site');
    fs.mkdirSync(site, { recursive: true });
    fs.writeFileSync(path.join(site, 'index.html'), '<title>IT site</title>');
    fs.mkdirSync(path.join(ws, '.agentic'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.agentic', 'launch.json'), JSON.stringify({ configurations: [
      { name: 'Site', kind: 'static', cwd: 'site' }, { name: 'Echo tests', command: 'echo it-tests-ok; exit 4', kind: 'test' }] }));
    const terms = attachTerminals(tools.runner);
    const proxy = new LocalProxy({ baseUrl: () => '', apiKey: () => undefined, token: 'tok', headTags: () => '', staticFile: () => undefined,
      local: localApi(tools, { deviceId: () => 'vscode-test', machineName: () => 'test' }, '0.0.0', () => { }) });
    const port = await proxy.start();
    const lapi = async (method, route, body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/local/${route}`, { method, headers: { 'X-Vscode-Token': 'tok', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: res.status, json: await res.json() };
    };
    try {
      const cfgs = await lapi('GET', 'run/configs');
      assert.deepStrictEqual(cfgs.json.configs.map(c => [c.id, c.kind, c.source]), [['site', 'static', '.agentic/launch.json'], ['echo-tests', 'test', '.agentic/launch.json']]);
      assert.strictEqual((await lapi('POST', 'run/start', { id: 'site' })).json.started, 'site');
      const st = (await lapi('GET', 'run/status')).json.find(s => s.id === 'site');
      assert.ok(st.running && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(st.url), JSON.stringify(st));
      assert.match(await (await fetch(st.url)).text(), /IT site/);
      assert.match((await lapi('POST', 'run/log', { id: 'site', from: 0 })).json.text, /Serving .*site/);
      assert.strictEqual((await lapi('POST', 'run/start', { id: 'nope' })).status, 400);
      const term = vscode.window.terminals.find(x => x.name === 'Agentic: Site');
      assert.ok(term && terms.has('site'), 'no terminal: ' + vscode.window.terminals.map(x => x.name).join(', '));
      // The model's tool: tests end with their own exit code and output.
      const r = await run('preview', { action: 'start', name: 'echo tests' });
      assert.ok(!r.ok, r.result);
      assert.match(r.result, /exit code 4/);
      assert.match(r.result, /it-tests-ok/);
      // Closing the run's terminal tab stops it.
      term.dispose();
      for (let i = 0; i < 50 && tools.runner.status().find(s => s.id === 'site').running; i++) await new Promise(res => setTimeout(res, 100));
      assert.ok(!tools.runner.status().find(s => s.id === 'site').running, 'closing the terminal did not stop the run');
      // The preview: VS Code's Simple Browser (a built-in extension; skipped when this test profile has none).
      if (vscode.extensions.getExtension('vscode.simple-browser')) {
        await tools.runner.start('site');
        await showPreview(tools.runner.status().find(s => s.id === 'site').url);
        let tab;
        for (let i = 0; i < 50 && !tab; i++) {
          // A Simple Browser webview; newer VS Code shows its own browser tab, named after the page.
          tab = vscode.window.tabGroups.all.flatMap(g => g.tabs).find(x => (x.input instanceof vscode.TabInputWebview && /simpleBrowser/i.test(x.input.viewType)) || x.label === 'IT site');
          if (!tab) await new Promise(res => setTimeout(res, 100));
        }
        assert.ok(tab, 'no Simple Browser tab: ' + vscode.window.tabGroups.all.flatMap(g => g.tabs).map(x => `${x.label} [${x.input && x.input.constructor && x.input.constructor.name} ${x.input && (x.input.viewType || '')}]`).join(', '));
        await vscode.window.tabGroups.close(tab);
      } else {
        console.log('     (Simple Browser is not available here: preview skipped)');
      }
    } finally {
      tools.runner.stopAll();
      proxy.stop();
      fs.rmSync(path.join(ws, '.agentic'), { recursive: true, force: true });
      fs.rmSync(site, { recursive: true, force: true });
    }
  });

  await t('share a project: its website is zipped and sent to the server with the key, through the run routes', async () => {
    const http = require('http');
    const { LocalProxy } = require(path.join(ext.extensionPath, 'out', 'proxy'));
    const { localApi } = require(path.join(ext.extensionPath, 'out', 'localApi'));
    const { WorkspaceTools } = require(path.join(ext.extensionPath, 'out', 'tools', 'workspaceTools'));
    let got = null;
    const srv = http.createServer((req, res) => {
      const parts = [];
      req.on('data', c => parts.push(c));
      req.on('end', () => {
        got = { url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: Buffer.concat(parts) };
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ link: { token: 'tok1', kind: 'site', title: 'workspace', url: 'https://agentic.example/a/tok1' }, updated: false }));
      });
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    fs.mkdirSync(path.join(ws, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'dist', 'index.html'), '<title>IT build</title>');
    const tools2 = new WorkspaceTools({ baseUrl: () => `http://127.0.0.1:${srv.address().port}`, apiKey: () => 'it-key', log: () => { }, commandsChannel: vscode.window.createOutputChannel('agentic-it2'), deviceId: () => 'vs-it' });
    const proxy = new LocalProxy({ baseUrl: () => '', apiKey: () => undefined, token: 'tok', headTags: () => '', staticFile: () => undefined,
      local: localApi(tools2, { deviceId: () => 'vs-it', machineName: () => 'test' }, '0.0.0', () => { }) });
    const port = await proxy.start();
    try {
      const projects = await (await fetch(`http://127.0.0.1:${port}/api/local/run/projects`, { headers: { 'X-Vscode-Token': 'tok' } })).json();
      assert.strictEqual(projects.length, 1);
      assert.strictEqual(projects[0].share, 'dist');
      assert.match(projects[0].key, /^vs-it:p[0-9a-f]{10}$/);
      const res = await fetch(`http://127.0.0.1:${port}/api/local/run/share`, { method: 'POST', headers: { 'X-Vscode-Token': 'tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ id: projects[0].id }) });
      const body = await res.json();
      assert.strictEqual(res.status, 200, JSON.stringify(body));
      assert.strictEqual(body.link.url, 'https://agentic.example/a/tok1');
      assert.ok(got, 'nothing reached the server');
      assert.match(got.url, /^\/api\/chat\/artifacts\/share-site\?title=workspace&source=workspace&key=vs-it%3Ap[0-9a-f]{10}$/);
      assert.strictEqual(got.auth, 'Bearer it-key');
      assert.strictEqual(got.type, 'application/zip');
      assert.strictEqual(got.body.subarray(0, 2).toString(), 'PK');
      assert.ok(got.body.includes(Buffer.from('index.html')));
      const bad = await fetch(`http://127.0.0.1:${port}/api/local/open-url`, { method: 'POST', headers: { 'X-Vscode-Token': 'tok', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'file:///etc/passwd' }) });
      assert.strictEqual(bad.status, 400);
    } finally {
      proxy.stop();
      srv.close();
      fs.rmSync(path.join(ws, 'dist'), { recursive: true, force: true });
    }
  });

  await t('Artifacts: the command opens the chat tab on the Artifacts page', async () => {
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes('agentic.openArtifacts'));
  });

  await t('auto-update: asks the server, refuses a wrong SHA-256, installs the .vsix through VS Code', async () => {
    const vsixPath = process.env.AGENTIC_IT_VSIX;
    if (!vsixPath || !fs.existsSync(vsixPath)) { console.log('     (skipped: no packaged .vsix; run npm run package first)'); return; }
    const http = require('http');
    const crypto = require('crypto');
    const bytes = fs.readFileSync(vsixPath);
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const seen = [];
    let shaToSend = 'deadbeef'.repeat(8);
    const srv = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      if (req.url.startsWith('/api/updates/vscode/download')) { res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(bytes); return; }
      if (req.url.startsWith('/api/updates/vscode')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ updateAvailable: true, mandatory: false, checkIntervalMinutes: 360,
          latest: { version: '9.9.9', sha256: shaToSend, downloadUrl: '/api/updates/vscode/download', notes: 'Test build' } }));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const cfg = vscode.workspace.getConfiguration('agentic');
    const extDir = process.env.AGENTIC_IT_EXTDIR;
    const installed = () => fs.existsSync(extDir) && fs.readdirSync(extDir).some(d => d.toLowerCase().startsWith('smurflabs.agentic-vscode-'));
    try {
      await cfg.update('serverUrl', `http://127.0.0.1:${srv.address().port}`, vscode.ConfigurationTarget.Global);
      // A download that does not match its SHA-256 is never installed.
      await vscode.commands.executeCommand('agentic.checkForUpdates');
      assert.ok(!installed(), 'installed despite a wrong SHA-256');
      const check = seen.find(x => x.url.startsWith('/api/updates/vscode?'));
      assert.ok(check, 'the server was not asked');
      assert.ok(check.url.includes('version=' + ext.packageJSON.version), check.url);
      assert.match(check.url, /installId=vscode-[0-9a-f]+/);
      assert.strictEqual(check.auth, 'Bearer it-key');
      // The right file is installed through VS Code.
      shaToSend = sha;
      await vscode.commands.executeCommand('agentic.checkForUpdates');
      for (let i = 0; i < 100 && !installed(); i++) await new Promise(r => setTimeout(r, 200));
      assert.ok(installed(), 'the .vsix was not installed into ' + extDir + ' — requests: ' + seen.map(x => x.url).join(' | '));
    } finally {
      srv.close();
      await cfg.update('serverUrl', undefined, vscode.ConfigurationTarget.Global);
    }
  });

  console.log('\n' + results.join('\n') + '\n');
  const failed = results.filter(r => r.startsWith('FAIL'));
  if (failed.length) throw new Error(`${failed.length} of ${results.length} integration checks failed`);
};
