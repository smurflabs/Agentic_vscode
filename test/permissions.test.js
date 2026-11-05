// Claude Code's permission rules for the tools on this computer (src/tools/permissions.ts): translated to the Agentic
// server's rules, read from the settings files, and deny checked here. Paths outside the workspace ask (core.ts).
// No VS Code needed: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { translateRule, loadRules, matchingRule, callTarget } = require('../out/tools/permissions');
const { resolveInside, OutsideWorkspaceError } = require('../out/tools/core');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-perm-'));

test('rules: Claude Code tools become the tools here, with their arguments', () => {
  assert.deepStrictEqual(translateRule('Bash(npm test:*)'), ['run_command(npm test*)', 'run_command_background(npm test*)', 'monitor(npm test*)']);
  assert.deepStrictEqual(translateRule('Bash(git status)'), ['run_command(git status)', 'run_command_background(git status)', 'monitor(git status)']);
  assert.deepStrictEqual(translateRule('mcp__github'), ['mcp__github__*']);
  assert.deepStrictEqual(translateRule('mcp__github__create_issue'), ['mcp__github__create_issue']);
  assert.deepStrictEqual(translateRule('WebFetch(domain:example.com)'), ['read_page(*example.com*)']);
  assert.ok(translateRule('Read(./.env)').includes('read_file(*/.env)'));
  assert.ok(translateRule('Edit(src/**)').includes('write_file(src/*)'));
  assert.ok(translateRule('Read(//c/secrets/**)').includes('read_file(/c/secrets/*)'));
  assert.deepStrictEqual(translateRule('Write'), ['write_file']);
  assert.deepStrictEqual(translateRule('not a rule ('), []);
});

test('rules: read from Claude Code and Agentic settings files; deny matches calls; extra folders', () => {
  const home = tmp(), root = tmp();
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agentic'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Read(./.env)', 'Bash(rm:*)'] } }));
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(npm test:*)'], additionalDirectories: ['../shared'] } }));
  fs.writeFileSync(path.join(root, '.agentic', 'settings.json'), JSON.stringify({ permissions: { ask: ['mcp__github'] } }));
  const r = loadRules([root], home);
  assert.ok(r.deny.includes('run_command(rm*)'));
  assert.ok(r.allow.includes('run_command(npm test*)'));
  assert.ok(r.ask.includes('mcp__github__*'));
  assert.deepStrictEqual(r.additionalDirectories, [path.resolve(root, '..', 'shared')]);
  assert.ok(matchingRule(r.deny, 'run_command', { command: 'rm -rf build' }));
  assert.strictEqual(matchingRule(r.deny, 'run_command', { command: 'npm test' }), null);
  assert.ok(matchingRule(r.deny, 'read_file', { path: '.env' }));
  assert.ok(matchingRule(r.deny, 'read_file', { path: path.join(root, '.env') }));
  assert.strictEqual(matchingRule(r.deny, 'read_file', { path: 'src/app.js' }), null);
  assert.strictEqual(callTarget({ url: 'https://x' }), 'https://x');
});

test('paths outside the workspace ask instead of failing; allowed folders and wholeComputer let them through', () => {
  const root = tmp(), other = tmp();
  assert.throws(() => resolveInside(path.join(other, 'a.txt'), [root]), e => e instanceof OutsideWorkspaceError && e.full === path.join(other, 'a.txt'));
  assert.strictEqual(resolveInside(path.join(other, 'a.txt'), [root], [other]), path.join(other, 'a.txt'));
  assert.strictEqual(resolveInside(path.join(other, 'a.txt'), [root], [path.join(other, 'a.txt')]), path.join(other, 'a.txt'));
  assert.strictEqual(resolveInside(path.join(other, 'b.txt'), [root], [], true), path.join(other, 'b.txt'));
});
