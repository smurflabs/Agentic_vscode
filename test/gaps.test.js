// Tests for what the chat gets from VS Code beyond the tools: agent files (/agents), git worktrees (/worktree), /diff,
// SessionStart and UserPromptSubmit hooks, and the background command list (/bashes, /monitors).
// No VS Code needed: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { frontMatter, agentDefs, saveAgent, worktreeName, worktreeCommand, diffOf, PromptHooks } = require('../out/tools/gaps');
const { BackgroundCommands, HookRunner } = require('../out/tools/extras');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-gaps-'));
const git = (dir, ...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
const hasGit = !git(os.tmpdir(), '--version').error;

test('front matter: keys, quotes and list items', () => {
  const { front, body } = frontMatter('---\nname: "reviewer"\ndescription: Reviews code\ntools:\n  - Read\n  - Grep\nmodel: sonnet\n---\nYou review.\n');
  assert.strictEqual(front.name, 'reviewer');
  assert.strictEqual(front.tools, 'Read, Grep');
  assert.strictEqual(body.trim(), 'You review.');
  assert.deepStrictEqual(frontMatter('no front matter').front, {});
});

test('agent files: the project wins over the user, and a new one is saved where Claude Code reads it', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'rev.md'), '---\nname: reviewer\ndescription: Reviews\ntools: Read, Grep\n---\nCheck for bugs.\n');
  fs.writeFileSync(path.join(root, '.claude', 'agents', 'empty.md'), '---\nname: empty\n---\n');
  const list = agentDefs([root]).filter(a => a.file.startsWith(root));
  assert.deepStrictEqual(list.map(a => a.name), ['reviewer']);
  assert.deepStrictEqual(list[0].tools, ['Read', 'Grep']);
  assert.strictEqual(list[0].prompt, 'Check for bugs.');
  const file = saveAgent([root], { name: 'Test Writer', description: 'Writes\ntests', tools: ['Read', 'Write'], prompt: 'Write tests.' });
  assert.strictEqual(file, path.join(root, '.claude', 'agents', 'test-writer.md'));
  assert.match(fs.readFileSync(file, 'utf8'), /^---\nname: test-writer\ndescription: Writes tests\ntools: Read, Write\n---\n\nWrite tests\.\n$/);
  assert.throws(() => saveAgent([root], { name: 'test-writer', prompt: 'again' }), /already/);
  assert.throws(() => saveAgent([root], { name: 'x' }), /instructions/);
});

test('worktree names', () => {
  assert.strictEqual(worktreeName(' my feature! '), 'my-feature');
  assert.match(worktreeName(''), /^session-\d{4}-\d{6}$/);
});

test('/worktree makes a worktree, works in it, goes back and removes it; /diff shows changes', { skip: !hasGit }, () => {
  const repo = fs.realpathSync.native(tmp());
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'first');
  const tools = { worktreeRoot: null, roots() { return this.worktreeRoot ? [this.worktreeRoot, repo] : [repo]; } };
  const made = worktreeCommand(tools, 'feature');
  assert.ok(made.ok, made.message);
  assert.strictEqual(path.resolve(tools.worktreeRoot), path.resolve(repo, '.agentic', 'worktrees', 'feature'));
  assert.ok(fs.existsSync(path.join(tools.worktreeRoot, 'a.txt')));
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /\/\.agentic\/worktrees\//);
  assert.match(worktreeCommand(tools, 'list').list, /feature/);
  // The same name again: the same worktree.
  assert.ok(worktreeCommand(tools, 'feature').ok);
  assert.ok(worktreeCommand(tools, 'done').ok);
  assert.strictEqual(tools.worktreeRoot, null);
  assert.strictEqual(worktreeCommand(tools, 'done').ok, false);
  assert.ok(worktreeCommand(tools, 'remove feature').ok);
  assert.ok(!fs.existsSync(path.join(repo, '.agentic', 'worktrees', 'feature')));

  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  const d = diffOf(repo);
  assert.match(d.status, /a\.txt/);
  assert.match(d.diff, /-one\n\+two/);
  assert.match(diffOf(tmp()).error, /not in a git repository/);
});

test('SessionStart once per chat, UserPromptSubmit every time; exit 2 stops the message; output goes with the next one', async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  // Each hook is a small script (no quoting games with the shell): it reads its JSON, prints, and exits.
  let n = 0;
  const script = (code, text) => {
    const file = path.join(root, `hook${++n}.js`);
    fs.writeFileSync(file, `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(text)});process.exit(${code})});`);
    return `${process.execPath} ${file}`;
  };
  fs.writeFileSync(path.join(root, '.agentic', 'settings.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: script(0, 'branch main') }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: script(0, 'ticket 42') }] }]
    }
  }));
  const shell = process.platform === 'win32' ? { exe: 'cmd.exe', args: c => ['/d', '/s', '/c', c] } : { exe: 'bash', args: c => ['-c', c] };
  const hooks = new HookRunner(() => [root], () => shell);
  const ph = new PromptHooks({ hooks });
  const first = await ph.check('hello', 'chat_1');
  assert.match(first.context, /branch main/);
  assert.match(first.context, /ticket 42/);
  assert.match(ph.take(), /<hook-output>\n[\s\S]*ticket 42[\s\S]*<\/hook-output>/);
  assert.strictEqual(ph.take(), '');
  const second = await ph.check('again', 'chat_1');
  assert.doesNotMatch(second.context, /branch main/);
  assert.strictEqual(hooks.list().hooks.map(h => h.event).sort().join(','), 'SessionStart,UserPromptSubmit');
  fs.writeFileSync(path.join(root, '.agentic', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: script(2, 'no secrets') }] }] } }));
  const blocked = await ph.check('my password is x', 'chat_1');
  assert.match(blocked.blocked, /no secrets/);
});

test('background commands are listed as commands or monitors', async () => {
  const bg = new BackgroundCommands();
  const shell = process.platform === 'win32' ? { exe: 'cmd.exe', args: c => ['/d', '/s', '/c', c] } : { exe: 'bash', args: c => ['-c', c] };
  const a = bg.start(shell.exe, shell.args('echo hi'), os.tmpdir(), 'echo hi');
  const b = bg.start(shell.exe, shell.args('echo log'), os.tmpdir(), 'echo log');
  bg.tag(b, 'monitor', 'the log');
  await bg.waitFor(a, 5000); await bg.waitFor(b, 5000);
  const list = bg.entries();
  assert.strictEqual(list.find(j => j.id === a).kind, 'command');
  const m = list.find(j => j.id === b);
  assert.strictEqual(m.kind, 'monitor');
  assert.strictEqual(m.description, 'the log');
  assert.match(list.find(j => j.id === a).output, /hi/);
});
