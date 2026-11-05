// The ccusage log (Claude Code's format): node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const usage = require('../out/tools/usageLog');

test('usageEntry: cached tokens move from input to cache reads; cost in USD', () => {
  const e = usage.usageEntry('chat1', '/ws', '1.0.0', { id: 'm1', model: 'fast', routedModel: 'yqy/glm', promptTokens: 1000, completionTokens: 50, costMicros: 1234 }, 400, new Date('2026-10-18T10:00:00Z'));
  assert.strictEqual(e.timestamp, '2026-10-18T10:00:00.000Z');
  assert.strictEqual(e.sessionId, 'chat1');
  assert.strictEqual(e.version, '1.0.0');
  assert.strictEqual(usage.plainVersion('0.4.7+a1ddf2'), '0.4.7');
  assert.strictEqual(e.requestId, 'm1');
  assert.strictEqual(e.message.id, 'm1');
  assert.strictEqual(e.message.model, 'yqy/glm');
  assert.deepStrictEqual(e.message.usage, { input_tokens: 600, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 400 });
  assert.strictEqual(e.costUSD, 0.001234);
});

test('usageEntry: nothing for an answer without tokens; no cost when not charged', () => {
  assert.strictEqual(usage.usageEntry('c', '/ws', '1', { promptTokens: 0, completionTokens: 0 }, 0), null);
  assert.strictEqual(usage.usageEntry('c', '/ws', '1', { promptTokens: 5, completionTokens: 1, costMicros: null }, 99).costUSD, undefined);
  assert.strictEqual(usage.usageEntry('c', '/ws', '1', { promptTokens: 5, completionTokens: 1 }, 99).message.usage.cache_read_input_tokens, 5);
});

test('recordUsage appends one JSON line per answer under projects/agentic-vscode-<workspace>', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccusage-'));
  try {
    assert.ok(usage.recordUsage('chat-1', path.join(dir, 'proj'), '1', { id: 'a', promptTokens: 10, completionTokens: 2 }, 0, dir));
    assert.ok(usage.recordUsage('chat-1', path.join(dir, 'proj'), '1', { id: 'b', promptTokens: 20, completionTokens: 3 }, 0, dir));
    const projects = fs.readdirSync(path.join(dir, 'projects'));
    assert.strictEqual(projects.length, 1);
    assert.match(projects[0], /^agentic-vscode-/);
    const lines = fs.readFileSync(path.join(dir, 'projects', projects[0], 'chat-1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepStrictEqual(lines.map(l => l.message.id), ['a', 'b']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('claudeDataDir: AGENTIC_CCUSAGE_DIR, then the first CLAUDE_CONFIG_DIR', () => {
  assert.strictEqual(usage.claudeDataDir({ AGENTIC_CCUSAGE_DIR: ' /x ' }), '/x');
  assert.strictEqual(usage.claudeDataDir({ CLAUDE_CONFIG_DIR: ' ,/a,/b' }), '/a');
});
