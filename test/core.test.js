// Unit tests for the workspace-tool helpers and definitions (no VS Code needed): node --test test/
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const core = require('../out/tools/core');
const defs = require('../out/tools/definitions');

const root = path.resolve(process.platform === 'win32' ? 'C:\\ws\\proj' : '/ws/proj');
const other = path.resolve(process.platform === 'win32' ? 'C:\\ws\\lib' : '/ws/lib');

test('resolveInside: relative paths start in the first folder', () => {
  assert.strictEqual(core.resolveInside('src/a.ts', [root]), path.join(root, 'src', 'a.ts'));
  assert.strictEqual(core.resolveInside('', [root]), root);
  assert.strictEqual(core.resolveInside(path.join(other, 'x.ts'), [root, other]), path.join(other, 'x.ts'));
});

test('resolveInside: refuses paths outside the workspace, including ../ escapes and sibling prefixes', () => {
  assert.throws(() => core.resolveInside('../secret.txt', [root]), /outside the workspace/);
  assert.throws(() => core.resolveInside(root + '-evil' + path.sep + 'x', [root]), /outside the workspace/);
  assert.throws(() => core.resolveInside('a.ts', []), /No folder is open/);
});

test('numberLines: numbered, paged, and says how to read on', () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
  const out = core.numberLines(text, 3, 2);
  assert.match(out, /^ {5}3\tline 3\n {5}4\tline 4/);
  assert.match(out, /6 more lines \(use offset 5\)/);
  assert.strictEqual(core.numberLines('', 1, 10), '(empty file)');
  assert.match(core.numberLines('a\r\nb\r\n'), /^ {5}1\ta\n {5}2\tb$/);
});

test('applyEdit: exact, unique replacement', () => {
  const r = core.applyEdit('const a = 1;\nconst b = 2;\n', 'const b = 2;', 'const b = 3;');
  assert.ok(r.ok);
  assert.strictEqual(r.text, 'const a = 1;\nconst b = 3;\n');
  assert.strictEqual(r.replaced, 1);
});

test('applyEdit: refuses ambiguous, missing and empty edits; a no-op on text that is there is fine', () => {
  assert.match(core.applyEdit('x x', 'x', 'y').error, /matches 2 places/);
  assert.match(core.applyEdit('abc', 'zzz', 'y').error, /not found/);
  assert.match(core.applyEdit('abc', '', 'y').error, /empty/);
  assert.match(core.applyEdit('abc', 'q', 'q').error, /same/);
  const noop = core.applyEdit('abc', 'a', 'a');
  assert.ok(noop.ok);
  assert.strictEqual(noop.replaced, 0);
  assert.match(noop.note, /already contains/);
});

test('applyEdit: forgives copied line numbers and trailing spaces, and shows the closest text when missing', () => {
  const file = 'function add(a, b) {\n  return a + b;   \n}\n';
  // Line numbers copied from read_file.
  const numbered = core.applyEdit(file, '     2\t  return a + b;   ', '     2\t  return a - b;   ');
  assert.ok(numbered.ok, numbered.error);
  assert.strictEqual(numbered.text, 'function add(a, b) {\n  return a - b;   \n}\n');
  assert.match(numbered.note, /line numbers/);
  // Trailing spaces in the file the model left out.
  const loose = core.applyEdit(file, 'function add(a, b) {\n  return a + b;\n}', 'function add(a, b) {\n  return b + a;\n}');
  assert.ok(loose.ok, loose.error);
  assert.strictEqual(loose.text, 'function add(a, b) {\n  return b + a;\n}\n');
  // Wrong indentation: not applied, but the error shows the real lines with their numbers.
  const miss = core.applyEdit(file, '    return a + b;', '    return 0;');
  assert.ok(!miss.ok);
  assert.match(miss.error, /closest text/);
  assert.match(miss.error, /2\t {2}return a \+ b;/);
  // CRLF files keep CRLF through a loose match too.
  const crlf = core.applyEdit('a  \r\nb\r\n', 'a\nb', 'A\nB');
  assert.strictEqual(crlf.text, 'A\r\nB\r\n');
});

test('applyEdit: replace_all, and LF edits applied to CRLF files keep CRLF', () => {
  const all = core.applyEdit('x x x', 'x', 'y', true);
  assert.strictEqual(all.text, 'y y y');
  assert.strictEqual(all.replaced, 3);
  const crlf = core.applyEdit('one\r\ntwo\r\nthree\r\n', 'two\nthree', 'TWO\nTHREE');
  assert.ok(crlf.ok);
  assert.strictEqual(crlf.text, 'one\r\nTWO\r\nTHREE\r\n');
});

test('applyEdit: $ patterns in the new text are kept literally', () => {
  assert.strictEqual(core.applyEdit('a = b', 'b', '$& $1 $$').text, 'a = $& $1 $$');
});

test('grepText, looksBinary, parseArgs, clip', () => {
  assert.deepStrictEqual(core.grepText('foo\nbar foo\nbaz', /foo/, 'f.txt', 10), ['f.txt:1: foo', 'f.txt:2: bar foo']);
  assert.deepStrictEqual(core.grepText('foo\nfoo\nfoo', /foo/, 'f', 2).length, 2);
  assert.ok(core.looksBinary(Uint8Array.from([65, 0, 66])));
  assert.ok(!core.looksBinary(Buffer.from('plain text')));
  assert.deepStrictEqual(core.parseArgs('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(core.parseArgs('not json'), {});
  assert.deepStrictEqual(core.parseArgs({ b: 2 }), { b: 2 });
  assert.match(core.clip('x'.repeat(20), 5), /^xxxxx\n… \(15 more characters cut\)$/);
});

test('definitions: risks drive approvals; commands can be switched off', () => {
  const base = { workspaces: [root], shellLabel: 'bash', osLabel: 'Linux', allowCommands: true };
  const on = defs.toolDefinitions(base);
  const byName = Object.fromEntries(on.map(d => [d.name, d]));
  assert.strictEqual(byName.read_file['x-risk'], 'read');
  assert.strictEqual(byName.edit_file['x-risk'], 'change');
  assert.strictEqual(byName.write_file['x-risk'], 'change');
  assert.strictEqual(byName.run_command['x-risk'], 'change');
  assert.strictEqual(byName.agentic_api['x-risk'], 'conditional');
  for (const d of on) {
    assert.strictEqual(d.parameters.type, 'object', d.name);
    assert.match(d.name, /^[a-z_]+$/);
  }
  const off = defs.toolDefinitions({ ...base, allowCommands: false });
  assert.ok(!off.some(d => d.name === 'run_command'));
  assert.match(defs.toolInstructions(base), /Workspace folders/);
});
