/**
 * What only VS Code knows, as tools for the chat model:
 *  - ide_navigate: symbols, go to definition, references and hover (types, docs) from the language servers
 *  - ide_refactor: rename a symbol everywhere, list and apply quick fixes / refactorings, format a file (all undoable)
 *  - vscode_command: run any VS Code command (asks first), or list the commands there are
 *  - ide_run: the workspace's tasks (tasks.json) and debug configurations (launch.json), with the debug console's output
 *  - the tools other extensions offer through VS Code's language model API (vscode.lm.tools), as vscode_tool__<name>
 */
import * as vscode from 'vscode';
import { ToolDefinition } from './definitions';

type Result = { ok: boolean; result: string; images?: { mediaType: string; data: string }[] };
const ok = (result: string): Result => ({ ok: true, result });
const fail = (result: string): Result => ({ ok: false, result });

export const LM_PREFIX = 'vscode_tool__';
export const IDE_TOOLS = ['ide_navigate', 'ide_refactor', 'vscode_command', 'ide_run', 'fetch_url'];

/** A page's text: no scripts, styles or tags; entities decoded; blank runs folded. */
export function htmlToText(html: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return html.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => e[0] === '#' ? String.fromCodePoint(parseInt(e[1].toLowerCase() === 'x' ? e.slice(2) : e.slice(1), e[1].toLowerCase() === 'x' ? 16 : 10)) : (named[e.toLowerCase()] ?? m))
    .replace(/[ \t\r\f]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

/** fetch_url: a web address fetched from this computer (localhost, the LAN, the intranet). */
export async function fetchUrl(a: Record<string, any>): Promise<Result> {
  let u: URL;
  try { u = new URL(String(a.url || '')); } catch { return fail('Give an http(s) URL.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return fail('Give an http(s) URL.');
  const method = String(a.method || 'GET').toUpperCase();
  const headers: Record<string, string> = { 'User-Agent': 'AgenticVSCode/1.0', ...(a.headers && typeof a.headers === 'object' ? a.headers : {}) };
  const body = typeof a.body === 'string' && method !== 'GET' && method !== 'HEAD' ? a.body : undefined;
  if (body && !Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = /^\s*[[{]/.test(body) ? 'application/json' : 'text/plain';
  const res = await fetch(u, { method, headers, body, redirect: 'follow', signal: AbortSignal.timeout(30000) });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  const head = `HTTP ${res.status} ${res.statusText} · ${type || 'no content type'} · ${res.url}`;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) return { ok: res.ok, result: head + `\n(${buf.length} bytes: too large to show)` };
  if (/^image\/(png|jpeg|webp|gif)$/.test(type) && buf.length) return { ok: res.ok, result: head + '\nThe picture follows as an image.', images: [{ mediaType: type, data: buf.toString('base64') }] };
  if (buf.subarray(0, 8000).includes(0)) return { ok: res.ok, result: head + `\n(binary, ${buf.length} bytes)` };
  let text = buf.toString('utf8');
  if (type.includes('html')) text = htmlToText(text);
  return { ok: res.ok, result: head + '\n\n' + (text.length > 60000 ? text.slice(0, 60000) + '\n… (shortened)' : text) };
}

export function ideDefinitions(): ToolDefinition[] {
  const where = {
    path: { type: 'string', description: 'The file (workspace-relative or absolute)' },
    line: { type: 'integer', description: 'Line number (1-based)' },
    symbol: { type: 'string', description: 'The name on that line to put the cursor on (else column, else the first word)' },
    column: { type: 'integer', description: 'Column (1-based), when symbol is not enough' }
  };
  return [
    { name: 'ide_navigate', 'x-risk': 'read',
      description: 'Ask VS Code\'s language servers about code (exact, unlike grep): action "symbols" (a file\'s outline with path, or the workspace\'s symbols matching query), ' +
        '"definition" (where the symbol at path/line is defined), "references" (every use of it), "hover" (its type and documentation), "implementations".',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['symbols', 'definition', 'references', 'hover', 'implementations'] }, query: { type: 'string', description: 'symbols: a name to search the workspace for' }, ...where }, required: ['action'] } },
    { name: 'ide_refactor', 'x-risk': 'change',
      description: 'Change code with VS Code\'s language servers (every change can be undone in the editor): action "rename" (the symbol at path/line to new_name, in every file), ' +
        '"code_actions" (list the quick fixes and refactorings offered at path/line), "apply" (apply the code action titled title), "format" (format the file).',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['rename', 'code_actions', 'apply', 'format'] }, new_name: { type: 'string' }, title: { type: 'string', description: 'apply: the code action\'s title from code_actions' }, ...where }, required: ['action', 'path'] } },
    { name: 'vscode_command', 'x-risk': 'ask',
      description: 'Run a VS Code command by its id (e.g. workbench.action.files.saveAll, editor.action.organizeImports, git.stageAll, testing.runAll, workbench.action.reloadWindow) with optional arguments, ' +
        'and get what it returns. list: a filter, to list the command ids there are (e.g. "test" or "git."). The user approves each command.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, args: { type: 'array', items: {}, description: 'Arguments for the command' }, list: { type: 'string', description: 'List command ids containing this text instead of running one' } } } },
    { name: 'fetch_url', 'x-risk': 'read',
      description: 'Fetch a web address from the user\'s computer: it reaches localhost (a dev server you started), the LAN and the intranet, which the Agentic server cannot. ' +
        'A page comes back as text, JSON as it is, a picture as a picture. GET by default; method and body for an API.',
      parameters: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE'] }, body: { type: 'string' }, headers: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['url'] } },
    { name: 'ide_run', 'x-risk': 'change',
      description: 'The workspace\'s tasks and debugger: action "tasks" (list tasks.json and detected tasks), "run_task" (run the task named name and wait for its exit code, up to wait_seconds), ' +
        '"debug" (start the launch.json configuration named name, or the first), "debug_output" (what the debug console printed, and the sessions running), "stop_debug".',
      parameters: { type: 'object', properties: { action: { type: 'string', enum: ['tasks', 'run_task', 'debug', 'debug_output', 'stop_debug'] }, name: { type: 'string' }, wait_seconds: { type: 'integer' } }, required: ['action'] } }
  ];
}

export class IdeTools {
  /** vscode_tool__x → the tool's own name, from the last listing. */
  private readonly lmNames = new Map<string, string>();
  /** What each debug session printed (the debug console), newest last. */
  private readonly debugOut: string[] = [];

  constructor(private readonly resolve: (p: string) => string, private readonly roots: () => string[],
    private readonly lmMode: () => string, private readonly skipLmMcp: () => boolean) {
    // The debug console's output, for debug_output.
    try {
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: session => ({
          onDidSendMessage: (m: any) => {
            if (m && m.type === 'event' && m.event === 'output' && m.body && m.body.category !== 'telemetry') {
              this.debugOut.push(`[${session.name}] ${String(m.body.output || '')}`.replace(/\s+$/, ''));
              if (this.debugOut.length > 2000) this.debugOut.splice(0, this.debugOut.length - 2000);
            }
          },
          onExit: (code: number | undefined) => { this.debugOut.push(`[${session.name}] exited${code !== undefined ? ' with code ' + code : ''}`); }
        })
      });
    } catch { /* tests or old VS Code */ }
  }

  // -------------------------------------------------------------- other extensions' tools (vscode.lm.tools)

  /** off | others (default: not Copilot's own file/terminal tools, which these tools already do, nor VS Code's MCP servers this app runs itself) | all */
  lmDefinitions(): ToolDefinition[] {
    const mode = this.lmMode();
    const lm: any = (vscode as any).lm;
    if (mode === 'off' || !lm || !Array.isArray(lm.tools)) return [];
    this.lmNames.clear();
    const list: ToolDefinition[] = [];
    for (const t of lm.tools as any[]) {
      const tags: string[] = Array.isArray(t.tags) ? t.tags.map(String) : [];
      const isMcp = /^mcp_/i.test(t.name) || tags.some(x => /mcp/i.test(x));
      if (mode !== 'all' && (/^(copilot_|vscode_|github\.copilot)/i.test(t.name) || (isMcp && this.skipLmMcp()))) continue;
      const name = (LM_PREFIX + t.name).replace(/[^\w-]/g, '_').slice(0, 64);
      if (this.lmNames.has(name)) continue;
      this.lmNames.set(name, t.name);
      const schema = t.inputSchema && typeof t.inputSchema === 'object' ? { ...t.inputSchema } : { type: 'object', properties: {} };
      delete (schema as any).$schema;
      list.push({ name, 'x-risk': 'change', description: `[VS Code tool${tags.length ? ' · ' + tags.slice(0, 3).join(', ') : ''}] ${String(t.description || '').slice(0, 1200)}`, parameters: schema as Record<string, unknown> });
      if (list.length >= 40) break;
    }
    return list;
  }

  owns(name: string): boolean { return name.startsWith(LM_PREFIX) || IDE_TOOLS.includes(name); }

  async run(name: string, a: Record<string, any>): Promise<Result> {
    try {
      if (name.startsWith(LM_PREFIX)) return await this.invokeLm(name, a);
      switch (name) {
        case 'ide_navigate': return await this.navigate(a);
        case 'ide_refactor': return await this.refactor(a);
        case 'vscode_command': return await this.command(a);
        case 'ide_run': return await this.runOrDebug(a);
        case 'fetch_url': return await fetchUrl(a);
      }
      return fail('Unknown tool ' + name);
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  }

  private async invokeLm(name: string, a: Record<string, any>): Promise<Result> {
    const lm: any = (vscode as any).lm;
    if (!this.lmNames.size) this.lmDefinitions();
    const real = this.lmNames.get(name);
    if (!lm || !real) return fail('That VS Code tool is not available now.');
    const cts = new vscode.CancellationTokenSource();
    const timer = setTimeout(() => cts.cancel(), 600_000);
    try {
      const r = await lm.invokeTool(real, { input: a, toolInvocationToken: undefined }, cts.token);
      const text: string[] = [], images: { mediaType: string; data: string }[] = [];
      for (const p of (r && Array.isArray(r.content) ? r.content : [])) {
        if (p && typeof p.value === 'string') text.push(p.value);
        else if (p && p.mimeType && p.data && /^image\//.test(p.mimeType)) images.push({ mediaType: p.mimeType, data: Buffer.from(p.data).toString('base64') });
        else if (p && p.value !== undefined) text.push(JSON.stringify(p.value));
      }
      return { ok: true, result: text.join('\n') || '(no output)', ...(images.length ? { images } : {}) };
    } finally { clearTimeout(timer); cts.dispose(); }
  }

  // -------------------------------------------------------------- navigation

  private async document(p: string): Promise<vscode.TextDocument> {
    if (!p) throw new Error('path is required.');
    return vscode.workspace.openTextDocument(vscode.Uri.file(this.resolve(p)));
  }

  /** The position a call names: line (1-based), then the symbol on it, else column, else its first word. */
  private position(doc: vscode.TextDocument, a: Record<string, any>): vscode.Position {
    const line = Math.min(Math.max(1, Number(a.line) || 1), doc.lineCount) - 1;
    const text = doc.lineAt(line).text;
    if (a.symbol) {
      const re = new RegExp(`(^|[^\\w$])(${String(a.symbol).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\w$])`);
      const m = re.exec(text);
      const i = m ? m.index + m[1].length : text.indexOf(String(a.symbol));
      if (i < 0) throw new Error(`"${a.symbol}" is not on line ${line + 1} of ${a.path}: ${text.trim().slice(0, 160)}`);
      return new vscode.Position(line, i + Math.floor(String(a.symbol).length / 2));
    }
    if (a.column) return new vscode.Position(line, Math.max(0, Number(a.column) - 1));
    const w = /\w/.exec(text);
    return new vscode.Position(line, w ? w.index : 0);
  }

  private where(uri: vscode.Uri, range: vscode.Range): string {
    const rel = vscode.workspace.asRelativePath(uri, this.roots().length > 1);
    return `${rel}:${range.start.line + 1}:${range.start.character + 1}`;
  }

  private async lineOf(uri: vscode.Uri, line: number): Promise<string> {
    try { const d = await vscode.workspace.openTextDocument(uri); return d.lineAt(line).text.trim().slice(0, 200); } catch { return ''; }
  }

  private async navigate(a: Record<string, any>): Promise<Result> {
    const action = String(a.action || '');
    if (action === 'symbols') {
      if (a.path) {
        const doc = await this.document(a.path);
        const syms = (await vscode.commands.executeCommand<any[]>('vscode.executeDocumentSymbolProvider', doc.uri)) || [];
        const out: string[] = [];
        const walk = (list: any[], depth: number) => {
          for (const s of list) {
            const r: vscode.Range = s.range || (s.location && s.location.range);
            out.push(`${'  '.repeat(depth)}${vscode.SymbolKind[s.kind] || 'Symbol'} ${s.name}${s.detail ? ' ' + s.detail : ''}  (line ${r ? r.start.line + 1 : '?'})`);
            if (Array.isArray(s.children) && out.length < 400) walk(s.children, depth + 1);
          }
        };
        walk(syms, 0);
        return ok(out.length ? out.join('\n') : 'No symbols (no language server for this file, or it is still starting).');
      }
      const found = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', String(a.query || ''))) || [];
      return ok(found.length ? found.slice(0, 100).map(s => `${vscode.SymbolKind[s.kind]} ${s.name}${s.containerName ? ' in ' + s.containerName : ''} — ${this.where(s.location.uri, s.location.range)}`).join('\n')
        : 'No symbols found' + (a.query ? ` for "${a.query}"` : '') + '.');
    }
    const doc = await this.document(a.path);
    const pos = this.position(doc, a);
    if (action === 'hover') {
      const hovers = (await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', doc.uri, pos)) || [];
      const text = hovers.flatMap(h => h.contents.map(c => typeof c === 'string' ? c : (c as any).value || '')).filter(Boolean).join('\n\n');
      return ok(text || 'Nothing to show there.');
    }
    const cmd = action === 'definition' ? 'vscode.executeDefinitionProvider' : action === 'references' ? 'vscode.executeReferenceProvider'
      : action === 'implementations' ? 'vscode.executeImplementationProvider' : '';
    if (!cmd) return fail('Unknown action ' + action);
    const locs = ((await vscode.commands.executeCommand<any[]>(cmd, doc.uri, pos)) || []).map(l => l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange || l.targetRange } : l);
    if (!locs.length) return ok(`No ${action} found at ${a.path}:${pos.line + 1} (is a language server running for it?).`);
    const lines: string[] = [];
    for (const l of locs.slice(0, 150)) lines.push(`${this.where(l.uri, l.range)}  ${await this.lineOf(l.uri, l.range.start.line)}`);
    return ok(`${locs.length} ${action === 'references' ? 'reference' + (locs.length === 1 ? '' : 's') : action}:\n` + lines.join('\n') + (locs.length > 150 ? `\n… and ${locs.length - 150} more` : ''));
  }

  // -------------------------------------------------------------- refactoring

  private describeEdit(edit: vscode.WorkspaceEdit): string {
    const files = edit.entries().map(([uri, edits]) => `${vscode.workspace.asRelativePath(uri)} (${edits.length} change${edits.length === 1 ? '' : 's'})`);
    return files.length ? files.join(', ') : 'no files';
  }

  private async refactor(a: Record<string, any>): Promise<Result> {
    const doc = await this.document(a.path);
    switch (String(a.action || '')) {
      case 'rename': {
        if (!a.new_name) return fail('new_name is required.');
        const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', doc.uri, this.position(doc, a), String(a.new_name));
        if (!edit || !edit.size) return fail('Nothing can be renamed there (put symbol on the name, and check a language server runs for this file).');
        if (!await vscode.workspace.applyEdit(edit)) return fail('VS Code did not apply the rename.');
        return ok(`Renamed to ${a.new_name} in ${this.describeEdit(edit)}. The files are changed in the editor (unsaved until saved; Ctrl+Z undoes it).`);
      }
      case 'format': {
        const opts = { tabSize: 2, insertSpaces: true, ...(vscode.window.activeTextEditor ? vscode.window.activeTextEditor.options : {}) };
        const edits = (await vscode.commands.executeCommand<vscode.TextEdit[]>('vscode.executeFormatDocumentProvider', doc.uri, opts)) || [];
        if (!edits.length) return ok('Already formatted (or no formatter for this file).');
        const we = new vscode.WorkspaceEdit();
        we.set(doc.uri, edits);
        await vscode.workspace.applyEdit(we);
        return ok(`Formatted ${a.path} (${edits.length} change${edits.length === 1 ? '' : 's'}).`);
      }
      case 'code_actions':
      case 'apply': {
        const pos = this.position(doc, a);
        const range = new vscode.Range(pos.line, 0, pos.line, doc.lineAt(pos.line).text.length);
        const actions = (await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>('vscode.executeCodeActionProvider', doc.uri, range)) || [];
        if (a.action === 'code_actions') {
          return ok(actions.length ? actions.map(x => `- ${x.title}${(x as vscode.CodeAction).kind ? ' (' + (x as vscode.CodeAction).kind!.value + ')' : ''}`).join('\n') : `No quick fixes or refactorings at ${a.path}:${pos.line + 1}.`);
        }
        const pick = actions.find(x => x.title === a.title) || actions.find(x => x.title.toLowerCase().includes(String(a.title || '').toLowerCase()));
        if (!pick) return fail(`No code action titled "${a.title}" there. Offered: ${actions.map(x => x.title).join('; ') || 'none'}`);
        const ca = pick as vscode.CodeAction;
        if (ca.edit) await vscode.workspace.applyEdit(ca.edit);
        const command = 'command' in pick && typeof (pick as vscode.Command).command === 'string' ? pick as vscode.Command : ca.command;
        if (command) await vscode.commands.executeCommand(command.command, ...(command.arguments || []));
        return ok(`Applied "${pick.title}"${ca.edit ? ' to ' + this.describeEdit(ca.edit) : ''}.`);
      }
    }
    return fail('Unknown action ' + a.action);
  }

  // -------------------------------------------------------------- commands, tasks, debugging

  private async command(a: Record<string, any>): Promise<Result> {
    if (a.list !== undefined && !a.command) {
      const q = String(a.list || '').toLowerCase();
      const all = (await vscode.commands.getCommands(true)).filter(c => !q || c.toLowerCase().includes(q)).sort();
      return ok(all.length ? all.slice(0, 300).join('\n') + (all.length > 300 ? `\n… ${all.length - 300} more (narrow the filter)` : '') : 'No commands match.');
    }
    if (!a.command) return fail('command is required (or list to see the ids).');
    const r = await vscode.commands.executeCommand(String(a.command), ...(Array.isArray(a.args) ? a.args : []));
    let text: string;
    try { text = r === undefined ? '(done; the command returned nothing)' : typeof r === 'string' ? r : JSON.stringify(r, (_k, v) => v instanceof vscode.Uri ? v.fsPath : v, 2); } catch { text = String(r); }
    return ok(text.length > 40000 ? text.slice(0, 40000) + '\n… (shortened)' : text);
  }

  private async runOrDebug(a: Record<string, any>): Promise<Result> {
    switch (String(a.action || '')) {
      case 'tasks': {
        const tasks = await vscode.tasks.fetchTasks();
        return ok(tasks.length ? tasks.map(t => `- ${t.name}${t.source && t.source !== 'Workspace' ? ` (${t.source})` : ''}${t.group ? ' [' + t.group.id + ']' : ''}`).join('\n') : 'No tasks (tasks.json, npm scripts and other detected tasks).');
      }
      case 'run_task': {
        const tasks = await vscode.tasks.fetchTasks();
        const t = tasks.find(x => x.name === a.name) || tasks.find(x => x.name.toLowerCase().includes(String(a.name || '').toLowerCase()));
        if (!t) return fail(`No task named "${a.name}". Tasks: ${tasks.map(x => x.name).join(', ') || 'none'}`);
        const wait = Math.min(Math.max(Number(a.wait_seconds) || 300, 1), 3600) * 1000;
        const exec = await vscode.tasks.executeTask(t);
        const code = await new Promise<number | undefined | 'running'>(resolve => {
          const timer = setTimeout(() => { sub.dispose(); resolve('running'); }, wait);
          const sub = vscode.tasks.onDidEndTaskProcess(e => { if (e.execution === exec) { clearTimeout(timer); sub.dispose(); resolve(e.exitCode); } });
        });
        return code === 'running' ? ok(`Task "${t.name}" is still running after ${wait / 1000} s (its output is in its terminal).`)
          : { ok: code === 0 || code === undefined, result: `Task "${t.name}" ended${code !== undefined ? ' with exit code ' + code : ''}. Its output is in the terminal panel; run the same command with run_command to read it.` };
      }
      case 'debug': {
        const folder = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders[0] : undefined;
        const configs: any[] = vscode.workspace.getConfiguration('launch', folder ? folder.uri : undefined).get('configurations') || [];
        const name = a.name ? String(a.name) : configs[0] && configs[0].name;
        if (!name) return fail('No launch.json configurations. Write .vscode/launch.json first (or give a task to run).');
        this.debugOut.length = 0;
        const started = await vscode.debug.startDebugging(folder, name);
        return started ? ok(`Debugging "${name}". debug_output shows what it prints; stop_debug ends it.`) : fail(`VS Code did not start "${name}". Configurations: ${configs.map(c => c.name).join(', ')}`);
      }
      case 'debug_output': {
        const s = vscode.debug.activeDebugSession;
        return ok(`${s ? 'Running: ' + s.name : 'No debug session is running.'}\n` + (this.debugOut.length ? this.debugOut.slice(-300).join('\n') : '(no output yet)'));
      }
      case 'stop_debug':
        await vscode.debug.stopDebugging();
        return ok('Stopped debugging.');
    }
    return fail('Unknown action ' + a.action);
  }
}

/** For the instructions: what the IDE tools add. */
export const IDE_NOTE = '\nIn VS Code you also have ide_navigate (definitions, references, symbols, types from the language servers: more exact than grep), ' +
  'ide_refactor (rename everywhere, quick fixes, format), ide_run (tasks and the debugger) and vscode_command (any VS Code command, approved by the user).\n';
