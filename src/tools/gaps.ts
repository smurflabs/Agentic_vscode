/**
 * What the chat gets from VS Code beyond the tools (like the CLI and the desktop app): SessionStart and UserPromptSubmit
 * hooks before a message is sent, your own subagent types (/agents: .claude/agents and .agentic/agents), git worktrees
 * (/worktree) and the working tree's changes (/diff).
 */
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { WorkspaceTools } from './workspaceTools';
import { enabledPlugins, pluginFolders } from './plugins';

export interface AgentDef { name: string; description: string; tools: string[]; prompt: string; file: string; scope: 'project' | 'user' }

/** A Markdown file's front matter (simple YAML: key: value, and lists as "- item" lines) and its body. */
export function frontMatter(text: string): { front: Record<string, string>; body: string } {
  const front: Record<string, string> = {};
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^﻿/, ''));
  if (!m) return { front, body: text };
  let key = '';
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) { front[key] = (front[key] ? front[key] + ', ' : '') + unquote(item[1]); continue; }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) { key = kv[1].toLowerCase(); front[key] = unquote(kv[2]); }
  }
  return { front, body: m[2] };
}
function unquote(s: string): string { const t = s.trim(); return /^(['"]).*\1$/.test(t) ? t.slice(1, -1) : t; }

function agentFolders(roots: string[]): { dir: string; scope: 'project' | 'user'; prefix?: string }[] {
  const list: { dir: string; scope: 'project' | 'user'; prefix?: string }[] = [];
  for (const r of roots) list.push({ dir: path.join(r, '.agentic', 'agents'), scope: 'project' }, { dir: path.join(r, '.claude', 'agents'), scope: 'project' });
  list.push({ dir: path.join(os.homedir(), '.agentic', 'agents'), scope: 'user' }, { dir: path.join(os.homedir(), '.claude', 'agents'), scope: 'user' });
  // A Claude Code plugin's agents are named plugin:agent.
  for (const p of enabledPlugins(roots)) for (const dir of pluginFolders(p.dir, 'agents')) list.push({ dir, scope: 'user', prefix: p.name + ':' });
  return list;
}

/** The user's subagent types (the first file of a name wins), at most 30. */
export function agentDefs(roots: string[]): AgentDef[] {
  const list: AgentDef[] = [];
  for (const f of agentFolders(roots)) {
    let names: string[] = [];
    try { names = fsSync.readdirSync(f.dir).filter(n => n.toLowerCase().endsWith('.md')).sort(); } catch { continue; }
    for (const n of names) {
      const file = path.join(f.dir, n);
      let text = '';
      try { text = fsSync.readFileSync(file, 'utf8'); } catch { continue; }
      const { front, body } = frontMatter(text);
      const name = (f.prefix || '') + (front.name || path.basename(n, '.md')).trim();
      if (!body.trim() || list.some(a => a.name.toLowerCase() === name.toLowerCase())) continue;
      list.push({ name, description: front.description || '', tools: (front.tools || '').split(',').map(t => t.trim()).filter(Boolean), prompt: body.trim(), file, scope: f.scope });
      if (list.length >= 30) return list;
    }
  }
  return list;
}

/** A new agent file in the project's .claude/agents (or ~/.claude/agents); returns its path. */
export function saveAgent(roots: string[], a: { name?: string; description?: string; tools?: string[]; prompt?: string; scope?: string }): string {
  const slug = String(a.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Give the agent a name.');
  if (!String(a.prompt || '').trim()) throw new Error('Write the agent\'s instructions.');
  if (a.scope !== 'user' && !roots.length) throw new Error('Open a folder first, or save the agent for all your projects.');
  const dir = a.scope === 'user' ? path.join(os.homedir(), '.claude', 'agents') : path.join(roots[0], '.claude', 'agents');
  const file = path.join(dir, slug + '.md');
  if (fsSync.existsSync(file)) throw new Error('There is an agent file with that name already: ' + file);
  fsSync.mkdirSync(dir, { recursive: true });
  const tools = Array.isArray(a.tools) ? a.tools.map(String).filter(Boolean) : [];
  fsSync.writeFileSync(file, `---\nname: ${slug}\ndescription: ${String(a.description || '').replace(/\s+/g, ' ').trim()}\n${tools.length ? `tools: ${tools.join(', ')}\n` : ''}---\n\n${String(a.prompt).trim()}\n`);
  return file;
}

// ------------------------------------------------------------------ git

function git(dir: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, GIT_PAGER: 'cat' }, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, out: 'git is not installed or could not start: ' + r.error.message };
  return { ok: r.status === 0, out: r.status === 0 ? String(r.stdout || '') : (String(r.stderr || '') + String(r.stdout || '')).trim() };
}
function firstLine(text: string): string {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.find(l => /^fatal:/i.test(l)) || lines[0] || 'git failed';
}
/** A name git accepts for the folder and branch; empty: one from the date and time. */
export function worktreeName(text: string): string {
  let n = String(text || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!n) { const d = new Date(), p = (x: number) => String(x).padStart(2, '0'); n = `session-${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }
  return n.slice(0, 60).replace(/[-.]+$/, '');
}
function mainRoot(dir: string): string | null {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!r.ok) return null;
  const common = r.out.trim().replace(/[\\/]+$/, '');
  return path.basename(common).toLowerCase() === '.git' ? path.dirname(path.resolve(common)) : null;
}
function exclude(root: string): void {
  try {
    const r = git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
    if (!r.ok) return;
    const file = r.out.trim(), line = '/.agentic/worktrees/';
    const text = fsSync.existsSync(file) ? fsSync.readFileSync(file, 'utf8') : '';
    if (text.split(/\r?\n/).some(l => l.trim() === line)) return;
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.appendFileSync(file, (text === '' || text.endsWith('\n') ? '' : '\n') + line + '\n');
  } catch { /* only tidiness */ }
}

/** /worktree [name] (create or reuse and work in it), list, done (back), remove <name>; like the CLI's. */
export function worktreeCommand(tools: WorkspaceTools, arg: string): { ok: boolean; message?: string; list?: string; folder?: string } {
  const here = tools.roots()[0];
  if (!here) return { ok: false, message: 'Open a folder first: a worktree is made from the project\'s git repository.' };
  const [verb, ...rest] = String(arg || '').trim().split(/\s+/).filter(Boolean);
  const v = (verb || '').toLowerCase();
  if (v === 'list') { const r = git(here, ['worktree', 'list']); return { ok: r.ok, list: r.ok ? r.out.trimEnd() : firstLine(r.out) }; }
  if (v === 'done' || v === 'exit' || v === 'leave') {
    if (!tools.worktreeRoot) return { ok: false, message: 'Not working in a worktree.' };
    tools.worktreeRoot = null;
    return { ok: true, message: `Back in ${tools.roots()[0] || 'the workspace'}. The worktree stays (/worktree remove <name> deletes it).` };
  }
  if (v === 'remove' || v === 'rm' || v === 'delete') {
    if (!rest.length) return { ok: false, message: '/worktree remove <name>' };
    const root = mainRoot(here);
    if (!root) return { ok: false, message: 'This folder is not in a git repository.' };
    const folder = path.join(root, '.agentic', 'worktrees', worktreeName(rest.join(' ')));
    if (!fsSync.existsSync(folder)) return { ok: false, message: `There is no worktree ${worktreeName(rest.join(' '))}.` };
    if (tools.worktreeRoot && path.resolve(tools.worktreeRoot) === path.resolve(folder)) tools.worktreeRoot = null;
    const r = git(root, ['worktree', 'remove', folder]);
    return r.ok ? { ok: true, message: `Removed the worktree ${worktreeName(rest.join(' '))} (its branch stays).` } : { ok: false, message: firstLine(r.out) };
  }
  const root = mainRoot(here);
  if (!root) return { ok: false, message: 'No worktree: this folder is not in a git repository (a worktree needs git).' };
  const name = worktreeName(String(arg || '')), folder = path.join(root, '.agentic', 'worktrees', name), branch = 'agentic/' + name;
  if (!fsSync.existsSync(folder)) {
    exclude(root);
    fsSync.mkdirSync(path.dirname(folder), { recursive: true });
    let r = git(here, ['worktree', 'add', '-b', branch, folder, 'HEAD']);
    if (!r.ok && /already exists/.test(r.out)) r = git(here, ['worktree', 'add', folder, branch]);
    if (!r.ok) return { ok: false, message: 'No worktree: ' + firstLine(r.out) };
  }
  tools.worktreeRoot = folder;
  return { ok: true, folder, message: `Working in ${folder} on branch ${branch}. /worktree done goes back.` };
}

/** git status --short and git diff HEAD of the first folder (the diff cut at 300,000 characters). */
export function diffOf(dir: string | undefined): { status?: string; diff?: string; error?: string } {
  if (!dir) return { error: 'Open a folder first.' };
  const s = git(dir, ['status', '--short']);
  if (!s.ok) return { error: /not a git repository/i.test(s.out) ? 'This folder is not in a git repository: ' + dir : firstLine(s.out) };
  const d = git(dir, ['--no-pager', 'diff', 'HEAD']);
  let diff = d.ok ? d.out : '';
  if (diff.length > 300_000) diff = diff.slice(0, 300_000) + '\n… (cut here)';
  return { status: s.out.trimEnd(), diff: diff.trimEnd() };
}

/** SessionStart (the first message of a chat in this window) and UserPromptSubmit hooks before a message is sent. */
export class PromptHooks {
  private readonly started = new Set<string>();
  private pending = '';
  constructor(private readonly tools: WorkspaceTools) { }

  async check(content: string, chatId: string | undefined): Promise<{ blocked?: string; context?: string }> {
    const printed: string[] = [];
    const key = chatId || 'new:' + Math.random().toString(36).slice(2);
    if (!this.started.has(key)) {
      this.started.add(key);
      // The matcher of a SessionStart hook is the source (startup, resume), like Claude Code's.
      const source = chatId ? 'resume' : 'startup';
      const s = await this.tools.hooks.run('SessionStart', source, { session_id: chatId || '', source });
      if (s.output) printed.push(s.output);
      if (s.context) printed.push(s.context);
    }
    const u = await this.tools.hooks.run('UserPromptSubmit', '', { session_id: chatId || '', prompt: content });
    if (u.blocked) return { blocked: u.message || 'Blocked by a hook.' };
    if (u.output) printed.push(u.output);
    if (u.context) printed.push(u.context);
    this.pending = printed.join('\n\n');
    return { context: this.pending || undefined };
  }

  /** Hook events the chat page reports from an answer this window runs, and the field each one's matcher sees. */
  static readonly PAGE_EVENTS: Record<string, string> = { Notification: 'notification_type', PreCompact: 'trigger', PostCompact: 'trigger', SubagentStart: 'agent_type', SubagentStop: 'agent_type' };

  /** An event from the chat page (a subagent started, the conversation was compacted, the chat waits for the user): its hooks. */
  async pageEvent(event: string, chatId: string | undefined, payload: Record<string, unknown>): Promise<{ blocked?: string; context?: string }> {
    const field = PromptHooks.PAGE_EVENTS[event];
    if (!field) throw new Error('Unknown hook event: ' + event);
    const data: Record<string, unknown> = { ...(payload || {}), session_id: chatId || '' };
    delete data.hook_event_name; delete data.cwd;
    const r = await this.tools.hooks.run(event, String(data[field] ?? ''), data);
    return { blocked: r.blocked ? (r.message || 'Blocked by a hook.') : undefined, context: r.context || r.output || undefined };
  }

  /** PermissionRequest hooks answer an approval before the user does: allow | deny, or nothing when they leave it to the user. */
  async permission(a: { chatId?: string; id?: string; name?: string; arguments?: string; reason?: string }): Promise<{ decision?: string; message?: string }> {
    let input: unknown = {};
    try { input = JSON.parse(a.arguments || '{}'); } catch { /* not JSON */ }
    const r = await this.tools.hooks.run('PermissionRequest', String(a.name || ''), { session_id: a.chatId || '', tool_use_id: a.id || '', tool_input: input, reason: a.reason || '' });
    if (r.blocked || r.decision === 'deny') return { decision: 'deny', message: r.message || 'denied by a PermissionRequest hook' };
    if (r.decision === 'allow') return { decision: 'allow' };
    return {};
  }

  /** The hooks' output for the message being prepared (once), as instructions. */
  take(): string {
    const text = this.pending.trim();
    this.pending = '';
    return text ? `\nContext from the user's hooks on this computer (UserPromptSubmit / SessionStart):\n<hook-output>\n${text}\n</hook-output>\n` : '';
  }
}
