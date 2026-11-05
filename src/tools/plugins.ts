/**
 * Claude Code plugins in Agentic: what an installed plugin brings (slash commands, subagents, skills, hooks and MCP servers)
 * works in the chat, and /plugin lists, switches, installs and removes them.
 *
 * Installed plugins come from Claude Code (~/.claude/plugins/installed_plugins.json) and from Agentic's own folder
 * (~/.agentic/plugins/installed_plugins.json, the same format). On or off: Agentic's choice (~/.agentic/plugins/settings.json
 * enabledPlugins) wins, else Claude Code's (~/.claude/settings.json enabledPlugins); switching one here never changes Claude
 * Code's files. Marketplaces: Claude Code's (known_marketplaces.json) and Agentic's; a marketplace is a folder or git
 * repository with .claude-plugin/marketplace.json, and installing copies (or clones) a plugin to
 * ~/.agentic/plugins/cache/<marketplace>/<plugin>/<version>.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';

export interface PluginCounts { commands: number; agents: number; skills: number; hooks: number; mcp: number }
export interface PluginInfo {
  id: string; name: string; marketplace: string; version: string; description: string; dir: string;
  source: 'Claude Code' | 'Agentic'; enabled: boolean; removable: boolean; counts: PluginCounts;
  /** Its hooks run: installed with Agentic, or a Claude Code plugin turned on in /plugin (hooks are written for Claude Code). */
  hooksOn: boolean
}
export interface MarketPlugin { name: string; description: string; version: string }
export interface MarketInfo { name: string; source: string; dir: string; removable: boolean; plugins: MarketPlugin[] }

const home = (h?: string) => h || os.homedir();
const claudeDir = (h?: string) => path.join(home(h), '.claude', 'plugins');
export const agenticPluginsDir = (h?: string) => (!h && process.env.AGENTIC_PLUGINS_DIR) || path.join(home(h), '.agentic', 'plugins');

function readJson(file: string): any { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file: string, value: unknown): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function samePath(a: string, b: string): boolean {
  const n = (p: string) => path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}

function agenticEnabled(h?: string): Record<string, boolean> { return (readJson(path.join(agenticPluginsDir(h), 'settings.json')) || {}).enabledPlugins || {}; }
function claudeEnabled(h?: string): Record<string, boolean> { return (readJson(path.join(home(h), '.claude', 'settings.json')) || {}).enabledPlugins || {}; }
function isEnabled(id: string, h?: string): boolean {
  const a = agenticEnabled(h);
  if (typeof a[id] === 'boolean') return a[id];
  return claudeEnabled(h)[id] !== false;
}

/** A plugin's manifest (.claude-plugin/plugin.json), {} when it has none. */
export function manifestOf(dir: string): any { return readJson(path.join(dir, '.claude-plugin', 'plugin.json')) || {}; }
function listOf(v: unknown): string[] { return typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; }
/** The folders of a kind (commands, agents, skills): the default one and those the manifest adds. */
export function pluginFolders(dir: string, kind: 'commands' | 'agents' | 'skills'): string[] {
  const out = [path.join(dir, kind)];
  for (const p of listOf(manifestOf(dir)[kind])) out.push(path.resolve(dir, p));
  return out.filter((p, i) => out.findIndex(q => samePath(p, q)) === i && fs.existsSync(p));
}
/** The plugin's hooks ({hooks: {Event: [groups]}}): hooks/hooks.json, or the manifest's hooks (a file or an object). */
export function pluginHooks(dir: string): Record<string, any[]> {
  const m = manifestOf(dir);
  let doc: any = null;
  if (typeof m.hooks === 'string') doc = readJson(path.resolve(dir, m.hooks));
  else if (m.hooks && typeof m.hooks === 'object') doc = m.hooks.hooks ? m.hooks : { hooks: m.hooks };
  if (!doc) doc = readJson(path.join(dir, 'hooks', 'hooks.json'));
  const hooks = doc && doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
  // ${CLAUDE_PLUGIN_ROOT} in a command is the plugin's folder.
  const out: Record<string, any[]> = {};
  for (const [ev, groups] of Object.entries<any>(hooks)) {
    if (!Array.isArray(groups)) continue;
    out[ev] = groups.map(g => ({ ...g, hooks: (Array.isArray(g.hooks) ? g.hooks : []).map((h: any) => h && typeof h.command === 'string' ? { ...h, command: h.command.split('${CLAUDE_PLUGIN_ROOT}').join(dir) } : h) }));
  }
  return out;
}
function countMd(dirs: string[]): number {
  let n = 0;
  const walk = (d: string, depth: number) => {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (e.isDirectory() && depth < 3) walk(path.join(d, e.name), depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) n++;
    }
  };
  dirs.forEach(d => walk(d, 0));
  return n;
}
function countsOf(dir: string): PluginCounts {
  const skills = pluginFolders(dir, 'skills').reduce((n, d) => {
    try { return n + fs.readdirSync(d).filter(x => fs.existsSync(path.join(d, x, 'SKILL.md'))).length; } catch { return n; }
  }, 0);
  const m = manifestOf(dir);
  const mcpDoc = readJson(path.join(dir, '.mcp.json'));
  const mcp = Object.keys((mcpDoc && (mcpDoc.mcpServers || mcpDoc)) || {}).length + (m.mcpServers && typeof m.mcpServers === 'object' ? Object.keys(m.mcpServers).length : 0);
  return {
    commands: countMd(pluginFolders(dir, 'commands')), agents: countMd(pluginFolders(dir, 'agents')), skills,
    hooks: Object.values(pluginHooks(dir)).reduce((n, g) => n + g.length, 0), mcp
  };
}

function registryEntries(file: string, source: 'Claude Code' | 'Agentic', projectDirs: string[], h?: string, withCounts = true): PluginInfo[] {
  const doc = readJson(file);
  const out: PluginInfo[] = [];
  for (const [id, entries] of Object.entries<any>((doc && doc.plugins) || {})) {
    for (const e of Array.isArray(entries) ? entries : [entries]) {
      if (!e || !e.installPath || !fs.existsSync(e.installPath)) continue;
      if ((e.scope === 'project' || e.scope === 'local') && !(e.projectPath && projectDirs.some(r => samePath(r, e.projectPath)))) continue;
      const dir = String(e.installPath), m = manifestOf(dir);
      const [name, marketplace] = id.split('@');
      out.push({
        id, name: m.name || name, marketplace: marketplace || '', version: String(e.version || m.version || ''), description: String(m.description || ''), dir, source,
        enabled: isEnabled(id, h), removable: source === 'Agentic', counts: withCounts ? countsOf(dir) : { commands: 0, agents: 0, skills: 0, hooks: 0, mcp: 0 },
        hooksOn: isEnabled(id, h) && (source === 'Agentic' || agenticEnabled(h)[id] === true)
      });
      break;
    }
  }
  return out;
}

/** Every installed plugin (Agentic's own first: the same id installed in both is Agentic's). */
export function installedPlugins(projectDirs: string[] = [], homeDir?: string, withCounts = true): PluginInfo[] {
  const own = registryEntries(path.join(agenticPluginsDir(homeDir), 'installed_plugins.json'), 'Agentic', projectDirs, homeDir, withCounts);
  const claude = registryEntries(path.join(claudeDir(homeDir), 'installed_plugins.json'), 'Claude Code', projectDirs, homeDir, withCounts).filter(p => !own.some(o => o.id === p.id));
  return [...own, ...claude];
}
/** The folders of the plugins that are on (what the chat loads). */
export function enabledPlugins(projectDirs: string[] = [], homeDir?: string): PluginInfo[] { return installedPlugins(projectDirs, homeDir, false).filter(p => p.enabled); }

export function setPluginEnabled(id: string, on: boolean): void {
  const file = path.join(agenticPluginsDir(), 'settings.json');
  const doc = readJson(file) || {};
  doc.enabledPlugins = { ...(doc.enabledPlugins || {}), [id]: on };
  writeJson(file, doc);
}

// ------------------------------------------------------------------ marketplaces
function marketFile(dir: string): any { return readJson(path.join(dir, '.claude-plugin', 'marketplace.json')) || readJson(path.join(dir, 'marketplace.json')); }
function sourceText(s: any): string {
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.repo ? `github:${s.repo}` : s.url || s.path || s.source || '';
}
export function marketplaces(): MarketInfo[] {
  const out: MarketInfo[] = [];
  const add = (file: string, removable: boolean) => {
    for (const [name, m] of Object.entries<any>(readJson(file) || {})) {
      const dir = m && (m.installLocation || m.path);
      if (!dir || out.some(x => x.name === name)) continue;
      const doc = marketFile(dir) || {};
      out.push({
        name, source: sourceText(m.source), dir, removable,
        plugins: (Array.isArray(doc.plugins) ? doc.plugins : []).map((p: any) => ({ name: String(p.name || ''), description: String(p.description || ''), version: String(p.version || '') })).filter((p: MarketPlugin) => p.name)
      });
    }
  };
  add(path.join(agenticPluginsDir(), 'known_marketplaces.json'), true);
  add(path.join(claudeDir(), 'known_marketplaces.json'), false);
  return out;
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => execFile(cmd, args, { cwd, timeout: 180_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) =>
    err ? reject(new Error(`${cmd} ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 400)}`)) : resolve(String(stdout))));
}
/** A marketplace source as git can clone it (owner/repo is GitHub); null for a local folder or a marketplace.json URL. */
export function gitUrlOf(source: string): string | null {
  const s = source.trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(s) && !fs.existsSync(s)) return `https://github.com/${s.replace(/\.git$/, '')}.git`;
  if (/^github:/i.test(s)) return `https://github.com/${s.slice(7).replace(/\.git$/, '')}.git`;
  if (/^(https?|git|ssh):\/\//i.test(s) && !/\.json(\?|$)/i.test(s)) return s;
  if (/^git@/.test(s)) return s;
  return null;
}
function safeName(s: string): string { return s.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'marketplace'; }

/** Adds a marketplace: owner/repo, a git URL, a URL of a marketplace.json, or a local folder. Returns its name. */
export async function addMarketplace(source: string): Promise<string> {
  const src = String(source || '').trim();
  if (!src) throw new Error('Say where the marketplace is: owner/repo, a git URL or a folder.');
  const root = path.join(agenticPluginsDir(), 'marketplaces');
  fs.mkdirSync(root, { recursive: true });
  let dir: string, recorded: any;
  const git = gitUrlOf(src);
  if (fs.existsSync(src) && fs.statSync(src).isDirectory()) { dir = path.resolve(src); recorded = { source: 'directory', path: dir }; }
  else if (git) {
    const tmp = path.join(root, '.new-' + Date.now().toString(36));
    await run('git', ['clone', '--depth', '1', git, tmp]);
    const doc = marketFile(tmp);
    if (!doc) { fs.rmSync(tmp, { recursive: true, force: true }); throw new Error('That repository has no .claude-plugin/marketplace.json.'); }
    dir = path.join(root, safeName(doc.name || path.basename(git, '.git')));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
    recorded = /github\.com\/([^/]+\/[^/.]+)/.test(git) ? { source: 'github', repo: /github\.com\/([^/]+\/[^/.]+)/.exec(git)![1] } : { source: 'git', url: git };
  } else if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Could not download ${src} (HTTP ${res.status}).`);
    const doc = await res.json() as any;
    dir = path.join(root, safeName(doc.name || 'marketplace'));
    writeJson(path.join(dir, '.claude-plugin', 'marketplace.json'), doc);
    recorded = { source: 'url', url: src };
  } else throw new Error(`${src} is not a folder, owner/repo or URL.`);
  const doc = marketFile(dir);
  if (!doc) throw new Error('No .claude-plugin/marketplace.json found there.');
  const name = safeName(doc.name || path.basename(dir));
  const file = path.join(agenticPluginsDir(), 'known_marketplaces.json');
  const known = readJson(file) || {};
  known[name] = { source: recorded, installLocation: dir, lastUpdated: new Date().toISOString() };
  writeJson(file, known);
  return name;
}
export function removeMarketplace(name: string): void {
  const file = path.join(agenticPluginsDir(), 'known_marketplaces.json');
  const known = readJson(file) || {};
  const m = known[name];
  if (!m) throw new Error(`No marketplace ${name} in Agentic's list (Claude Code's are removed with Claude Code).`);
  delete known[name];
  writeJson(file, known);
  const dir = m.installLocation;
  if (dir && samePath(path.dirname(dir), path.join(agenticPluginsDir(), 'marketplaces'))) fs.rmSync(dir, { recursive: true, force: true });
}
export async function updateMarketplace(name: string): Promise<void> {
  const m = marketplaces().find(x => x.name === name);
  if (!m) throw new Error(`No marketplace ${name}.`);
  if (fs.existsSync(path.join(m.dir, '.git'))) await run('git', ['pull', '--ff-only'], m.dir);
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else if (e.isFile()) fs.copyFileSync(a, b);
  }
}
/** Installs a plugin from a marketplace (name, or name@marketplace); returns its id. */
export async function installPlugin(name: string, marketplace?: string): Promise<string> {
  let [n, mk] = String(name || '').split('@');
  mk = marketplace || mk;
  const markets = marketplaces().filter(m => !mk || m.name === mk);
  const market = markets.find(m => m.plugins.some(p => p.name === n));
  if (!market) throw new Error(mk ? `No plugin ${n} in the marketplace ${mk}.` : `No marketplace lists a plugin ${n}.`);
  const doc = marketFile(market.dir) || {};
  const entry = (doc.plugins || []).find((p: any) => p.name === n);
  const tmpRoot = path.join(agenticPluginsDir(), 'cache', '.new-' + Date.now().toString(36));
  let src: string;
  const s = entry.source;
  if (typeof s === 'string' || !s) {
    const base = doc.metadata && doc.metadata.pluginRoot ? path.resolve(market.dir, doc.metadata.pluginRoot) : market.dir;
    src = path.resolve(s && /^[./]/.test(s) ? market.dir : base, s || n);
    if (!fs.existsSync(src)) throw new Error(`The plugin's folder ${src} is missing from the marketplace.`);
  } else {
    const url = s.repo ? `https://github.com/${s.repo}.git` : s.url;
    if (!url) throw new Error('The plugin\'s source is not one Agentic can install.');
    await run('git', ['clone', '--depth', '1', url, tmpRoot]);
    src = s.path ? path.join(tmpRoot, s.path) : tmpRoot;
  }
  const version = String(manifestOf(src).version || entry.version || 'latest').replace(/[^\w.+-]/g, '_');
  const target = path.join(agenticPluginsDir(), 'cache', market.name, n, version);
  fs.rmSync(target, { recursive: true, force: true });
  copyDir(src, target);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  const id = `${n}@${market.name}`;
  const file = path.join(agenticPluginsDir(), 'installed_plugins.json');
  const reg = readJson(file) || { version: 2, plugins: {} };
  reg.version = reg.version || 2;
  reg.plugins = reg.plugins || {};
  reg.plugins[id] = [{ scope: 'user', installPath: target, version, installedAt: new Date().toISOString(), lastUpdated: new Date().toISOString() }];
  writeJson(file, reg);
  setPluginEnabled(id, true);
  return id;
}
export function uninstallPlugin(id: string): void {
  const file = path.join(agenticPluginsDir(), 'installed_plugins.json');
  const reg = readJson(file) || { plugins: {} };
  const entries = reg.plugins && reg.plugins[id];
  if (!entries) throw new Error(`${id} was not installed by Agentic (Claude Code's plugins are removed with Claude Code; switch it off here instead).`);
  for (const e of Array.isArray(entries) ? entries : [entries]) {
    if (e && e.installPath && path.resolve(e.installPath).startsWith(path.resolve(agenticPluginsDir()))) fs.rmSync(e.installPath, { recursive: true, force: true });
  }
  delete reg.plugins[id];
  writeJson(file, reg);
  const sfile = path.join(agenticPluginsDir(), 'settings.json');
  const s = readJson(sfile);
  if (s && s.enabledPlugins) { delete s.enabledPlugins[id]; writeJson(sfile, s); }
}

/** /plugin in the chat: {action: list | enable | disable | install | uninstall | marketplace-add | marketplace-remove | marketplace-update}. */
export async function pluginAction(body: any, projectDirs: string[]): Promise<{ plugins: PluginInfo[]; marketplaces: MarketInfo[] }> {
  const b = body || {};
  switch (String(b.action || 'list')) {
    case 'list': break;
    case 'enable': setPluginEnabled(String(b.id || ''), true); break;
    case 'disable': setPluginEnabled(String(b.id || ''), false); break;
    case 'install': await installPlugin(String(b.name || ''), b.marketplace ? String(b.marketplace) : undefined); break;
    case 'uninstall': uninstallPlugin(String(b.id || '')); break;
    case 'marketplace-add': await addMarketplace(String(b.source || '')); break;
    case 'marketplace-remove': removeMarketplace(String(b.name || '')); break;
    case 'marketplace-update': await updateMarketplace(String(b.name || '')); break;
    default: throw new Error('Unknown plugin action.');
  }
  return { plugins: installedPlugins(projectDirs), marketplaces: marketplaces() };
}
