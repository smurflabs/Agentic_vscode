// The hooks editor of /hooks (HookRunner.save / remove / test): a hook added to .agentic/settings.json in Claude Code's
// format, tried with a sample input, and removed. No VS Code needed: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HookRunner, POWERSHELL_EXIT } = require('../out/tools/extras');

const win = process.platform === 'win32';
const shell = win
  ? { exe: 'powershell.exe', args: c => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', c + '\n' + POWERSHELL_EXIT] }
  : { exe: 'bash', args: c => ['-c', c] };

test('hooks editor: add, list, try and remove a hook', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-hooks-'));
  const hooks = new HookRunner(() => [root], () => shell);
  const script = path.join(root, 'h.js');
  fs.writeFileSync(script, "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write('saw '+j.hook_event_name+' '+j.tool_name);process.exit(2)});");
  const cmd = win ? `& '${process.execPath}' '${script}'` : `'${process.execPath}' '${script}'`;
  const file = hooks.save('project', 'PreToolUse', 'Bash', cmd, 20);
  assert.strictEqual(file, path.join(root, '.agentic', 'settings.json'));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(saved.hooks.PreToolUse[0], { matcher: 'Bash', hooks: [{ type: 'command', command: cmd, timeout: 20 }] });
  const listed = hooks.list().hooks.filter(h => h.event === 'PreToolUse');
  assert.strictEqual(listed.length, 1);
  const tried = await hooks.test('PreToolUse', cmd);
  assert.strictEqual(tried.code, 2);
  assert.match(tried.stdout, /saw PreToolUse Bash/);
  assert.throws(() => hooks.save('project', 'NotAnEvent', '', 'x', 0));
  assert.throws(() => hooks.remove(path.join(os.tmpdir(), 'other.json'), 'PreToolUse', 'Bash', cmd));
  assert.ok(hooks.remove(file, 'PreToolUse', 'Bash', cmd));
  assert.strictEqual(hooks.list().hooks.length, 0);
});
