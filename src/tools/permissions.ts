/**
 * Claude Code's permission rules for the tools on this computer: "permissions": {"allow": [...], "ask": [...], "deny": [...],
 * "additionalDirectories": [...]} in ~/.claude/settings.json, ~/.agentic/settings.json and each workspace folder's
 * .claude/settings(.local).json and .agentic/settings(.local).json.
 *  - They go to the Agentic server with each message, in its rule format (run_command(npm test*), read_file(*.env) …),
 *    so deny blocks, ask asks (Auto mode too) and allow never asks.
 *  - deny is also checked here before a tool runs (a call from another window, an older server).
 *  - additionalDirectories are folders the tools may use besides the workspace's.
 * No VS Code import here, so node --test runs it.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Rules { allow: string[]; ask: string[]; deny: string[]; additionalDirectories: string[] }

/** Claude Code's tools as the tools here. */
const TOOL_MAP: Record<string, string[]> = {
  Bash: ['run_command', 'run_command_background', 'monitor'],
  Read: ['read_file', 'list_dir', 'glob_files', 'grep'],
  Edit: ['edit_file', 'edit_notebook', 'write_file'],
  MultiEdit: ['edit_file'], Write: ['write_file'], NotebookEdit: ['edit_notebook'],
  Glob: ['glob_files'], Grep: ['grep'], LS: ['list_dir'],
  WebFetch: ['read_page'], WebSearch: ['search_web']
};
const PATH_TOOLS = new Set(['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'LS']);

function readJson(file: string): any {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}

/** The settings files, most general first. */
export function ruleFiles(roots: string[], home = os.homedir()): string[] {
  const list = [path.join(home, '.claude', 'settings.json'), path.join(home, '.agentic', 'settings.json')];
  for (const r of roots) for (const d of ['.claude', '.agentic']) list.push(path.join(r, d, 'settings.json'), path.join(r, d, 'settings.local.json'));
  return list;
}

/** One Claude Code rule as rules of the Agentic server ("Bash(npm test:*)" → "run_command(npm test*)"). */
export function translateRule(rule: string, home = os.homedir()): string[] {
  const m = /^\s*([^()\s]+)\s*(?:\((.*)\))?\s*$/.exec(rule || '');
  if (!m) return [];
  const tool = m[1], spec = (m[2] || '').trim();
  if (tool.startsWith('mcp__')) {
    // mcp__server is every tool of that server.
    const parts = tool.split('__');
    return [parts.length === 2 || (parts.length === 3 && !parts[2]) ? `mcp__${parts[1]}__*` : tool];
  }
  const names = TOOL_MAP[tool] || [tool];
  if (!spec || spec === '*') return names;
  let patterns: string[];
  if (tool === 'Bash') patterns = [spec.endsWith(':*') ? spec.slice(0, -2) + '*' : spec];
  else if (tool === 'WebFetch') patterns = [spec.startsWith('domain:') ? `*${spec.slice(7)}*` : spec];
  else if (PATH_TOOLS.has(tool)) {
    let p = spec.replace(/\*\*\/?/g, '*');
    if (p.startsWith('//')) p = p.slice(1);
    else if (p.startsWith('~/')) p = home.replace(/\\/g, '/') + p.slice(1);
    else if (p.startsWith('./')) p = p.slice(2);
    else if (p.startsWith('/') && !/^\/[A-Za-z]:/.test(p)) p = p.slice(1);   // relative to the settings file's folder
    const abs = path.isAbsolute(p) || /^[A-Za-z]:/.test(p);
    const back = p.replace(/\//g, '\\');
    patterns = abs || p.startsWith('*') ? [p, back] : [p, `*/${p}`, back, `*\\${back}`];
    patterns = [...new Set(patterns)];
  } else patterns = [spec];
  const out: string[] = [];
  for (const n of names) for (const p of patterns) out.push(`${n}(${p})`);
  return out;
}

/** Every rule of the settings files, in the server's format, and the extra folders. */
export function loadRules(roots: string[], home = os.homedir()): Rules {
  const r: Rules = { allow: [], ask: [], deny: [], additionalDirectories: [] };
  for (const file of ruleFiles(roots, home)) {
    const j = readJson(file);
    const p = j && j.permissions;
    if (!p || typeof p !== 'object') continue;
    for (const kind of ['allow', 'ask', 'deny'] as const) {
      for (const rule of Array.isArray(p[kind]) ? p[kind] : []) r[kind].push(...translateRule(String(rule), home));
    }
    const base = path.dirname(path.dirname(file));
    for (const d of Array.isArray(p.additionalDirectories) ? p.additionalDirectories : []) {
      const s = String(d).replace(/^~(?=$|[\\/])/, home);
      r.additionalDirectories.push(path.resolve(base, s));
    }
  }
  for (const k of ['allow', 'ask', 'deny'] as const) r[k] = [...new Set(r[k])].slice(0, 200);
  r.additionalDirectories = [...new Set(r.additionalDirectories)];
  return r;
}

/** What a call is about (the server's ToolTarget): its command, file, URL or query. */
export function callTarget(args: Record<string, any>): string | null {
  for (const k of ['command', 'path', 'file_path', 'notebook_path', 'url', 'query', 'pattern']) if (typeof args[k] === 'string' && args[k]) return args[k];
  return null;
}

const glob = (pattern: string, value: string) =>
  new RegExp('^' + pattern.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'is').test(value);

/** The first rule of the list that matches the call (the server's matching), or null. */
export function matchingRule(rules: string[], tool: string, args: Record<string, any>): string | null {
  const target = callTarget(args);
  for (const rule of rules) {
    const m = /^\s*([^()\s]+)\s*(?:\((.*)\))?\s*$/.exec(rule);
    if (!m || !glob(m[1], tool)) continue;
    if (m[2]) { if (target === null || !glob(m[2], target)) continue; }
    return rule;
  }
  return null;
}
