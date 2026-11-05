/**
 * The IDE bridge for the Agentic CLI (/ide), like Claude Code's IDE integration: the CLI running in a terminal of this
 * workspace finds this VS Code through a lock file (~/.agentic/ide/<port>.lock: port, token, workspace folders, pid) and
 * asks it, on 127.0.0.1 with the token:
 *   GET  /state          the workspace folders, the file in the editor and the selected lines (with their text)
 *   GET  /diagnostics    problems VS Code reports (?path= one file), errors and warnings first
 *   POST /open           opens {path, line} in the editor
 *   POST /diff           shows {path, content} as a diff to accept or reject (single changes can be reverted in it):
 *                        {accepted, content} - the content as the user left it; the CLI writes the file
 */
import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';

export type Review = (full: string, before: string, after: string, existed: boolean) => Promise<boolean | string>;

export function ideLockDir(): string { return process.env.AGENTIC_IDE_DIR || path.join(os.homedir(), '.agentic', 'ide'); }

export class IdeServer implements vscode.Disposable {
  private server?: http.Server;
  private readonly token = crypto.randomBytes(24).toString('hex');
  private lockFile = '';
  private lastEditor: vscode.TextEditor | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(private readonly roots: () => string[], private readonly version: string, private readonly review: Review, private readonly log: (s: string) => void) {
    this.lastEditor = vscode.window.activeTextEditor;
    this.subs.push(vscode.window.onDidChangeActiveTextEditor(e => { if (e && e.document.uri.scheme === 'file') this.lastEditor = e; }));
    this.subs.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.writeLock()));
  }

  /** The editor the user works in (the last file editor that had focus: the CLI's terminal has it now). */
  editor(): vscode.TextEditor | undefined {
    const a = vscode.window.activeTextEditor;
    if (a && a.document.uri.scheme === 'file') return a;
    if (this.lastEditor && vscode.window.visibleTextEditors.includes(this.lastEditor)) return this.lastEditor;
    return vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
  }

  async start(): Promise<void> {
    if (this.server) return;
    const srv = http.createServer((req, res) => { void this.handle(req, res); });
    await new Promise<void>((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', () => resolve()); });
    this.server = srv;
    this.writeLock();
    this.log(`IDE bridge for the CLI on 127.0.0.1:${(srv.address() as AddressInfo).port}`);
  }

  private writeLock(): void {
    if (!this.server) return;
    const port = (this.server.address() as AddressInfo).port;
    try {
      fs.mkdirSync(ideLockDir(), { recursive: true });
      this.lockFile = path.join(ideLockDir(), `${port}.lock`);
      fs.writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, port, token: this.token, ideName: 'VS Code', version: this.version,
        workspaceFolders: this.roots(), startedUtc: new Date().toISOString() }, null, 2), { mode: 0o600 });
    } catch (e: any) { this.log('IDE bridge: could not write its lock file: ' + (e && e.message || e)); }
  }

  private send(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  private resolve(p: string): string {
    const roots = this.roots();
    return path.isAbsolute(p) ? path.normalize(p) : path.resolve(roots[0] || process.cwd(), p);
  }

  private async body(req: http.IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > 20 * 1024 * 1024) throw new Error('Too large.'); chunks.push(c as Buffer); }
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      // Only this computer's processes that read the lock file (it holds the token) may ask.
      const auth = String(req.headers.authorization || '');
      const given = Buffer.from(auth.replace(/^Bearer\s+/i, ''));
      const want = Buffer.from(this.token);
      if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) { this.send(res, 401, { error: 'unauthorized' }); return; }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /state') { this.send(res, 200, this.state()); return; }
      if (route === 'GET /diagnostics') { this.send(res, 200, this.diagnostics(url.searchParams.get('path') || '')); return; }
      if (route === 'POST /open') {
        const b = await this.body(req);
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.resolve(String(b.path || ''))));
        const line = Math.max(0, (Number(b.line) || 1) - 1);
        const ed = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: !!b.preserveFocus });
        const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
        ed.selection = new vscode.Selection(pos, pos);
        ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.send(res, 200, { ok: true });
        return;
      }
      if (route === 'POST /diff') {
        const b = await this.body(req);
        const full = this.resolve(String(b.path || ''));
        const existed = fs.existsSync(full);
        const before = existed ? (await vscode.workspace.openTextDocument(vscode.Uri.file(full))).getText() : '';
        const after = String(b.content ?? '');
        const verdict = await this.review(full, before, after, existed);
        this.send(res, 200, { accepted: verdict !== false, content: typeof verdict === 'string' ? verdict : verdict === true ? after : null });
        return;
      }
      this.send(res, 404, { error: 'not found' });
    } catch (e: any) {
      this.send(res, 500, { error: e && e.message ? e.message : String(e) });
    }
  }

  state(): unknown {
    const ed = this.editor();
    let selection: unknown = null, activeFile: string | null = null;
    if (ed) {
      activeFile = ed.document.uri.fsPath;
      const s = ed.selection;
      if (!s.isEmpty) {
        const text = ed.document.getText(s);
        selection = { path: activeFile, startLine: s.start.line + 1, endLine: s.end.line + 1, text: text.length > 20000 ? text.slice(0, 20000) : text };
      }
    }
    const open = vscode.workspace.textDocuments.filter(d => d.uri.scheme === 'file' && !d.isClosed).map(d => d.uri.fsPath).slice(0, 50);
    return { ideName: 'VS Code', version: this.version, workspaceFolders: this.roots(), activeFile, language: ed ? ed.document.languageId : null, selection, openFiles: open };
  }

  diagnostics(p: string): unknown {
    const pick = p ? [[vscode.Uri.file(this.resolve(p)), vscode.languages.getDiagnostics(vscode.Uri.file(this.resolve(p)))] as [vscode.Uri, vscode.Diagnostic[]]] : vscode.languages.getDiagnostics();
    const out: { path: string; line: number; column: number; severity: string; message: string; source: string }[] = [];
    const sev = ['error', 'warning', 'info', 'hint'];
    for (const [uri, list] of pick) {
      if (uri.scheme !== 'file') continue;
      for (const d of list) out.push({ path: uri.fsPath, line: d.range.start.line + 1, column: d.range.start.character + 1, severity: sev[d.severity] || 'info', message: d.message, source: d.source || '' });
    }
    out.sort((a, b) => sev.indexOf(a.severity) - sev.indexOf(b.severity));
    return out.slice(0, 300);
  }

  dispose(): void {
    this.subs.forEach(s => s.dispose());
    try { if (this.lockFile) fs.unlinkSync(this.lockFile); } catch { /* gone */ }
    this.server?.close();
    this.server = undefined;
  }
}
