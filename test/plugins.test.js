// Tests for Claude Code plugins in Agentic (src/tools/plugins.ts): a marketplace in a folder, installing a plugin from it,
// what the plugin brings (commands, skills, agents, hooks) and switching it off or removing it.
// No VS Code needed: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-plugins-'));
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text)); };

test('a plugin from a folder marketplace: installed, its commands, skills, agents and hooks load; off and uninstalled they go', async () => {
  const pluginsDir = tmp();
  process.env.AGENTIC_PLUGINS_DIR = pluginsDir;
  // Loaded after the variable is set: every function reads it when called.
  const p = require('../out/tools/plugins');
  const { SkillCatalog, HookRunner } = require('../out/tools/extras');
  const { agentDefs } = require('../out/tools/gaps');

  const market = tmp();
  write(path.join(market, '.claude-plugin', 'marketplace.json'), { name: 'team-tools', plugins: [{ name: 'demo', source: './plugins/demo', description: 'Demo plugin' }] });
  const demo = path.join(market, 'plugins', 'demo');
  write(path.join(demo, '.claude-plugin', 'plugin.json'), { name: 'demo', version: '1.2.0', description: 'Demo plugin' });
  write(path.join(demo, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\nSay hello to $ARGUMENTS.');
  write(path.join(demo, 'skills', 'tidy', 'SKILL.md'), '---\nname: tidy\ndescription: Tidy code\n---\nTidy it.');
  write(path.join(demo, 'agents', 'reviewer.md'), '---\nname: reviewer\ndescription: Reviews\n---\nYou review code.');
  write(path.join(demo, 'hooks', 'hooks.json'), { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node ${CLAUDE_PLUGIN_ROOT}/stop.js' }] }] } });

  assert.strictEqual(await p.addMarketplace(market), 'team-tools');
  const m = p.marketplaces().find(x => x.name === 'team-tools');
  assert.ok(m && m.plugins.some(x => x.name === 'demo'), 'the marketplace lists the plugin');

  const id = await p.installPlugin('demo', 'team-tools');
  assert.strictEqual(id, 'demo@team-tools');
  const info = p.installedPlugins().find(x => x.id === id);
  assert.ok(info && info.enabled && info.hooksOn && info.source === 'Agentic');
  assert.strictEqual(info.version, '1.2.0');
  assert.ok(info.dir.startsWith(pluginsDir), 'copied into Agentic\'s plugin folder');
  assert.deepStrictEqual({ c: info.counts.commands, s: info.counts.skills, a: info.counts.agents, h: info.counts.hooks }, { c: 1, s: 1, a: 1, h: 1 });

  const root = tmp();
  const skills = new SkillCatalog(() => [root]);
  assert.ok((await skills.commands()).some(c => c.name === 'demo:hello'), 'the command is /demo:hello');
  assert.ok((await skills.skills()).some(s => s.name === 'demo:tidy'), 'the skill is demo:tidy');
  const cmd = await skills.expandCommand('/demo:hello the team');
  assert.ok(cmd && /Say hello to the team\./.test(cmd.prompt));
  assert.ok(agentDefs([root]).some(a => a.name === 'demo:reviewer'), 'the agent is demo:reviewer');
  const hooks = new HookRunner(() => [root], () => ({ exe: 'cmd.exe', args: c => ['/c', c] }));
  const stop = hooks.list().hooks.find(h => h.event === 'Stop' && h.command.includes('stop.js'));
  assert.ok(stop && stop.command.includes(info.dir), '${CLAUDE_PLUGIN_ROOT} is the plugin folder');

  // Off: nothing of it loads; on again: it does.
  await p.pluginAction({ action: 'disable', id }, [root]);
  assert.ok(!(await skills.commands()).some(c => c.name === 'demo:hello'));
  assert.ok(!agentDefs([root]).some(a => a.name === 'demo:reviewer'));
  await p.pluginAction({ action: 'enable', id }, [root]);
  assert.ok((await skills.commands()).some(c => c.name === 'demo:hello'));

  // Uninstalled: its folder and entry go.
  const r = await p.pluginAction({ action: 'uninstall', id }, [root]);
  assert.ok(!r.plugins.some(x => x.id === id));
  assert.ok(!fs.existsSync(info.dir));
  p.removeMarketplace('team-tools');
  assert.ok(!p.marketplaces().some(x => x.name === 'team-tools'));
  assert.ok(fs.existsSync(market), 'a folder marketplace stays where it is');
  delete process.env.AGENTIC_PLUGINS_DIR;
});

test('owner/repo and git URLs clone; a bare folder name that exists is a folder', () => {
  const p = require('../out/tools/plugins');
  assert.strictEqual(p.gitUrlOf('anthropics/claude-code'), 'https://github.com/anthropics/claude-code.git');
  assert.strictEqual(p.gitUrlOf('github:me/tools'), 'https://github.com/me/tools.git');
  assert.strictEqual(p.gitUrlOf('https://git.example.com/me/tools.git'), 'https://git.example.com/me/tools.git');
  assert.strictEqual(p.gitUrlOf('https://example.com/marketplace.json'), null);
});
