/**
 * The workspace tools, run with VS Code's own APIs: files are read from open editors when they are open (unsaved
 * changes included) and changed through WorkspaceEdit, so every change shows in the editor and can be undone; problems
 * come from the Problems panel; commands run in the workspace with the configured shell.
 */
import * as vscode from 'vscode';
import { Checkpoints } from './checkpoints';
import { BackgroundCommands, HookRunner, SkillCatalog } from './extras';
import { McpManager, McpManagerOptions } from './mcp';
import { IdeTools, ideDefinitions, IDE_NOTE } from './ideTools';
import * as fsSync from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { spawn, spawnSync } from 'child_process';
import { applyEdit, clip, grepText, isInside, looksBinary, numberLines, OutsideWorkspaceError, parseArgs, resolveInside, sizeText } from './core';
import { loadRules, matchingRule, Rules } from './permissions';
import { DefinitionOptions, toolDefinitions, toolInstructions, ToolDefinition } from './definitions';
import { CWD_MARKER, POWERSHELL_EXIT, splitCwd, withCwdMarker } from './extras';
import { killTree, ProjectRunner } from './runner';

const EXCLUDE = '{**/node_modules/**,**/.git/**,**/bin/**,**/obj/**,**/out/**,**/dist/**,**/.vs/**,**/__pycache__/**}';
const MAX_FILE_BYTES = 20_000_000;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
/** The chat key for files the user attached with @path (they count as read in every chat). */
const MENTIONED = '@';
const UNSAVED_NOTE = 'The file had unsaved changes in the editor, so it was not saved: the change is in the editor, and commands that read ' +
  'the file from disk do not see it until the user saves (tell them).';
const PARTLY_NOTE = 'The user accepted only part of this change (they reverted or edited some of it in the diff): the file has what they accepted. ' +
  'Read it again before the next change to it, and do not redo what they left out unless they ask.';

/** image: a picture for the model (read_file of a PNG, JPEG or WebP), base64; images: pictures an MCP tool returned. */
export interface ToolResult { ok: boolean; result: string; image?: { mediaType: string; data: string; name: string }; images?: { mediaType: string; data: string }[];
  /** A path outside the workspace: the chat page asks the user, then runs the call again when they allow it. */
  needsAccess?: string }

export interface ToolHost {
  baseUrl(): string;
  apiKey(): string | undefined;
  log(line: string): void;
  commandsChannel: vscode.OutputChannel;
  /** This VS Code's device id (a shared project's link is kept per device and folder). */
  deviceId?(): string;
  /** For the MCP servers: VS Code's state and secret storage, the browser (sign-in) and a change notice. */
  mcp?: Partial<McpManagerOptions>;
}

export class WorkspaceTools {
  /** Saves files before an answer's first change to them (Rewind in the chat puts them back). */
  checkpoints?: Checkpoints;
  readonly background = new BackgroundCommands();
  readonly hooks: HookRunner;
  readonly mcp: McpManager;
  readonly skills: SkillCatalog;
  /** Language servers, VS Code commands, tasks, the debugger and other extensions' tools. */
  readonly ide: IdeTools;
  /**
   * Shows a proposed file change as a diff and asks to apply it (set by the extension): false = rejected, true = accepted
   * as proposed, a string = accepted as the user left it (single changes reverted or edited in the diff).
   */
  reviewChange?: (full: string, before: string, after: string, existed: boolean) => Promise<boolean | string>;
  /** Runs the project (Run in Chat, the preview tool): dev servers, the app, its tests. */
  readonly runner: ProjectRunner;
  /** Shows a web page beside the chat (set by the extension: the Simple Browser). */
  showPreview?: (url: string, title: string) => Promise<void>;

  constructor(private readonly host: ToolHost) {
    this.hooks = new HookRunner(() => this.roots(), () => this.shell(), () => this.cfg.get<boolean>('hooks.includeClaudeUser', false));
    this.mcp = new McpManager({
      roots: () => this.roots(), log: host.log,
      includeClaude: () => this.cfg.get<boolean>('mcp.includeClaude', true),
      includeVsCode: () => this.cfg.get<boolean>('mcp.includeVsCode', true),
      vscodeSetting: () => vscode.workspace.getConfiguration().get('mcp'),
      ...(host.mcp || {})
    });
    this.skills = new SkillCatalog(() => this.roots());
    this.ide = new IdeTools(p => this.resolve(p), () => this.roots(), () => this.cfg.get<string>('tools.vscodeTools', 'others'), () => this.cfg.get<boolean>('mcp.includeVsCode', true));
    this.runner = new ProjectRunner(() => this.roots(), () => this.shell(), () => this.allowCommands);
    this.runner.keyPrefix = () => (host.deviceId ? host.deviceId() : '') || 'vscode';
    this.runner.uploader = (zip, q) => this.uploadSite(zip, q);
  }

  /** Share: a project's website (a zip) to the Agentic server, which gives it a public link (the same one for the same project). */
  private async uploadSite(zip: Buffer, q: { title: string; source: string; key: string }): Promise<any> {
    const base = this.host.baseUrl();
    if (!base) throw new Error('No Agentic server is set.');
    const headers: Record<string, string> = { 'Content-Type': 'application/zip', Accept: 'application/json' };
    const key = this.host.apiKey();
    if (key) headers['Authorization'] = 'Bearer ' + key;
    const url = `${base}/api/chat/artifacts/share-site?title=${encodeURIComponent(q.title)}&source=${encodeURIComponent(q.source)}&key=${encodeURIComponent(q.key)}`;
    const res = await fetch(url, { method: 'POST', headers, body: zip, signal: AbortSignal.timeout(120000) });
    const text = await res.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch { /* not JSON */ }
    if (!res.ok) throw new Error((j && j.error && j.error.message) || `The server answered ${res.status}.`);
    return j;
  }

  dispose(): void { this.background.dispose(killTree); this.mcp.dispose(); this.runner.stopAll(); }

  /** Stops a background command or monitor (/bashes, /monitors in the chat). */
  stopCommand(id: string): string { return this.background.kill(id, killTree); }

  get reviewEdits(): boolean { return this.cfg.get<boolean>('tools.reviewEdits', true); }

  /** Every tool for one message: the workspace tools, local MCP servers' tools and Skill (when there are skills). */
  async allDefinitions(): Promise<ToolDefinition[]> {
    if (!this.enabled) return [];
    await this.mcp.ensure().catch(() => { });
    const ide = this.cfg.get<boolean>('tools.ideTools', true) ? ideDefinitions() : [];
    const list: ToolDefinition[] = [...this.definitions(), ...ide, ...this.mcp.definitions(), ...this.mcp.resourceDefinitions(), ...this.ide.lmDefinitions()];
    const skills = await this.skills.skills();
    if (skills.length) list.push({ name: 'Skill', 'x-risk': 'read', description: 'Load a skill (instructions and files for a kind of task) by its name.', parameters: { type: 'object', properties: { skill: { type: 'string' } }, required: ['skill'] } });
    return list;
  }

  /** The instructions for one message: tools, AGENTIC.md, skills, a /command it starts with, and @-mentioned files. */
  async allInstructions(content: string): Promise<string> {
    if (!this.enabled) return '';
    let out = this.instructions() + await this.agenticInstructions() + this.mcp.instructions() + (this.cfg.get<boolean>('tools.ideTools', true) ? IDE_NOTE : '');
    const skills = await this.skills.skills();
    if (skills.length) out += '\nSkills (load one with the Skill tool when the task fits): ' + skills.map((s: { name: string; description?: string }) => `${s.name}${s.description ? ' - ' + s.description : ''}`).join('; ') + '\n';
    const cmd = await this.skills.expandCommand(content) || await this.mcp.expandPrompt(content).catch(() => null);
    if (cmd) out += `\nThe user ran the custom command /${cmd.name}. Do what it says:\n${cmd.prompt}\n`;
    out += await this.mentionedFiles(content);
    return out;
  }

  /** Files named with @path in the message: their text goes with it (at most 6 files, 60,000 characters each). */
  async mentionedFiles(content: string): Promise<string> {
    const found = new Set<string>();
    const re = /(?:^|\s)@(?:"([^"]+)"|([^\s"]+))/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content || '')) && found.size < 6) found.add((m[1] || m[2]).replace(/[.,;:!?)]+$/, ''));
    let out = '';
    for (const p of found) {
      try {
        const full = this.resolve(p);
        const stat = await fs.stat(full);
        if (stat.isDirectory()) { out += `\nFolder the user mentioned: @${p}\n${await this.listDir(p)}\n`; continue; }
        const text = await fs.readFile(full, 'utf8');
        // The model has the whole file: it may change it without reading it again (like Claude Code's @ mentions).
        if (text.length <= 60000) await this.noteRead(MENTIONED, full);
        out += `\nFile the user mentioned: @${p} (${full})\n\`\`\`\n${text.length > 60000 ? text.slice(0, 60000) + '\n… (shortened; read_file for more)' : text}\n\`\`\`\n`;
      } catch { /* not a file in the workspace: the model reads it as plain text */ }
    }
    return out;
  }

  /** Files for the @ list in the message box (workspace-relative paths matching the typed text). */
  async listFiles(query: string): Promise<string[]> {
    const q = (query || '').replace(/[\\[\]{}()!*?]/g, '');
    const uris = await vscode.workspace.findFiles(q ? `**/*${q}*` : '**/*', '{**/node_modules/**,**/.git/**,**/bin/**,**/obj/**,**/dist/**,**/out/**}', 60);
    return uris.map(u => vscode.workspace.asRelativePath(u, this.roots().length > 1)).sort((a, b) => a.length - b.length).slice(0, 30);
  }

  /** /add-dir: adds a folder to the VS Code workspace (the model may then work in it). */
  addFolder(p: string): string {
    const full = path.resolve(p.replace(/^~(?=$|[\\/])/, os.homedir()));
    if (!fsSync.existsSync(full)) throw new Error('No such folder: ' + full);
    const n = (vscode.workspace.workspaceFolders || []).length;
    if (!vscode.workspace.updateWorkspaceFolders(n, 0, { uri: vscode.Uri.file(full) })) throw new Error('VS Code did not add the folder.');
    return full;
  }

  /** The project's instructions file: AGENTIC.md (or an existing agentic.md / AGENTS.md) in the first workspace folder. */
  async agenticMdPath(): Promise<string | undefined> {
    const dir = this.roots()[0];
    if (!dir) return undefined;
    for (const name of ['AGENTIC.md', 'agentic.md', 'AGENTS.md']) {
      const p = path.join(dir, name);
      if (await fs.stat(p).then(s => s.isFile(), () => false)) return p;
    }
    return path.join(dir, 'AGENTIC.md');
  }

  /**
   * The instruction files of every workspace folder (AGENTIC.md, AGENTS.md, CLAUDE.md and their local forms), for the model's
   * instructions ('' when there are none). Repositories often have only a CLAUDE.md, so it counts as much as the others.
   */
  async agenticInstructions(): Promise<string> {
    let out = '';
    const seen = new Set<string>();
    for (const dir of this.roots()) {
      for (const name of ['AGENTIC.md', 'agentic.md', 'AGENTS.md', 'CLAUDE.md', path.join('.claude', 'CLAUDE.md'), 'AGENTS.local.md', 'CLAUDE.local.md']) {
        const p = path.join(dir, name);
        const raw = await fs.readFile(p, 'utf8').catch(() => null);
        const text = raw === null ? '' : raw.trim();
        // The same text once (on Windows and macOS AGENTIC.md and agentic.md are one file).
        if (!text || seen.has(text)) continue;
        seen.add(text);
        if (out.length + text.length > 60000) break;
        out += `\nProject instructions from ${p} (follow them):\n${text.length > 20000 ? text.slice(0, 20000) + '\n… (shortened)' : text}\n`;
      }
    }
    return out;
  }

  private get cfg() { return vscode.workspace.getConfiguration('agentic'); }
  get enabled(): boolean { return this.cfg.get<boolean>('tools.enabled', true); }
  get allowCommands(): boolean { return this.cfg.get<boolean>('tools.allowCommands', true); }

  /** /worktree: the git worktree the tools work in instead of the first workspace folder (null: the folders as they are). */
  worktreeRoot: string | null = null;

  roots(): string[] {
    const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file').map(f => f.uri.fsPath);
    return this.worktreeRoot ? [this.worktreeRoot, ...folders.filter(f => path.resolve(f) !== path.resolve(this.worktreeRoot!))] : folders;
  }

  private definitionOptions(): DefinitionOptions {
    const shell = this.shell();
    return {
      workspaces: this.roots(),
      shellLabel: shell.label,
      osLabel: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
      allowCommands: this.allowCommands
    };
  }

  definitions(): ToolDefinition[] { return this.enabled ? toolDefinitions(this.definitionOptions()) : []; }
  instructions(): string { return this.enabled ? toolInstructions(this.definitionOptions()) : ''; }

  /**
   * call.mode is the chat's permission mode (the server sends it with each call): only "manual" asks before a change, so
   * only then is an edit shown as a diff to accept or reject - and not when the user just approved this very call in the
   * chat (call.approved).
   */
  async run(name: string, rawArgs: unknown, chatId?: string, call: { mode?: string; approved?: boolean; id?: string } = {}): Promise<ToolResult> {
    if (!this.enabled) return { ok: false, result: 'Workspace tools are switched off in the VS Code settings (agentic.tools.enabled).' };
    let a = parseArgs(rawArgs);
    // A deny rule in the settings files blocks the call here too (a call from another window, or an older server).
    const denied = matchingRule(this.rules().deny, name, a);
    if (denied) return { ok: false, result: `Blocked by the permission rule ${denied} in the settings files. Do not try it again; continue without it or ask the user.` };
    // Hooks (Claude Code's format, in .agentic/settings.json): PreToolUse can block a call or rewrite its input; PostToolUse
    // (PostToolUseFailure when it failed) can add feedback or context.
    const common = { session_id: chatId || '', permission_mode: call.mode || '', tool_use_id: call.id || '' };
    const pre = await this.hooks.run('PreToolUse', name, { ...common, tool_input: a });
    if (pre.blocked) return { ok: false, result: 'Blocked by a PreToolUse hook: ' + pre.message };
    if (pre.updatedInput) a = pre.updatedInput as Record<string, any>;
    const review = this.reviewEdits && !!this.reviewChange && call.mode === 'manual' && !call.approved;
    const r = await this.runTool(name, a, chatId, review);
    const post = await this.hooks.run(r.ok ? 'PostToolUse' : 'PostToolUseFailure', name,
      { ...common, tool_input: a, tool_response: { ok: r.ok, result: r.result.slice(0, 20000) }, ...(r.ok ? {} : { error: r.result.slice(0, 20000) }) });
    const notes: string[] = [];
    if (post.blocked) notes.push('PostToolUse hook feedback: ' + post.message);
    else if (post.message) notes.push('(Hook feedback: ' + post.message + ')');
    if (post.context) notes.push(post.context);
    return notes.length ? { ...r, result: r.result + '\n\n' + notes.join('\n') } : r;
  }

  // ------------------------------------------------------------------ read before change (like Claude Code)

  /** What each chat read: chat|path → a fingerprint of the text it saw. */
  private readonly reads = new Map<string, string>();
  private readKey(chatId: string | undefined, full: string): string {
    const p = path.resolve(full);
    return (chatId || '') + '|' + (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p);
  }
  private static fingerprint(text: string): string { return createHash('sha256').update(text).digest('hex'); }

  /** The chat has seen this file as it is now (read_file, or its own change). */
  private async noteRead(chatId: string | undefined, full: string): Promise<void> {
    try { this.reads.set(this.readKey(chatId, full), WorkspaceTools.fingerprint(await this.readText(full))); } catch { /* gone */ }
  }

  /** Why the chat may not change an existing file yet (null: it may): not read in this chat, or changed since. */
  private async staleReason(chatId: string | undefined, full: string): Promise<string | null> {
    if (!await fs.stat(full).then(s => s.isFile(), () => false) && !this.openDocument(full)) return null;
    const seen = this.reads.get(this.readKey(chatId, full)) ?? this.reads.get(this.readKey(MENTIONED, full));
    const rel = vscode.workspace.asRelativePath(vscode.Uri.file(full));
    if (seen === undefined) return `${rel} has not been read in this chat yet. Read it with read_file first, then make the change.`;
    let now = '';
    try { now = WorkspaceTools.fingerprint(await this.readText(full)); } catch { return null; }
    return now === seen ? null : `${rel} changed since you read it (the user, a formatter or a command changed it). Read it again with read_file, then make the change.`;
  }

  /** A file's text for an approval card's diff (null when it is not a text file in the workspace). */
  async fileTextForApproval(p: string): Promise<string | null> {
    try {
      const full = this.resolve(p);
      const st = await fs.stat(full).catch(() => undefined);
      if (!this.openDocument(full) && (!st || !st.isFile() || st.size > 2_000_000)) return null;
      return await this.readText(full);
    } catch { return null; }
  }

  private async runTool(name: string, a: Record<string, any>, chatId?: string, review = false): Promise<ToolResult> {
    if (this.ide.owns(name)) return this.ide.run(name, a);
    if (name.startsWith('mcp__') || name === 'list_mcp_resources' || name === 'read_mcp_resource') {
      const r = await this.mcp.call(name, a);
      if (!r) return { ok: false, result: 'That MCP server is not connected now. /mcp shows its state (Agentic: MCP Servers).' };
      return r.images.length ? { ok: r.ok, result: r.result, images: r.images.slice(0, 4) } : { ok: r.ok, result: r.result };
    }
    try {
      switch (name) {
        case 'read_file': {
          const full = this.resolve(a.path);
          // A picture goes to the model as an image.
          const mime = IMAGE_TYPES[path.extname(full).toLowerCase()];
          const st = mime ? await fs.stat(full).catch(() => undefined) : undefined;
          if (mime && st && st.isFile() && st.size > 0 && st.size <= 8 * 1024 * 1024) {
            const data = await fs.readFile(full);
            await this.noteRead(chatId, full);
            return { ok: true, result: `${vscode.workspace.asRelativePath(vscode.Uri.file(full))} is a picture (${sizeText(st.size)}); it follows as an image.`,
              image: { mediaType: mime, data: data.toString('base64'), name: path.basename(full) } };
          }
          const text = await this.readFile(a.path, a.offset, a.limit);
          await this.noteRead(chatId, full);
          return ok(text);
        }
        case 'list_dir': return ok(await this.listDir(a.path));
        case 'glob_files': return ok(await this.globFiles(String(a.pattern || '**/*'), a.path));
        case 'grep': return ok(await this.grep(String(a.pattern || ''), a.path, a.glob, !!a.ignore_case));
        case 'Skill': {
          const body = await this.skills.skillBody(String(a.skill || ''));
          return body ? ok(body) : { ok: false, result: 'No skill with that name. Available: ' + (await this.skills.skills()).map((s: { name: string }) => s.name).join(', ') };
        }
        case 'monitor': return this.startMonitor(a, chatId);
        case 'preview': return await this.runner.tool(a, this.showPreview);
        case 'command_output': return ok(await this.background.status(String(a.id || ''), Number(a.wait_seconds) || 0));
        case 'kill_command': return ok(this.background.kill(String(a.id || ''), killTree));
        case 'edit_notebook':
        case 'write_file':
        case 'edit_file': {
          // Like Claude Code: an existing file is changed only after this chat read it, and not when it changed since.
          const full = this.resolve(a.path);
          const stale = await this.staleReason(chatId, full);
          if (stale) return { ok: false, result: stale };
          await this.checkpoints?.beforeChange(chatId, full);
          const r = name === 'edit_notebook'
            ? await this.editNotebook(a.path, Number(a.cell), String(a.mode || 'replace'), typeof a.source === 'string' ? a.source : '', String(a.cell_type || 'code'))
            : name === 'write_file' ? ok(await this.writeFile(a.path, typeof a.content === 'string' ? a.content : '', review))
              : await this.editFile(a.path, String(a.old_string ?? ''), String(a.new_string ?? ''), !!a.replace_all, review);
          if (r.ok) await this.noteRead(chatId, full);
          return r;
        }
        case 'run_command':
        case 'run_command_background':
          if (!this.allowCommands) return { ok: false, result: 'Running commands is switched off in the VS Code settings (agentic.tools.allowCommands).' };
          // timeout_seconds: the older name of wait_seconds (a command is never stopped for taking long).
          return await this.runCommand(String(a.command || ''), a.cwd, Number(a.wait_seconds) || Number(a.timeout_seconds) || 0,
            name === 'run_command_background' || !!a.background, chatId);
        case 'vscode_editor_context': return ok(this.editorContext());
        case 'vscode_diagnostics': return ok(this.diagnostics(a.path, !!a.include_warnings));
        case 'open_file': return ok(await this.openFile(a.path, Number(a.line) || 0, typeof a.find === 'string' ? a.find : ''));
        case 'agentic_api': return await this.agenticApi(String(a.method || 'GET'), String(a.path || ''), a.body);
      }
      return { ok: false, result: `Unknown tool ${name}.` };
    } catch (e: any) {
      if (e instanceof OutsideWorkspaceError) return { ok: false, result: e.message, needsAccess: e.full };
      return { ok: false, result: e && e.message ? e.message : String(e) };
    }
  }

  // ------------------------------------------------------------------ files

  /** Paths outside the workspace the user allowed in this window (a file, or a folder and what is in it). */
  private readonly allowedPaths = new Set<string>();
  allowPath(p: string): void { this.allowedPaths.add(path.resolve(p)); }

  /** Claude Code's permission rules in the settings files (read again for each message: they are small). */
  rules(): Rules { return loadRules(this.roots()); }

  /** Inside the workspace, the folders its settings add (additionalDirectories) or the user allowed; anywhere with agentic.tools.wholeComputer. */
  private resolve(p: string | undefined): string {
    return resolveInside(p, this.roots(), [...this.rules().additionalDirectories, ...this.allowedPaths], this.cfg.get<boolean>('tools.wholeComputer', false));
  }

  /** The open editor's document for a path, if it is open. */
  private openDocument(full: string): vscode.TextDocument | undefined {
    const norm = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s;
    return vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && norm(d.uri.fsPath) === norm(full));
  }

  private async readText(full: string): Promise<string> {
    const doc = this.openDocument(full);
    if (doc) return doc.getText();
    const st = await fs.stat(full).catch(() => undefined);
    if (!st || !st.isFile()) throw new Error('No such file: ' + full);
    if (st.size > MAX_FILE_BYTES) throw new Error('The file is larger than 20 MB.');
    const bytes = await fs.readFile(full);
    if (looksBinary(bytes)) throw new Error(`${full} is a binary file (${sizeText(st.size)}).`);
    return bytes.toString('utf8');
  }

  private async readFile(p: string, offset?: number, limit?: number): Promise<string> {
    const full = this.resolve(p);
    return numberLines(await this.readText(full), offset || 1, limit || 2000);
  }

  private async listDir(p?: string): Promise<string> {
    const full = this.resolve(p);
    const entries = await fs.readdir(full, { withFileTypes: true }).catch(() => { throw new Error('No such folder: ' + full); });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name).sort((x, y) => x.localeCompare(y)).slice(0, 300);
    const files = entries.filter(e => e.isFile()).map(e => e.name).sort((x, y) => x.localeCompare(y)).slice(0, 500);
    const lines = [full, ...dirs.map(d => `  ${d}/`)];
    for (const f of files) {
      const st = await fs.stat(path.join(full, f)).catch(() => undefined);
      lines.push(`  ${f}  (${st ? sizeText(st.size) : '?'})`);
    }
    if (entries.length > dirs.length + files.length) lines.push(`  … ${entries.length - dirs.length - files.length} more`);
    return lines.join('\n');
  }

  private searchBases(p?: string): string[] { return p && String(p).trim() ? [this.resolve(p)] : this.roots(); }

  private async globFiles(pattern: string, p?: string): Promise<string> {
    const bases = this.searchBases(p);
    if (!bases.length) throw new Error('No folder is open in VS Code.');
    const found: string[] = [];
    for (const b of bases) {
      const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(b, pattern), EXCLUDE, 1000);
      found.push(...uris.map(u => vscode.workspace.asRelativePath(u, bases.length > 1 || this.roots().length > 1)));
    }
    found.sort();
    if (!found.length) return `No files match ${pattern}.`;
    return clip(found.slice(0, 1000).join('\n') + (found.length > 1000 ? `\n… ${found.length - 1000} more` : ''));
  }

  private async grep(pattern: string, p?: string, glob?: string, ignoreCase = false): Promise<string> {
    if (!pattern) throw new Error('pattern is required.');
    let re: RegExp;
    try { re = new RegExp(pattern, ignoreCase ? 'i' : ''); } catch (e: any) { throw new Error('Invalid regular expression: ' + e.message); }
    const bases = this.searchBases(p);
    if (!bases.length) throw new Error('No folder is open in VS Code.');
    const MAX = 300;
    const hits: string[] = [];
    for (const b of bases) {
      // A single file was given: search just that file.
      const st = await fs.stat(b).catch(() => undefined);
      const uris = st && st.isFile() ? [vscode.Uri.file(b)]
        : await vscode.workspace.findFiles(new vscode.RelativePattern(b, glob || '**/*'), EXCLUDE, 5000);
      for (const u of uris) {
        if (hits.length >= MAX) break;
        let text: string;
        try {
          const doc = this.openDocument(u.fsPath);
          if (doc) text = doc.getText();
          else {
            const s = await fs.stat(u.fsPath);
            if (s.size > 2_000_000) continue;
            const bytes = await fs.readFile(u.fsPath);
            if (looksBinary(bytes)) continue;
            text = bytes.toString('utf8');
          }
        } catch { continue; }
        hits.push(...grepText(text, re, vscode.workspace.asRelativePath(u, this.roots().length > 1), MAX - hits.length));
      }
    }
    if (!hits.length) return `No matches for /${pattern}/.`;
    return clip(hits.join('\n') + (hits.length >= MAX ? `\n… stopped at ${MAX} matches; narrow the search with path or glob` : ''));
  }

  /** A file change the user asked for in the chat (Apply on a code block): shown as a diff first; false when rejected. */
  async applyFromChat(p: string, content: string): Promise<{ applied: boolean; result: string }> {
    try { return { applied: true, result: await this.writeFile(p, content, true) }; }
    catch (e: any) { return { applied: false, result: e && e.message ? e.message : String(e) }; }
  }

  private async writeFile(p: string, content: string, review = false): Promise<string> {
    const full = this.resolve(p);
    const uri = vscode.Uri.file(full);
    const exists = await fs.stat(full).then(s => s.isFile(), () => false);
    let partly = '';
    if (review && this.reviewChange) {
      const before = exists ? (await vscode.workspace.openTextDocument(uri)).getText() : '';
      const verdict = await this.reviewChange(full, before, content, exists);
      if (verdict === false) throw new Error('The user rejected this change to ' + vscode.workspace.asRelativePath(uri) + '. Do not make it; ask what they want instead.');
      if (typeof verdict === 'string' && verdict !== content) { content = verdict; partly = ' ' + PARTLY_NOTE; }
    }
    let unsaved = '';
    if (exists) {
      // An existing file changes in its editor (undoable; the file keeps its own line endings). The user's unsaved changes
      // in that editor are not saved for them: then the change stays unsaved too.
      const doc = await vscode.workspace.openTextDocument(uri);
      const wasDirty = doc.isDirty;
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, fullRange(doc), content);
      if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code did not apply the change to ' + full);
      if (wasDirty) unsaved = ' ' + UNSAVED_NOTE;
      else await doc.save();
    } else {
      // A new file is written exactly as given (a new editor would use the platform's line endings: CRLF on Windows).
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(full)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }
    const lines = content.length ? content.split(/\r?\n/).length : 0;
    return `${exists ? 'Overwrote' : 'Created'} ${vscode.workspace.asRelativePath(uri)} (${lines} lines).${unsaved}${partly}`;
  }

  private async editFile(p: string, oldString: string, newString: string, replaceAll: boolean, review = false): Promise<ToolResult> {
    const full = this.resolve(p);
    const uri = vscode.Uri.file(full);
    if (!await fs.stat(full).then(s => s.isFile(), () => false)) return { ok: false, result: 'No such file: ' + full };
    const doc = await vscode.workspace.openTextDocument(uri);
    const r = applyEdit(doc.getText(), oldString, newString, replaceAll);
    if (!r.ok || r.text === undefined) return { ok: false, result: r.error || 'The edit failed.' };
    if (r.replaced === 0) return { ok: true, result: `${vscode.workspace.asRelativePath(uri)}: ${r.note || 'no change needed.'}` };
    let text = r.text, partly = '';
    if (review && this.reviewChange) {
      const verdict = await this.reviewChange(full, doc.getText(), r.text, true);
      if (verdict === false) return { ok: false, result: 'The user rejected this edit to ' + vscode.workspace.asRelativePath(uri) + '. Do not make it; ask what they want instead.' };
      if (typeof verdict === 'string' && verdict !== r.text) { text = verdict; partly = ' ' + PARTLY_NOTE; }
    }
    const wasDirty = doc.isDirty;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, fullRange(doc), text);
    if (!await vscode.workspace.applyEdit(edit)) return { ok: false, result: 'VS Code did not apply the edit to ' + full };
    // The user's unsaved changes in that editor are not saved for them: then the edit stays unsaved too.
    if (!wasDirty) await doc.save();
    return { ok: true, result: `Edited ${vscode.workspace.asRelativePath(uri)}: ${r.replaced} replacement${r.replaced === 1 ? '' : 's'}.${r.note ? ' ' + r.note : ''}${wasDirty ? ' ' + UNSAVED_NOTE : ''}${partly}` };
  }

  private async editNotebook(p: string, cell: number, mode: string, source: string, cellType: string): Promise<ToolResult> {
    const full = this.resolve(p);
    if (!/\.ipynb$/i.test(full)) return { ok: false, result: 'edit_notebook works on .ipynb files.' };
    const nb = await vscode.workspace.openNotebookDocument(vscode.Uri.file(full));
    const kind = cellType === 'markdown' ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
    const lang = kind === vscode.NotebookCellKind.Markup ? 'markdown' : (nb.cellAt(0)?.document.languageId || 'python');
    if (!Number.isInteger(cell) || cell < 0 || cell > nb.cellCount || (mode !== 'insert' && cell >= nb.cellCount)) return { ok: false, result: `No cell ${cell}: the notebook has ${nb.cellCount} cells (0-${nb.cellCount - 1}).` };
    const edit = new vscode.WorkspaceEdit();
    const data = new vscode.NotebookCellData(kind, source, lang);
    const e = mode === 'delete' ? vscode.NotebookEdit.deleteCells(new vscode.NotebookRange(cell, cell + 1))
      : mode === 'insert' ? vscode.NotebookEdit.insertCells(cell, [data])
        : vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(cell, cell + 1), [data]);
    edit.set(nb.uri, [e]);
    if (!await vscode.workspace.applyEdit(edit)) return { ok: false, result: 'VS Code did not apply the change to the notebook.' };
    await nb.save();
    return ok(`${mode === 'delete' ? 'Deleted' : mode === 'insert' ? 'Inserted' : 'Replaced'} cell ${cell} in ${vscode.workspace.asRelativePath(nb.uri)} (now ${nb.cellCount} cells).`);
  }

  /** find (a click on an edit in the chat): the edit's first line, selected where the file has it now. */
  private async openFile(p: string, line: number, find = ''): Promise<string> {
    const full = this.resolve(p);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(full));
    const at = !line && find ? doc.getText().indexOf(find) : -1;
    const pos = new vscode.Position(Math.max(0, Math.min(doc.lineCount - 1, (line || 1) - 1)), 0);
    const selection = at >= 0 ? new vscode.Range(doc.positionAt(at), doc.positionAt(at + find.length)) : new vscode.Range(pos, pos);
    await vscode.window.showTextDocument(doc, { preview: false, selection, viewColumn: vscode.ViewColumn.One });
    const shown = at >= 0 ? selection.start.line + 1 : line;
    return `Opened ${vscode.workspace.asRelativePath(doc.uri)}${shown ? ' at line ' + shown : ''}.`;
  }

  // ------------------------------------------------------------------ editor state

  editorContext(): string {
    const ed = vscode.window.activeTextEditor;
    const parts: string[] = [];
    if (ed) {
      const d = ed.document;
      parts.push(`Active file: ${d.uri.scheme === 'file' ? vscode.workspace.asRelativePath(d.uri) : d.uri.toString()} (${d.languageId}, ${d.lineCount} lines${d.isDirty ? ', unsaved changes' : ''})`);
      parts.push(`Cursor: line ${ed.selection.active.line + 1}, column ${ed.selection.active.character + 1}`);
      const sels = ed.selections.filter(s => !s.isEmpty);
      for (const s of sels.slice(0, 5)) {
        parts.push(`Selection lines ${s.start.line + 1}-${s.end.line + 1}:\n\`\`\`${d.languageId}\n${clip(d.getText(s), 20000)}\n\`\`\``);
      }
      if (!sels.length) parts.push('No text is selected.');
    } else {
      parts.push('No file is active in the editor.');
    }
    const open = vscode.window.tabGroups.all.flatMap(g => g.tabs)
      .map(t => t.input instanceof vscode.TabInputText ? vscode.workspace.asRelativePath(t.input.uri) : undefined)
      .filter((x): x is string => !!x);
    if (open.length) parts.push('Open editors:\n' + [...new Set(open)].slice(0, 50).map(x => '  ' + x).join('\n'));
    const roots = this.roots();
    parts.push('Workspace folders: ' + (roots.length ? roots.join('; ') : 'none'));
    return parts.join('\n');
  }

  diagnostics(p: string | undefined, includeWarnings: boolean): string {
    const max = vscode.DiagnosticSeverity.Warning;
    const wanted = (d: vscode.Diagnostic) => d.severity === vscode.DiagnosticSeverity.Error || (includeWarnings && d.severity <= max);
    let entries: [vscode.Uri, vscode.Diagnostic[]][];
    if (p && String(p).trim()) {
      const uri = vscode.Uri.file(this.resolve(p));
      entries = [[uri, vscode.languages.getDiagnostics(uri)]];
    } else {
      entries = vscode.languages.getDiagnostics();
    }
    const lines: string[] = [];
    for (const [uri, list] of entries) {
      for (const d of list.filter(wanted)) {
        if (lines.length >= 300) break;
        const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
        const code = typeof d.code === 'object' ? d.code.value : d.code;
        lines.push(`${vscode.workspace.asRelativePath(uri)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${sev}: ${d.message}` +
          (d.source || code !== undefined ? ` [${[d.source, code].filter(x => x !== undefined && x !== '').join(' ')}]` : ''));
      }
    }
    if (!lines.length) return `No ${includeWarnings ? 'errors or warnings' : 'errors'}${p ? ' in ' + p : ' in the workspace'}.`;
    return lines.join('\n') + (lines.length >= 300 ? '\n… (first 300)' : '');
  }

  // ------------------------------------------------------------------ commands

  private shellCache?: { choice: string; value: { exe: string; args: (cmd: string) => string[]; label: string } };

  shell(): { exe: string; args: (cmd: string) => string[]; label: string } {
    const choice = this.cfg.get<string>('tools.shell', 'auto');
    if (this.shellCache && this.shellCache.choice === choice) return this.shellCache.value;
    const value = this.findShell(choice);
    this.shellCache = { choice, value };
    return value;
  }

  private findShell(choice: string): { exe: string; args: (cmd: string) => string[]; label: string } {
    const has = (exe: string) => {
      try { return spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { windowsHide: true }).status === 0; } catch { return false; }
    };
    const pick = choice === 'auto'
      ? (process.platform === 'win32' ? (has('pwsh') ? 'pwsh' : 'powershell') : (has('bash') ? 'bash' : 'sh'))
      : choice;
    switch (pick) {
      // PowerShell -Command ends with 1 for any failure: POWERSHELL_EXIT keeps the command's own exit code (a hook's 2 blocks).
      case 'pwsh': return { exe: 'pwsh', args: c => ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', c + '\n' + POWERSHELL_EXIT], label: 'PowerShell 7' };
      case 'powershell': return { exe: 'powershell.exe', args: c => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', c + '\n' + POWERSHELL_EXIT], label: 'Windows PowerShell' };
      case 'cmd': return { exe: 'cmd.exe', args: c => ['/d', '/s', '/c', c], label: 'cmd' };
      default: return { exe: pick, args: c => ['-c', c], label: pick };
    }
  }

  /**
   * run_command and run_command_background. A command is never stopped for taking long: run_command waits up to its wait
   * (wait_seconds, default tools.commandTimeoutSeconds) and then lets it go on in the background, so the model gets control
   * back and can audit it (command_output) or stop it (kill_command) instead of being stuck behind it. It also returns as soon
   * as the shell ends, even when something the command started (a server) keeps its output open.
   */
  private async runCommand(command: string, cwdArg: string | undefined, waitSeconds: number, background = false, chatId?: string): Promise<ToolResult> {
    if (!command.trim()) return { ok: false, result: 'command is empty.' };
    // It starts where the chat's last cd left it.
    const cwd = this.commandFolder(chatId, cwdArg);
    const sh = this.shell();
    const ch = this.host.commandsChannel;
    if (background) {
      ch.appendLine(`\n> ${command}   (${cwd}, in the background)`);
      const bgId = this.background.start(sh.exe, sh.args(command), cwd, command, s => ch.append(s));
      return ok(`Started in the background as ${bgId}; it runs until it ends or you stop it. Check on it with command_output {"id":"${bgId}"} ` +
        '(add wait_seconds to wait for it) and stop it with kill_command.');
    }
    const wait = Math.min(3600, Math.max(5, waitSeconds || this.cfg.get<number>('tools.commandTimeoutSeconds', 120)));
    ch.appendLine(`\n> ${command}   (${cwd})`);
    const id = this.background.start(sh.exe, sh.args(withCwdMarker(command, sh.exe)), cwd, command, s => ch.append(s.includes(CWD_MARKER) ? s.replace(/^__AGENTIC_CWD__=.*$/gm, '') : s));
    const how = await this.background.waitFor(id, wait * 1000);
    // The folder it ended in (its last line) is taken out of the output: the chat's next commands start there.
    const split = splitCwd(stripAnsi(this.background.takeRaw(id)));
    let text = clip(split.text.trim() || '(no output)');
    if (how !== 'running') { const moved = this.keepCwd(chatId, cwd, split.folder); if (moved) text += '\n' + moved; }
    const code = this.background.exitCode(id);
    if (how === 'finished' || how === 'missing') {
      this.background.forget(id);
      return { ok: code === 0, result: `Exit code ${code}.\n${text}` };
    }
    if (how === 'shell-ended') {
      return { ok: code === 0, result: `Exit code ${code}.\n${text}\n(Something this command started is still running and printing: it goes on in the ` +
        `background as ${id}. See what it prints with command_output {"id":"${id}"}; stop it with kill_command.)` };
    }
    return ok(`Still running after ${wait} s, so it goes on in the background as ${id} (it was not stopped).\nOutput so far:\n${text}\n` +
      `Check on it with command_output {"id":"${id}"} (add wait_seconds to wait for it to finish), or stop it with kill_command.`);
  }

  /** Where each chat's commands run next (after a cd): chat → folder. */
  private readonly cwds = new Map<string, string>();

  /** The folder a command of this chat starts in: cwd when given, else where its last cd left it, else the first workspace folder. */
  private commandFolder(chatId: string | undefined, cwdArg: string | undefined): string {
    if (cwdArg && String(cwdArg).trim()) return this.resolve(cwdArg);
    const roots = this.roots();
    const kept = this.cwds.get(chatId || '');
    if (kept && fsSync.existsSync(kept) && roots.some(r => isInside(kept, r))) return kept;
    return roots[0] || os.homedir();
  }

  /** After a command: the chat's next commands start where it ended, if that is in a workspace folder; a note otherwise. */
  private keepCwd(chatId: string | undefined, started: string, folder: string | null): string | null {
    if (!folder || !fsSync.existsSync(folder)) return null;
    const full = path.resolve(folder);
    const same = (x: string, y: string) => process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
    if (same(full.replace(/[\\/]+$/, ''), path.resolve(started).replace(/[\\/]+$/, ''))) return null;
    if (this.roots().some(r => isInside(full, r))) { this.cwds.set(chatId || '', full); return null; }
    return 'Shell cwd was reset to ' + started;
  }

  // ------------------------------------------------------------------ the Agentic API

  /**
   * monitor: a background command whose new output lines (those matching the filter) go to the chat every 2 seconds, and how it
   * ended; the server answers them when the chat is not busy.
   */
  private startMonitor(a: Record<string, any>, chatId?: string): ToolResult {
    if (!chatId) return { ok: false, result: 'monitor works in a chat: its output goes into the conversation.' };
    const command = String(a.command || '');
    if (!command.trim()) return { ok: false, result: 'command is empty.' };
    const description = String(a.description || command).slice(0, 60);
    let filter: RegExp | null = null;
    if (a.filter) {
      try { filter = new RegExp(String(a.filter), 'i'); } catch (e) { return { ok: false, result: 'filter is not a valid regular expression: ' + (e as Error).message }; }
    }
    const seconds = Math.min(3600, Math.max(10, Number(a.timeout_seconds) || 600));
    const roots = this.roots();
    const cwd = a.cwd && String(a.cwd).trim() ? this.resolve(a.cwd) : (roots[0] || os.homedir());
    const sh = this.shell();
    const id = this.background.start(sh.exe, sh.args(command), cwd, command);
    this.background.tag(id, 'monitor', description);
    this.host.commandsChannel.appendLine(`\n> ${command}   (${cwd}, watched as ${id})`);
    let pos = 0, rest = '', lastSent = Date.now(), done = false;
    const lines: string[] = [];
    const deadline = Date.now() + seconds * 1000;
    const timer = setInterval(() => {
      if (done) return;
      const got = this.background.since(id, pos);
      pos = got.end;
      const parts = (rest + got.text).replace(/\r\n/g, '\n').split('\n');
      rest = parts.pop() || '';
      for (const p of parts) { const l = p.trimEnd(); if (l && (!filter || filter.test(l)) && lines.length < 300) lines.push(l); }
      let status: string | null = null;
      if (!got.exists) status = 'stopped';
      else if (got.exitCode !== null) status = `the command exited with code ${got.exitCode}`;
      else if (Date.now() > deadline) { this.background.kill(id, killTree); status = 'stopped: its time limit ran out'; }
      if (status !== null && rest.trim() && (!filter || filter.test(rest))) lines.push(rest.trim());
      if ((lines.length && Date.now() - lastSent >= 2000) || status !== null) {
        const batch = lines.splice(0, lines.length);
        lastSent = Date.now();
        void this.sendMonitorEvents(chatId, id, description, batch, status);
      }
      if (status !== null) { done = true; clearInterval(timer); }
    }, 1000);
    return ok(`Monitor ${id} started: watching "${description}"${filter ? ` for lines matching /${a.filter}/` : ''} for up to ${Math.round(seconds / 60)} min. ` +
      `Its output lines arrive in this chat as they happen; stop it with kill_command {"id":"${id}"}.`);
  }

  /** The new lines (and how it ended) to the chat on the Agentic server; a failed send only loses those lines. */
  private async sendMonitorEvents(chatId: string, monitor: string, description: string, lines: string[], status: string | null): Promise<void> {
    const base = this.host.baseUrl();
    if (!base) return;
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const key = this.host.apiKey();
    if (key) headers['Authorization'] = 'Bearer ' + key;
    try {
      await fetch(`${base}/api/chat/conversations/${encodeURIComponent(chatId)}/monitor`, {
        method: 'POST', headers, body: JSON.stringify({ monitor, description, lines, status: status || undefined }), signal: AbortSignal.timeout(30000)
      });
    } catch { /* offline: those lines are lost */ }
  }

  private async agenticApi(method: string, apiPath: string, body: unknown): Promise<ToolResult> {
    const m = method.toUpperCase();
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) return { ok: false, result: 'method must be GET, POST, PUT, PATCH or DELETE.' };
    if (!apiPath.startsWith('/api/')) return { ok: false, result: 'path must start with /api/.' };
    const base = this.host.baseUrl();
    if (!base) return { ok: false, result: 'No Agentic server is set.' };
    const headers: Record<string, string> = { Accept: 'application/json' };
    const key = this.host.apiKey();
    if (key) headers['Authorization'] = 'Bearer ' + key;
    let payload: string | undefined;
    if (m !== 'GET' && body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + apiPath, { method: m, headers, body: payload, signal: AbortSignal.timeout(120000) });
    const text = await res.text();
    return { ok: res.ok, result: clip(`HTTP ${res.status}\n${text}`) };
  }
}

function ok(result: string): ToolResult { return { ok: true, result }; }

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(new vscode.Position(0, 0), doc.lineAt(Math.max(0, doc.lineCount - 1)).range.end);
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}
