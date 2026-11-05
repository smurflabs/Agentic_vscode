/**
 * Code checkpoints for Rewind (like Claude Code's): before a tool changes a file for the first time in an answer, its
 * text is saved under the question that started that answer. Rewinding to a question puts back every file changed from
 * then on (through VS Code, so the change can be undone; a file that did not exist then is deleted). Changes made by
 * shell commands are not tracked. Kept in the extension's storage folder; chats untouched for 30 days are removed.
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'crypto';

interface SavedFile { path: string; existed: boolean; backup?: string }
interface Turn { messageId: string; timeUtc: string; files: SavedFile[] }

const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class Checkpoints {
  private readonly current = new Map<string, string>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastCleanup = 0;

  constructor(private readonly root: string) { }

  /** An answer to this question starts (or continues): file changes from now on are filed under it. */
  beginTurn(chatId: string, messageId: string): void {
    if (!chatId || !messageId) return;
    this.current.set(chatId, messageId);
    void this.cleanup();
  }

  /** Saves the file's current text, if this answer has not changed it yet. */
  beforeChange(chatId: string | undefined, full: string): Promise<void> {
    if (!chatId) return Promise.resolve();
    const messageId = this.current.get(chatId);
    if (!messageId) return Promise.resolve();
    return this.serial(async () => {
      const turns = await this.load(chatId);
      let turn = turns.find(t => t.messageId === messageId);
      if (!turn) { turn = { messageId, timeUtc: new Date().toISOString(), files: [] }; turns.push(turn); }
      if (turn.files.some(f => same(f.path, full))) return;
      const stat = await fs.stat(full).catch(() => null);
      const saved: SavedFile = { path: full, existed: !!(stat && stat.isFile()) };
      if (saved.existed) {
        if (stat!.size > MAX_FILE_BYTES) return;
        // The editor's text (it may hold changes not saved yet), else the file on disk.
        const open = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && same(d.uri.fsPath, full));
        const text = open ? Buffer.from(open.getText(), 'utf8') : await fs.readFile(full);
        const dir = path.join(this.chatDir(chatId), 'files');
        await fs.mkdir(dir, { recursive: true });
        saved.backup = path.join(dir, randomUUID());
        await fs.writeFile(saved.backup, text);
      }
      turn.files.push(saved);
      await this.save(chatId, turns);
    });
  }

  /** Each question's changed files. */
  async list(chatId: string): Promise<{ messageId: string; timeUtc: string; files: string[] }[]> {
    const turns = await this.load(chatId);
    return turns.map(t => ({ messageId: t.messageId, timeUtc: t.timeUtc, files: t.files.map(f => f.path) }));
  }

  /** Puts back every file changed in the answers to these questions, to how it was before the earliest of them. */
  restore(chatId: string, messageIds: string[]): Promise<{ restored: string[]; failed: { path: string; error: string }[] }> {
    return this.serial(async () => {
      const ids = new Set(messageIds || []);
      const turns = await this.load(chatId);
      const chosen = turns.filter(t => ids.has(t.messageId)).sort((a, b) => a.timeUtc.localeCompare(b.timeUtc));
      const done = new Set<string>(), restored: string[] = [], failed: { path: string; error: string }[] = [];
      for (const t of chosen) {
        for (const f of t.files) {
          const key = f.path.toLowerCase();
          if (done.has(key)) continue;   // the earliest saved state wins
          done.add(key);
          try {
            const uri = vscode.Uri.file(f.path);
            if (f.existed && f.backup) {
              const text = (await fs.readFile(f.backup)).toString('utf8');
              const exists = await fs.stat(f.path).then(s => s.isFile(), () => false);
              if (exists) {
                const doc = await vscode.workspace.openTextDocument(uri);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
                if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code did not apply the change');
                await doc.save();
              } else {
                await fs.mkdir(path.dirname(f.path), { recursive: true });
                await fs.writeFile(f.path, text, 'utf8');
              }
            } else if (await fs.stat(f.path).then(() => true, () => false)) {
              await vscode.workspace.fs.delete(uri, { useTrash: true });
            }
            restored.push(f.path);
          } catch (e) { failed.push({ path: f.path, error: e instanceof Error ? e.message : String(e) }); }
        }
      }
      const left = turns.filter(t => !chosen.includes(t));
      for (const t of chosen) for (const f of t.files) if (f.backup) await fs.rm(f.backup, { force: true }).catch(() => { });
      await this.save(chatId, left);
      return { restored, failed };
    });
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => { });
    return next;
  }
  private chatDir(chatId: string): string { return path.join(this.root, chatId.replace(/[^\w-]/g, '_')); }
  private async load(chatId: string): Promise<Turn[]> {
    try { return JSON.parse(await fs.readFile(path.join(this.chatDir(chatId), 'index.json'), 'utf8')) as Turn[]; } catch { return []; }
  }
  private async save(chatId: string, turns: Turn[]): Promise<void> {
    await fs.mkdir(this.chatDir(chatId), { recursive: true });
    await fs.writeFile(path.join(this.chatDir(chatId), 'index.json'), JSON.stringify(turns));
  }
  /** Chats whose checkpoints were not touched for 30 days are removed (at most once an hour). */
  private async cleanup(): Promise<void> {
    if (Date.now() - this.lastCleanup < 3600_000) return;
    this.lastCleanup = Date.now();
    try {
      for (const d of await fs.readdir(this.root)) {
        const p = path.join(this.root, d);
        const s = await fs.stat(p).catch(() => null);
        if (s && s.isDirectory() && Date.now() - s.mtimeMs > 30 * 86400_000) await fs.rm(p, { recursive: true, force: true });
      }
    } catch { /* the folder may not exist yet */ }
  }
}

function same(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
