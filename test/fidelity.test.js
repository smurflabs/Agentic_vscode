// Tests for the Claude Code rules the workspace tools follow: line endings kept per line, hooks' JSON answers (block, deny,
// updatedInput, additionalContext, per-hook timeout), and the folder a command ends in (a cd carries over).
// No VS Code needed: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyEdit, restoreEndings } = require('../out/tools/core');
const { HookRunner, BackgroundCommands, readHookAnswer, splitCwd, stripCwd, withCwdMarker, POWERSHELL_EXIT } = require('../out/tools/extras');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-fid-'));
const win = process.platform === 'win32';
// The same arguments as the extension's Windows PowerShell shell.
const shell = win
  ? { exe: 'powershell.exe', args: c => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', c + '\n' + POWERSHELL_EXIT] }
  : { exe: 'bash', args: c => ['-c', c] };

test('line endings: unchanged lines keep theirs, replaced lines one for one, new lines the usual one', () => {
  assert.strictEqual(restoreEndings('a\r\nb\nc\r\nd\n', 'a\nb\nC\nd\n'), 'a\r\nb\nC\r\nd\n');
  assert.strictEqual(restoreEndings('x\r\ny\r\nz\n', 'x\nnew\ny\nz\n'), 'x\r\nnew\r\ny\r\nz\n');
  assert.strictEqual(restoreEndings('only lf\n', 'only\r\nlf\n'), 'only\nlf\n');
  const r = applyEdit('one\r\ntwo\nthree\r\n', 'two', '2');
  assert.strictEqual(r.text, 'one\r\n2\nthree\r\n');
});

test('hook answers: block, deny, allow, updatedInput, additionalContext and plain text', () => {
  const res = () => ({ blocked: false, message: '' });
  let r = res(), printed = [];
  readHookAnswer('{"decision":"block","reason":"no"}', r, printed);
  assert.deepStrictEqual([r.blocked, r.message], [true, 'no']);
  r = res(); readHookAnswer('{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"secret"}}', r, printed);
  assert.deepStrictEqual([r.blocked, r.decision, r.message], [true, 'deny', 'secret']);
  r = res(); readHookAnswer('{"hookSpecificOutput":{"decision":{"behavior":"allow","updatedInput":{"command":"ls"}}}}', r, printed);
  assert.deepStrictEqual([r.blocked, r.decision, r.updatedInput], [false, 'allow', { command: 'ls' }]);
  r = res(); readHookAnswer('{"hookSpecificOutput":{"additionalContext":"use pnpm"}}', r, printed);
  assert.strictEqual(r.context, 'use pnpm');
  r = res(); readHookAnswer('{"continue":false,"stopReason":"enough"}', r, printed);
  assert.deepStrictEqual([r.blocked, r.message], [true, 'enough']);
  printed = []; r = res(); readHookAnswer('just text', r, printed);
  assert.deepStrictEqual(printed, ['just text']);
});

test('hooks: JSON from a real hook rewrites the input; SessionStart matchers see the source; timeouts apply', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  const script = path.join(root, 'hook.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify({hookSpecificOutput:{updatedInput:{command:"echo safe"},additionalContext:"ctx"}}));');
  const slow = path.join(root, 'slow.js');
  fs.writeFileSync(slow, 'setTimeout(() => {}, 10000);');
  const node = JSON.stringify(process.execPath);
  const call = f => win ? `& ${node} ${JSON.stringify(f)}` : `${node} ${JSON.stringify(f)}`;
  fs.writeFileSync(path.join(root, '.agentic', 'settings.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: call(script) }] }],
      SessionStart: [{ matcher: 'resume', hooks: [{ type: 'command', command: call(script) }] }],
      Stop: [{ hooks: [{ type: 'command', command: call(slow), timeout: 1 }] }]
    }
  }));
  const hooks = new HookRunner(() => [root], () => shell);
  const pre = await hooks.run('PreToolUse', 'run_command', { tool_input: { command: 'rm -rf x' } });
  assert.deepStrictEqual(pre.updatedInput, { command: 'echo safe' });
  assert.strictEqual(pre.context, 'ctx');
  assert.strictEqual((await hooks.run('SessionStart', 'startup', { source: 'startup' })).context, undefined);
  assert.strictEqual((await hooks.run('SessionStart', 'resume', { source: 'resume' })).context, 'ctx');
  const started = Date.now();
  const stop = await hooks.run('Stop', '', {});
  assert.ok(Date.now() - started < 8000, 'the 1 s timeout stopped the hook');
  assert.strictEqual(stop.blocked, false);
});

test('hooks: a program that exits with 2 blocks, also when the shell is PowerShell', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  const script = path.join(root, 'deny.js');
  fs.writeFileSync(script, 'process.stderr.write("not this one"); process.exit(2);');
  const node = JSON.stringify(process.execPath);
  fs.writeFileSync(path.join(root, '.agentic', 'settings.json'), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: (win ? '& ' : '') + `${node} ${JSON.stringify(script)}` }] }] }
  }));
  const r = await new HookRunner(() => [root], () => shell).run('UserPromptSubmit', '', { prompt: 'x' });
  assert.deepStrictEqual([r.blocked, r.message], [true, 'not this one']);
});

test('commands: the folder a command ends in is reported, its exit code kept, and the line left out of the output', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'sub'));
  const bg = new BackgroundCommands();
  const command = win ? 'cd sub; Write-Output hello; cmd /c exit 3' : 'cd sub; echo hello; sh -c "exit 3"';
  const id = bg.start(shell.exe, shell.args(withCwdMarker(command, shell.exe)), root, command);
  assert.strictEqual(await bg.waitFor(id, 60000), 'finished');
  const split = splitCwd(bg.takeRaw(id));
  assert.match(split.text, /hello/);
  assert.doesNotMatch(split.text, /__AGENTIC_CWD__/);
  assert.strictEqual(fs.realpathSync.native(split.folder), fs.realpathSync.native(path.join(root, 'sub')));
  assert.strictEqual(bg.exitCode(id), 3);
  assert.strictEqual(stripCwd('a\n__AGENTIC_CWD__=C:\\x\nb'), 'a\nb');
  assert.strictEqual(withCwdMarker('dir', 'cmd.exe'), 'dir');
});
