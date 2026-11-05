/**
 * Claude Code (the claude CLI) on this computer, answering in the chat (like the desktop app). Each message runs
 * "claude -p" in its streaming JSON mode and continues the chat's Claude session (--resume), so Claude keeps its own memory
 * of the conversation, its tools, MCP servers, skills, slash commands, CLAUDE.md files and settings. Its events go to the
 * page unchanged; permission prompts (control_request can_use_tool) are answered by the page through respond().
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

interface Run { proc: ChildProcess; done: boolean }

const exeName = process.platform === 'win32' ? 'claude.exe' : 'claude';

function onPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

/** The claude program: on PATH, the native installer's folder, or the copy inside the Claude Code extension. */
export function findClaude(): { path: string | null; source: string | null } {
  const p = onPath('claude');
  if (p) return { path: p, source: 'PATH' };
  const home = os.homedir();
  for (const c of [path.join(home, '.local', 'bin', exeName), path.join(home, '.claude', 'local', exeName)]) if (fs.existsSync(c)) return { path: c, source: 'native installer' };
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const bin = path.join(ext.extensionPath, 'resources', 'native-binary', exeName);
    if (fs.existsSync(bin)) return { path: bin, source: 'Claude Code extension' };
  }
  for (const root of [path.join(home, '.vscode', 'extensions'), path.join(home, '.cursor', 'extensions')]) {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(root).filter(d => d.startsWith('anthropic.claude-code-')).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      const bin = path.join(root, d, 'resources', 'native-binary', exeName);
      if (fs.existsSync(bin)) return { path: bin, source: 'Claude Code extension' };
    }
  }
  return { path: null, source: null };
}

/** How to start it: an npm .cmd shim runs through its cli.js with node (cmd.exe would mangle the arguments). */
function command(exe: string): { file: string; pre: string[] } {
  if (/\.(cmd|bat)$/i.test(exe)) {
    const dir = path.dirname(exe), pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    const bin = path.join(pkg, 'bin', 'claude.exe'), cli = path.join(pkg, 'cli.js');
    if (fs.existsSync(bin)) return { file: bin, pre: [] };
    if (fs.existsSync(cli)) return { file: onPath('node') || 'node', pre: [cli] };
    return { file: 'cmd.exe', pre: ['/d', '/s', '/c', exe] };
  }
  return { file: exe, pre: [] };
}

export async function claudeStatus(): Promise<Record<string, unknown>> {
  const found = findClaude();
  if (!found.path) return { installed: false };
  const c = command(found.path);
  const version = await new Promise<string | null>(resolve => {
    let out = '';
    const p = spawn(c.file, [...c.pre, '--version'], { windowsHide: true });
    const timer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve(null); }, 15000);
    p.stdout?.on('data', b => { out += b; });
    p.on('close', () => { clearTimeout(timer); resolve(out.trim() || null); });
    p.on('error', () => { clearTimeout(timer); resolve(null); });
  });
  return { installed: true, path: found.path, source: found.source, version };
}

const str = (o: any, k: string): string | undefined => o && (typeof o[k] === 'string' ? o[k] : typeof o[k] === 'number' || typeof o[k] === 'boolean' ? String(o[k]) : undefined);
const list = (o: any, k: string): string[] => {
  const v = o && o[k];
  if (typeof v === 'string') return v.split(/[,\n]/).map(x => x.trim()).filter(Boolean);
  return Array.isArray(v) ? v.filter(x => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean).slice(0, 100) : [];
};
/** The line that ends an answer: {"type":"result", …}. */
function isResult(line: string): boolean {
  if (!line.includes('"result"')) return false;
  try { const o = JSON.parse(line); return !!o && o.type === 'result'; } catch { return false; }
}

export class ClaudeCode {
  private readonly runs = new Map<string, Run>();

  /**
   * Runs one message. body: {runId, prompt, images: [{mediaType, data}], files: [{name, data}], sessionId, plan, settings:
   * {model, permissionMode, effort, cwd, addDirs, appendSystemPrompt, maxTurns, fallbackModel, allowedTools,
   * disallowedTools, maxBudgetUsd}}. Each line Claude prints goes to onLine; it resolves when Claude exits.
   */
  async run(body: any, defaultFolder: string, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
    const found = findClaude();
    if (!found.path) throw new Error('Claude Code is not installed on this computer (the claude command was not found).');
    const runId = str(body, 'runId') || Math.random().toString(36).slice(2);
    const s = body && typeof body.settings === 'object' && body.settings ? body.settings : null;
    let cwd = s && str(s, 'cwd');
    if (!cwd || !fs.existsSync(cwd)) cwd = defaultFolder || os.homedir();
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];
    const session = str(body, 'sessionId');
    if (session && /^[0-9a-f-]{36}$/i.test(session)) args.push('--resume', session);
    const plan = !!(body && body.plan === true);
    if (s) {
      const model = str(s, 'model'); if (model && model !== 'default') args.push('--model', model);
      const mode = plan ? 'plan' : str(s, 'permissionMode'); if (mode && mode !== 'default') args.push('--permission-mode', mode);
      const effort = str(s, 'effort'); if (effort && effort !== 'default') args.push('--effort', effort);
      for (const d of list(s, 'addDirs').filter(d => fs.existsSync(d))) args.push('--add-dir', d);
      const append = str(s, 'appendSystemPrompt'); if (append && append.trim()) args.push('--append-system-prompt', append);
      const turns = parseInt(str(s, 'maxTurns') || '', 10); if (turns > 0) args.push('--max-turns', String(turns));
      const fallback = str(s, 'fallbackModel'); if (fallback && fallback.trim()) args.push('--fallback-model', fallback);
      const budget = parseFloat(str(s, 'maxBudgetUsd') || ''); if (budget > 0) args.push('--max-budget-usd', String(budget));
      const allowed = list(s, 'allowedTools'); if (allowed.length) args.push('--allowedTools', allowed.join(','));
      const denied = list(s, 'disallowedTools'); if (denied.length) args.push('--disallowedTools', denied.join(','));
    } else if (plan) args.push('--permission-mode', 'plan');

    // The message: text, pictures, and attached files saved where Claude can read them.
    let prompt = str(body, 'prompt') || '';
    const files = Array.isArray(body && body.files) ? body.files.slice(0, 10) : [];
    if (files.length) {
      const dir = path.join(os.tmpdir(), 'agentic-claude', runId.replace(/[^\w-]/g, ''));
      fs.mkdirSync(dir, { recursive: true });
      const saved: string[] = [];
      for (const f of files) {
        const target = path.join(dir, path.basename(String(f && f.name || 'file')) || 'file');
        fs.writeFileSync(target, Buffer.from(String(f && f.data || ''), 'base64'));
        saved.push(target);
      }
      prompt += '\n\nAttached files (saved on this computer):\n' + saved.map(x => '- ' + x).join('\n');
    }
    const content: unknown[] = [];
    for (const img of (Array.isArray(body && body.images) ? body.images.slice(0, 10) : [])) {
      content.push({ type: 'image', source: { type: 'base64', media_type: String(img && img.mediaType || 'image/png'), data: String(img && img.data || '') } });
    }
    content.push({ type: 'text', text: prompt });

    const c = command(found.path);
    const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'agentic-vscode' };
    delete env.CLAUDECODE;   // started from inside another Claude Code session, claude would refuse to run
    delete env.ELECTRON_RUN_AS_NODE;
    const proc = spawn(c.file, [...c.pre, ...args], { cwd, windowsHide: true, env });
    const run: Run = { proc, done: false };
    this.runs.set(runId, run);
    let stderr = '';
    proc.stderr?.on('data', b => { if (stderr.length < 20000) stderr += b; });
    const kill = () => { try { if (proc.exitCode === null) proc.kill(); } catch { /* gone */ } };
    signal.addEventListener('abort', kill);
    try {
      await new Promise<void>((resolve, reject) => {
        proc.on('error', e => reject(new Error('Could not start Claude Code: ' + e.message)));
        proc.on('spawn', () => resolve());
      });
      proc.stdin?.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
      onLine(JSON.stringify({ type: 'agentic_started', runId, cwd, source: found.source }));
      let buf = '';
      await new Promise<void>(resolve => {
        proc.stdout?.on('data', (b: Buffer) => {
          buf += b.toString('utf8');
          let cut;
          while ((cut = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, cut).replace(/\r$/, ''); buf = buf.slice(cut + 1);
            if (!line) continue;
            onLine(line);
            // The answer is complete: close stdin so claude exits (it waits for more messages otherwise).
            if (isResult(line)) { run.done = true; try { proc.stdin?.end(); } catch { /* closed */ } }
          }
        });
        proc.on('close', () => resolve());
      });
      if (!run.done) {
        const err = stderr.trim();
        onLine(JSON.stringify({ type: 'agentic_error', exitCode: proc.exitCode, message: err ? err.slice(-3000) : `Claude Code stopped (exit code ${proc.exitCode}).` }));
      }
    } finally {
      signal.removeEventListener('abort', kill);
      kill();
      this.runs.delete(runId);
    }
  }

  /** The page answers a control request (a permission prompt): {runId, requestId, response}. */
  respond(body: any): boolean {
    const r = this.runs.get(String(body && body.runId || ''));
    if (!r || !r.proc.stdin || r.proc.stdin.destroyed) return false;
    r.proc.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: String(body.requestId || ''), response: body.response || {} } }) + '\n');
    return true;
  }

  /** Stops the answer: Claude is asked to interrupt (it ends the turn cleanly), and stopped hard if it does not. */
  interrupt(runId: string): boolean {
    const r = this.runs.get(String(runId || ''));
    if (!r) return false;
    try { r.proc.stdin?.write(JSON.stringify({ type: 'control_request', request_id: 'int_' + Math.random().toString(36).slice(2), request: { subtype: 'interrupt' } }) + '\n'); } catch { /* closed */ }
    setTimeout(() => { try { if (r.proc.exitCode === null) r.proc.kill(); } catch { /* gone */ } }, 5000);
    return true;
  }
}
