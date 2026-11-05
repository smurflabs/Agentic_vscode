/**
 * Claude Code-style extras for the VS Code tools, in the same files the Agentic CLI (and Claude Code) use:
 *  - background commands: long-running commands (dev servers, watchers) keep running; their output is read later
 *  - hooks: commands that run before / after tools and when an answer ends ("hooks" in ~/.agentic/settings.json,
 *    <project>/.agentic/settings.json, settings.local.json and .claude/settings*.json)
 *  - (local MCP servers are in mcp.ts)
 *  - skills and custom slash commands: .agentic/ and .claude/ skills/<name>/SKILL.md and commands/<name>.md
 */
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync, ChildProcess } from 'child_process';
import { enabledPlugins, pluginFolders, pluginHooks } from './plugins';

// ------------------------------------------------------------------ the PATH commands see

let pathCache: { at: number; value: string } | null = null;

/** One PATH value from the registry (HKLM or HKCU), with its %VARS% expanded; '' when there is none. */
function registryPath(key: string): string {
  try {
    const r = spawnSync('reg', ['query', key, '/v', 'Path'], { windowsHide: true, encoding: 'utf8', timeout: 5000 });
    const m = /\sPath\s+REG_(?:EXPAND_)?SZ\s+(.*)/i.exec(r.stdout || '');
    return m ? m[1].trim().replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all) : '';
  } catch { return ''; }
}

/**
 * Windows: the PATH as it is now in the registry (machine, then user), then any other folders this VS Code was started with.
 * VS Code keeps the PATH it started with, so a tool installed since (node, git, dotnet) was "not recognized" until a restart.
 * Read again at most once a minute.
 */
export function currentPath(startPath: string): string {
  if (process.platform !== 'win32') return startPath;
  if (pathCache && Date.now() - pathCache.at < 60_000) return pathCache.value;
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const p of [registryPath('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), registryPath('HKCU\\Environment'), startPath].join(';').split(';')) {
    const dir = p.trim();
    if (dir && !seen.has(dir.toLowerCase())) { seen.add(dir.toLowerCase()); parts.push(dir); }
  }
  pathCache = { at: Date.now(), value: parts.join(';') };
  return pathCache.value;
}

/** The environment for a command: this process's, with the current PATH (under the name it already has: Path on Windows). */
export function commandEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  env[key] = currentPath(env[key] || '');
  return env;
}

// ------------------------------------------------------------------ commands (run_command, run_command_background, command_output)
interface Bg {
  id: string; command: string; proc: ChildProcess; out: string; read: number;
  /** The shell's exit code once it ended (something it started may still hold its output open). */
  exitCode: number | null;
  /** Its output ended: nothing it started is still writing to it. */
  closed: boolean;
  started: number; ended: number | null; lastOutput: number;
  /** command (run_command, run_command_background) or monitor: /bashes and /monitors in the chat list them. */
  kind?: string; description?: string;
}
/** A background command or monitor as /bashes and /monitors show it. */
export interface JobInfo { id: string; kind: string; command: string; description?: string; running: boolean; exitCode: number | null; startedUtc: string; output: string }

/** The last line of every PowerShell command: it ends with the exit code of its last program (or 1 when a cmdlet failed). */
export const POWERSHELL_EXIT = '$__agentic_ok = $?; if ($null -ne $global:LASTEXITCODE -and $global:LASTEXITCODE -ne 0) { exit $global:LASTEXITCODE } elseif (-not $__agentic_ok) { exit 1 }';

/** The line run_command adds at a command's end: the folder it ended in (a cd carries over to the chat's next commands). */
export const CWD_MARKER = '__AGENTIC_CWD__=';
const CWD_LINE = /^__AGENTIC_CWD__=.*(\r?\n)?/gm;
export function stripCwd(text: string): string { return text.includes(CWD_MARKER) ? text.replace(CWD_LINE, '') : text; }
/**
 * The command, then a line with the folder it ended in (PowerShell and POSIX shells; cmd keeps the old way), keeping the
 * command's exit code.
 */
export function withCwdMarker(command: string, exe: string): string {
  if (/(^|[\\/])cmd(\.exe)?$/i.test(exe)) return command;
  if (/pwsh|powershell/i.test(exe)) {
    return '$global:LASTEXITCODE = $null\n' + command + '\n' +
      '$__agentic_ok = $?; $__agentic_ec = if ($null -ne $global:LASTEXITCODE) { $global:LASTEXITCODE } elseif ($__agentic_ok) { 0 } else { 1 }\n' +
      `[Console]::Out.WriteLine(''); [Console]::Out.WriteLine('${CWD_MARKER}' + (Get-Location).ProviderPath); exit $__agentic_ec`;
  }
  return command + '\n__agentic_ec=$?\n' + `printf '\\n${CWD_MARKER}%s\\n' "$(pwd -W 2>/dev/null || pwd)"\nexit $__agentic_ec`;
}

/** The output without the folder line, and the folder (null when the command did not get to print it). */
export function splitCwd(output: string): { text: string; folder: string | null } {
  const m = /(?:\r?\n)?__AGENTIC_CWD__=([^\r\n]*)\s*$/.exec(output);
  if (!m) return { text: stripCwd(output), folder: null };
  return { text: stripCwd(output.slice(0, m.index)), folder: m[1].trim() };
}

/** How a wait for a command ended: finished, its shell ended while something it started still runs, still running. */
export type CommandWait = 'finished' | 'shell-ended' | 'running' | 'missing';

/** A shell that ended this long ago while its output is still open left something running that holds it (a server it started). */
const EXIT_GRACE_MS = 2000;
/** Finished commands kept for reading, at most. */
const KEEP_FINISHED = 20;
/** A last line that asks a question and waits for an answer. */
const PROMPT = /(\(y\/n\)|\[y\/n\]|\(yes\/no\)|\[yes\/no\]|press any key|press enter|password\s*:?\s*$|passphrase|are you sure|do you want to (continue|proceed)|continue\?\s*$|\?\s*$)/i;

/** 45 s, 3 min 20 s, 1 h 5 min. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min` + (s % 60 ? ` ${s % 60} s` : '');
  const m = Math.floor(s / 60) % 60;
  return `${Math.floor(s / 3600)} h` + (m ? ` ${m} min` : '');
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
function short(command: string): string { const c = command.trim().split(/\r?\n/)[0]; return c.length > 80 ? c.slice(0, 80) + '…' : c; }
function lastLine(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split(/[\n\r]/).map(l => l.trim()).filter(l => l.length > 0);
  return lines.length ? lines[lines.length - 1] : '';
}

/** Windows: what a finished shell started (they still name it as their parent, and started after it), and what those started. */
function killOrphans(pid: number | undefined, since: number): void {
  if (!pid || process.platform !== 'win32') return;
  const after = new Date(since - 1000).toISOString();
  const script = `$after = [datetime]::Parse('${after}').ToUniversalTime(); function k($p) { Get-CimInstance Win32_Process -Filter "ParentProcessId=$p" | ` +
    `Where-Object { $_.CreationDate.ToUniversalTime() -ge $after } | ForEach-Object { k $_.ProcessId; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }; k ${pid}`;
  try { spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }); } catch { /* nothing left to stop */ }
}

/**
 * Commands on the user's computer. run_command runs one and waits up to its wait for it; one still running then is not
 * stopped but goes on here in the background, like run_command_background. command_output audits them: running or
 * finished, for how long, when they last printed something, their new output, and a warning when one seems to wait for
 * input or to be stuck.
 */
export class BackgroundCommands {
  private readonly jobs = new Map<string, Bg>();
  private seq = 0;

  start(exe: string, args: string[], cwd: string, command: string, onData?: (text: string) => void): string {
    const id = 'bg' + (++this.seq);
    // Its own process group off Windows, so stopping it also stops what it started.
    const proc = spawn(exe, args, { cwd, windowsHide: true, detached: process.platform !== 'win32', env: commandEnv({ NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' }) });
    const job: Bg = { id, command, proc, out: '', read: 0, exitCode: null, closed: false, started: Date.now(), ended: null, lastOutput: 0 };
    const add = (b: Buffer) => {
      const s = b.toString('utf8');
      job.lastOutput = Date.now();
      job.out += s;
      if (job.out.length > 2_000_000) { const cut = job.out.length - 1_000_000; job.out = job.out.slice(cut); job.read = Math.max(0, job.read - cut); }
      if (onData) { try { onData(s); } catch { /* the log is optional */ } }
    };
    proc.stdout?.on('data', add);
    proc.stderr?.on('data', add);
    // exit: the shell ended; close: its output ended too (something it started can keep it open after the shell is gone).
    proc.on('exit', code => { if (job.exitCode === null) { job.exitCode = code ?? -1; job.ended = Date.now(); } });
    proc.on('close', code => { if (job.exitCode === null) { job.exitCode = code ?? -1; job.ended = Date.now(); } job.closed = true; });
    proc.on('error', e => { job.out += '\n' + e.message; if (job.exitCode === null) { job.exitCode = -1; job.ended = Date.now(); } job.closed = true; });
    this.jobs.set(id, job);
    this.prune();
    return id;
  }

  /** Done: its output ended, or its shell ended a moment ago (what still holds the output open is not waited for). */
  private done(j: Bg): boolean {
    return j.closed || (j.ended !== null && Date.now() - j.ended >= EXIT_GRACE_MS);
  }

  /**
   * Waits up to waitMs for a command: it finished, its shell ended while something it started keeps running and holds its
   * output (a server it launched), or it is still running. Nothing is stopped.
   */
  async waitFor(id: string, waitMs: number): Promise<CommandWait> {
    const j = this.jobs.get(id);
    if (!j) return 'missing';
    const deadline = Date.now() + Math.max(0, waitMs);
    for (;;) {
      if (j.closed) return 'finished';
      if (j.ended !== null && Date.now() - j.ended >= EXIT_GRACE_MS) return 'shell-ended';
      if (Date.now() >= deadline) return 'running';
      await sleep(Math.min(100, Math.max(5, deadline - Date.now())));
    }
  }

  /** Its output not read yet (it counts as read now), without the folder line run_command adds at its end. */
  take(id: string): string { return stripCwd(this.takeRaw(id)); }

  takeRaw(id: string): string {
    const j = this.jobs.get(id);
    if (!j) return '';
    const fresh = j.out.slice(j.read);
    j.read = j.out.length;
    return fresh;
  }

  exitCode(id: string): number | null { return this.jobs.get(id)?.exitCode ?? null; }

  /** Drops a finished command (its output was already returned). */
  forget(id: string): void { this.jobs.delete(id); }

  /** A job's output from a position (for monitors, which read on their own), its exit code once done, and if it exists. */
  since(id: string, from: number): { text: string; end: number; exitCode: number | null; exists: boolean } {
    const j = this.jobs.get(id);
    if (!j) return { text: '', end: from, exitCode: null, exists: false };
    const start = Math.min(from, j.out.length);
    return { text: j.out.slice(start), end: j.out.length, exitCode: this.done(j) ? j.exitCode : null, exists: true };
  }

  /**
   * command_output: how a command is doing - running for how long, or its exit code; how long since it last printed
   * something; its new output; and a warning when it seems to wait for input or to be stuck. waitSeconds: first wait up
   * to that long for it to finish or print more. Without an id: all of them.
   */
  async status(id: string, waitSeconds = 0): Promise<string> {
    if (!id) return this.jobs.size ? 'Background commands:\n' + this.list('\n') : 'There are no background commands.';
    const j = this.jobs.get(id);
    if (!j) return `No background command ${id}. ` + (this.jobs.size ? `There are: ${this.list('; ')}.` : 'There are none.');
    // Waits only while there is nothing new to report.
    if (waitSeconds > 0 && !this.done(j) && j.out.length === j.read) {
      const from = j.out.length;
      const deadline = Date.now() + Math.min(3600, waitSeconds) * 1000;
      while (!this.done(j) && j.out.length === from && Date.now() < deadline) await sleep(200);
      // Output comes in pieces: a moment more for the rest of it.
      if (!this.done(j) && j.out.length > from) await sleep(500);
    }
    return this.report(j);
  }

  private report(j: Bg): string {
    const now = Date.now();
    const fresh = stripCwd(j.out.slice(j.read));
    j.read = j.out.length;
    const state = j.exitCode === null ? `running for ${duration(now - j.started)}`
      : `finished with exit code ${j.exitCode} after ${duration((j.ended ?? now) - j.started)}` + (j.closed ? '' : '; something it started is still running and printing');
    const quiet = j.lastOutput ? `last output ${duration(now - j.lastOutput)} ago` : 'no output yet';
    const lines = [`${j.id} (${short(j.command)}): ${state}; ${quiet}.`];
    const warning = this.warning(j, now);
    if (warning) lines.push(warning);
    lines.push(fresh ? (fresh.length > 30000 ? '…' + fresh.slice(-30000) : fresh) : '(no new output)');
    return lines.join('\n');
  }

  /** Something looks wrong with a command that is still running: a question waiting for an answer, or a long silence. */
  private warning(j: Bg, now: number): string {
    if (j.exitCode !== null) return '';
    const idle = now - (j.lastOutput || j.started);
    const last = lastLine(j.out);
    if (idle >= 5000 && last && PROMPT.test(last)) {
      return `Warning: its last line looks like a question waiting for an answer ("${last.slice(-160)}"). Commands get no keyboard input here: stop it ` +
        'with kill_command and run it so it does not ask (for example -y, --yes, -Force, -Confirm:$false, --no-input, -NonInteractive).';
    }
    if (idle >= 120_000) {
      return `Warning: it has printed nothing for ${duration(idle)}. It may be waiting for input, stuck, or busy without printing: if it should ` +
        'have printed something by now, stop it with kill_command and find out why.';
    }
    return '';
  }

  kill(id: string, killTree: (pid: number | undefined) => void): string {
    const j = this.jobs.get(id);
    if (!j) return `No background command ${id}.` + (this.jobs.size ? ` There are: ${this.list('; ')}.` : '');
    let note = '';
    if (!j.closed) {
      // Its shell already ended on Windows: stop what it started (a process tree needs a living root there).
      if (process.platform === 'win32' && j.exitCode !== null) {
        killOrphans(j.proc.pid, j.started);
        note = ' Its shell had already ended: what it started directly was stopped, but a process started through another one that has ended ' +
          'cannot be traced - if its output goes on, stop that process by name or id (Get-Process / Stop-Process).';
      } else killTree(j.proc.pid);
    }
    this.jobs.delete(id);
    return `Stopped ${id} (${short(j.command)}).` + note;
  }

  /** Marks a command as a monitor (what it watches), for /monitors. */
  tag(id: string, kind: string, description: string): void {
    const j = this.jobs.get(id);
    if (j) { j.kind = kind; j.description = description; }
  }

  /** Every command kept, newest first, with the end of its output. */
  entries(): JobInfo[] {
    return [...this.jobs.values()].sort((a, b) => b.started - a.started).map(j => ({
      id: j.id, kind: j.kind || 'command', command: j.command, description: j.description, running: j.exitCode === null,
      exitCode: j.exitCode, startedUtc: new Date(j.started).toISOString(), output: stripCwd(j.out.length > 1500 ? '…' + j.out.slice(-1500) : j.out).trimEnd()
    }));
  }

  list(sep = '; '): string {
    const now = Date.now();
    return [...this.jobs.values()].map(j => `${j.id}: ${short(j.command)} (` + (j.exitCode === null ? `running for ${duration(now - j.started)}`
      : j.closed ? `exit ${j.exitCode}` : `exit ${j.exitCode}, something it started still runs`) + ')').join(sep);
  }

  /** Only the newest finished commands are kept. */
  private prune(): void {
    const finished = [...this.jobs.values()].filter(j => j.closed).sort((a, b) => a.started - b.started);
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.jobs.delete(j.id);
  }

  dispose(killTree: (pid: number | undefined) => void): void {
    for (const j of this.jobs.values()) {
      if (j.closed) continue;
      if (process.platform === 'win32' && j.exitCode !== null) killOrphans(j.proc.pid, j.started);
      else killTree(j.proc.pid);
    }
    this.jobs.clear();
  }
}

// ------------------------------------------------------------------ settings files (hooks)
function readJson(file: string): any {
  try { return JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return null; }
}
function settingsFiles(roots: string[], includeClaudeUser = false): string[] {
  const home = os.homedir();
  // ~/.claude only when the user asks for it (agentic.hooks.includeClaudeUser): those hooks are written for Claude Code itself.
  const list = [path.join(home, '.agentic', 'settings.json')];
  if (includeClaudeUser) list.push(path.join(home, '.claude', 'settings.json'));
  for (const r of roots) list.push(path.join(r, '.agentic', 'settings.json'), path.join(r, '.agentic', 'settings.local.json'),
    path.join(r, '.claude', 'settings.json'), path.join(r, '.claude', 'settings.local.json'));
  return list;
}

/** The settings files that exist and the hooks of each Claude Code plugin that is on (${CLAUDE_PLUGIN_ROOT} filled in). */
function hookDocs(roots: string[], includeClaudeUser: boolean): { file: string; s: any }[] {
  const out: { file: string; s: any }[] = [];
  for (const f of settingsFiles(roots, includeClaudeUser)) { if (fsSync.existsSync(f)) out.push({ file: f, s: readJson(f) }); }
  for (const p of enabledPlugins(roots).filter(x => x.hooksOn)) {
    const hooks = pluginHooks(p.dir);
    if (Object.keys(hooks).length) out.push({ file: 'plugin ' + p.name + ' (' + p.dir + ')', s: { hooks } });
  }
  return out;
}

/** Claude Code tool names for the matcher ("Edit|Write" matches edit_file and write_file). */
const CLAUDE_NAMES: Record<string, string> = { write_file: 'Write', edit_file: 'Edit', run_command: 'Bash', run_command_background: 'Bash', read_file: 'Read', grep: 'Grep', glob_files: 'Glob', list_dir: 'LS', edit_notebook: 'NotebookEdit', monitor: 'Monitor' };

/**
 * What the hooks of one event decided (Claude Code's exit codes and JSON answers). output: what the hooks that succeeded
 * printed (UserPromptSubmit and SessionStart hand it to the model); context: hookSpecificOutput.additionalContext;
 * decision: allow | deny | ask; updatedInput: the tool's arguments rewritten by a hook.
 */
export interface HookResult { blocked: boolean; message: string; output?: string; context?: string; decision?: string; updatedInput?: Record<string, unknown>; systemMessage?: string }
const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'UserPromptSubmit', 'SessionStart', 'Stop',
  'SubagentStart', 'SubagentStop', 'Notification', 'PreCompact', 'PostCompact'];
/** Events whose hooks get the tool's name (their target is a tool). */
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);

/** Reads one hook's stdout into the result: a JSON answer (decision, permissionDecision, updatedInput, additionalContext…) or plain text. */
export function readHookAnswer(stdout: string, result: HookResult, printed: string[]): void {
  const text = (stdout || '').trim();
  let answer: any = null;
  if (text.startsWith('{')) { try { answer = JSON.parse(text); } catch { answer = null; } }
  if (!answer || typeof answer !== 'object') { if (text) printed.push(text.slice(0, 10000)); return; }
  if (answer.continue === false) { result.blocked = true; result.message = String(answer.stopReason || 'Stopped by a hook.'); }
  const decision = String(answer.decision || '').toLowerCase();
  if (decision === 'block') { result.blocked = true; result.message = String(answer.reason || 'Blocked by a hook.'); }
  else if (decision === 'approve') result.decision = 'allow';
  const specific = answer.hookSpecificOutput;
  if (specific && typeof specific === 'object') {
    if (typeof specific.permissionDecision === 'string') {
      result.decision = specific.permissionDecision.toLowerCase();
      if (result.decision === 'deny') { result.blocked = true; result.message = String(specific.permissionDecisionReason || 'Denied by a hook.'); }
    }
    // PermissionRequest: {"decision": {"behavior": "allow" | "deny", "message", "updatedInput"}}.
    const dec = specific.decision;
    if (dec && typeof dec === 'object') {
      const behavior = String(dec.behavior || '').toLowerCase();
      if (behavior === 'allow' || behavior === 'deny') result.decision = behavior;
      if (behavior === 'deny') result.message = String(dec.message || 'Denied by a hook.');
      if (dec.updatedInput && typeof dec.updatedInput === 'object') result.updatedInput = dec.updatedInput;
    }
    if (specific.updatedInput && typeof specific.updatedInput === 'object') result.updatedInput = specific.updatedInput;
    if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) {
      result.context = result.context ? result.context + '\n' + specific.additionalContext : specific.additionalContext;
    }
  }
  if (typeof answer.systemMessage === 'string') result.systemMessage = answer.systemMessage;
}

export class HookRunner {
  constructor(private readonly roots: () => string[], private readonly shell: () => { exe: string; args: (c: string) => string[] },
    private readonly includeClaudeUser: () => boolean = () => false) { }

  /**
   * The commands of an event's hooks whose matcher fits target (a tool name, a session's source, a compaction's trigger…; ''
   * for events without one, where matchers do not count), each with its time limit ("timeout" in seconds, default 60).
   */
  private hooks(event: string, tool: string): { command: string; timeout: number }[] {
    const cmds: { command: string; timeout: number }[] = [];
    for (const { s } of hookDocs(this.roots(), this.includeClaudeUser())) {
      for (const group of (s && s.hooks && Array.isArray(s.hooks[event]) ? s.hooks[event] : [])) {
        const m = String(group.matcher || '');
        let fits = !m || m === '*' || !tool;
        if (!fits) { try { const re = new RegExp(`^(?:${m})$`, 'i'); fits = re.test(tool) || re.test(CLAUDE_NAMES[tool] || ''); } catch { fits = false; } }
        if (!fits) continue;
        for (const h of (Array.isArray(group.hooks) ? group.hooks : [])) {
          if (h && h.type === 'command' && h.command) cmds.push({ command: String(h.command), timeout: Math.min(3600, Math.max(1, Number(h.timeout) || 60)) });
        }
      }
    }
    return cmds;
  }

  count(): number { return ['PreToolUse', 'PostToolUse', 'Stop'].reduce((n, e) => n + this.hooks(e, '*').length, 0); }

  /**
   * Runs the event's hooks (payload as JSON on stdin), like Claude Code: exit code 2 blocks (stderr is the reason); exit 0
   * with a JSON answer can block, allow or deny, rewrite the tool's input or add context; plain output is kept for the model.
   */
  async run(event: string, tool: string, payload: Record<string, unknown>): Promise<HookResult> {
    const cmds = this.hooks(event, tool);
    const notes: string[] = [], printed: string[] = [];
    const result: HookResult = { blocked: false, message: '' };
    const input: Record<string, unknown> = { hook_event_name: event, cwd: this.roots()[0] || os.homedir(), ...payload };
    if (TOOL_EVENTS.has(event)) input.tool_name = CLAUDE_NAMES[tool] || tool;
    for (const cmd of cmds) {
      const r = await this.exec(cmd.command, JSON.stringify(input), cmd.timeout);
      if (r.code === 2) { result.blocked = true; result.message = (r.stderr || r.stdout || `Blocked by the hook: ${cmd.command}`).trim(); break; }
      if (r.code !== 0 && (r.stderr || r.stdout)) notes.push(`Hook "${cmd.command}" exited with ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
      else if (r.code === 0) { readHookAnswer(r.stdout, result, printed); if (result.blocked) break; }
    }
    if (!result.blocked) result.message = notes.join('\n');
    result.output = printed.join('\n\n');
    return result;
  }

  /** Every hook in the settings files (/hooks in the chat), and the files that exist. */
  /** The hooks editor (/hooks): adds a hook to the project's (or your own) .agentic/settings.json. */
  save(scope: string, event: string, matcher: string, command: string, timeout: number): string {
    if (!HOOK_EVENTS.includes(event)) throw new Error('Unknown hook event: ' + event);
    if (!command || !command.trim()) throw new Error('Give the command the hook runs.');
    const file = scope === 'user' ? path.join(os.homedir(), '.agentic', 'settings.json') : path.join(this.roots()[0] || os.homedir(), '.agentic', 'settings.json');
    const s = readJson(file) || {};
    s.hooks = s.hooks || {};
    s.hooks[event] = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
    const entry: Record<string, unknown> = { type: 'command', command: command.trim() };
    if (timeout > 0) entry.timeout = timeout;
    s.hooks[event].push(matcher && matcher.trim() ? { matcher: matcher.trim(), hooks: [entry] } : { hooks: [entry] });
    fsSync.mkdirSync(path.dirname(file), { recursive: true });
    fsSync.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
    return file;
  }

  /** Removes the first hook of that event, matcher and command from one of the hook files. */
  remove(file: string, event: string, matcher: string, command: string): boolean {
    if (!settingsFiles(this.roots(), this.includeClaudeUser()).some(f => path.resolve(f) === path.resolve(file || ''))) throw new Error('Hooks are removed only from the settings files the chat uses.');
    const s = readJson(file);
    const groups = s && s.hooks && Array.isArray(s.hooks[event]) ? s.hooks[event] : null;
    if (!groups) return false;
    for (const g of groups) {
      if (String(g.matcher || '') !== String(matcher || '') || !Array.isArray(g.hooks)) continue;
      const i = g.hooks.findIndex((h: any) => h && h.command === command);
      if (i < 0) continue;
      g.hooks.splice(i, 1);
      if (!g.hooks.length) groups.splice(groups.indexOf(g), 1);
      fsSync.writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
      return true;
    }
    return false;
  }

  /** Runs a hook command once with a sample input of that event. */
  async test(event: string, command: string): Promise<{ code: number; stdout: string; stderr: string; input: string }> {
    const input: Record<string, unknown> = { session_id: 'test', hook_event_name: event, cwd: this.roots()[0] || '', permission_mode: 'default' };
    if (TOOL_EVENTS.has(event)) { input.tool_name = 'Bash'; input.tool_input = { command: 'echo hello' }; }
    if (event === 'UserPromptSubmit') input.prompt = 'Hello';
    const text = JSON.stringify(input);
    const r = await this.exec(command, text, 30);
    return { code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim(), input: text };
  }

  list(): { files: string[]; hooks: { event: string; matcher: string; command: string; file: string }[] } {
    const files: string[] = [], hooks: { event: string; matcher: string; command: string; file: string }[] = [];
    for (const { file: f, s } of hookDocs(this.roots(), this.includeClaudeUser())) {
      files.push(f);
      for (const event of HOOK_EVENTS) {
        for (const group of (s && s.hooks && Array.isArray(s.hooks[event]) ? s.hooks[event] : [])) {
          for (const h of (Array.isArray(group.hooks) ? group.hooks : [])) {
            if (h && h.type === 'command' && h.command) hooks.push({ event, matcher: String(group.matcher || ''), command: String(h.command), file: f });
          }
        }
      }
    }
    return { files, hooks };
  }

  private exec(cmd: string, stdin: string, timeoutSeconds = 60): Promise<{ code: number; stdout: string; stderr: string }> {
    const sh = this.shell();
    return new Promise(resolve => {
      let stdout = '', stderr = '';
      const root = this.roots()[0] || os.homedir();
      const p = spawn(sh.exe, sh.args(cmd), { cwd: root, windowsHide: true, detached: process.platform !== 'win32', env: commandEnv({ CLAUDE_PROJECT_DIR: root, AGENTIC_PROJECT_DIR: root }) });
      let done = false;
      const finish = (r: { code: number; stdout: string; stderr: string }) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
      // Too long: the hook and what it started stop (a child that keeps the output open would otherwise hold it), and it counts as failed.
      const timer = setTimeout(() => {
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
          else if (p.pid) process.kill(-p.pid, 'SIGKILL');
        } catch { /* gone */ }
        finish({ code: -1, stdout, stderr: `timed out after ${timeoutSeconds} s` });
      }, timeoutSeconds * 1000);
      p.stdout?.on('data', b => { stdout += b; });
      p.stderr?.on('data', b => { stderr += b; });
      p.on('close', code => finish({ code: code ?? -1, stdout, stderr }));
      p.on('error', e => finish({ code: -1, stdout, stderr: e.message }));
      p.stdin?.end(stdin);
    });
  }
}

// ------------------------------------------------------------------ skills and custom slash commands
export interface Skill { name: string; description: string; file: string }

export class SkillCatalog {
  constructor(private readonly roots: () => string[]) { }

  /** Folders of a kind; a Claude Code plugin's are named "plugin:" (its commands are /plugin:name, its skills plugin:name). */
  private dirs(kind: 'skills' | 'commands'): { dir: string; prefix: string }[] {
    const home = os.homedir();
    const list = [path.join(home, '.agentic', kind), path.join(home, '.claude', kind)].map(dir => ({ dir, prefix: '' }));
    for (const r of this.roots()) list.push({ dir: path.join(r, '.agentic', kind), prefix: '' }, { dir: path.join(r, '.claude', kind), prefix: '' });
    for (const p of enabledPlugins(this.roots())) for (const dir of pluginFolders(p.dir, kind)) list.push({ dir, prefix: p.name + ':' });
    return list;
  }

  async skills(): Promise<Skill[]> {
    const out: Skill[] = [];
    for (const { dir: d, prefix } of this.dirs('skills')) {
      const names = await fs.readdir(d).catch(() => [] as string[]);
      for (const n of names) {
        const file = path.join(d, n, 'SKILL.md');
        const text = await fs.readFile(file, 'utf8').catch(() => null);
        if (text === null) continue;
        const fm = frontMatter(text);
        const name = prefix + (fm.name || n);
        if (!out.some(s => s.name === name)) out.push({ name, description: fm.description || '', file });
      }
    }
    return out;
  }

  async skillBody(name: string): Promise<string | null> {
    const s = (await this.skills()).find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!s) return null;
    return `<skill name="${s.name}" folder="${path.dirname(s.file)}">\n${stripFrontMatter(await fs.readFile(s.file, 'utf8'))}\n</skill>`;
  }

  /** "/name args" at the start of a message: that command's file, with $ARGUMENTS filled in (null when none matches). */
  async expandCommand(content: string): Promise<{ name: string; prompt: string } | null> {
    const m = /^\s*\/([A-Za-z0-9][\w:.-]*)(?:\s+([\s\S]*))?$/.exec(content || '');
    if (!m) return null;
    for (const { dir: d, prefix } of this.dirs('commands')) {
      // A plugin's command is /plugin:name; others may be in sub folders (/frontend:test is frontend/test.md).
      if (prefix && !m[1].toLowerCase().startsWith(prefix.toLowerCase())) continue;
      const rel = m[1].slice(prefix.length).replace(/:/g, path.sep) + '.md';
      const text = await fs.readFile(path.join(d, rel), 'utf8').catch(() => null);
      if (text === null) continue;
      const args = (m[2] || '').trim();
      let body = stripFrontMatter(text);
      body = body.includes('$ARGUMENTS') ? body.split('$ARGUMENTS').join(args) : body + (args ? `\n\n${args}` : '');
      return { name: m[1], prompt: body };
    }
    return null;
  }

  async commands(): Promise<{ name: string; description: string }[]> {
    const out: { name: string; description: string }[] = [];
    for (const { dir: d, prefix } of this.dirs('commands')) {
      for (const f of await fs.readdir(d).catch(() => [] as string[])) {
        if (!f.endsWith('.md')) continue;
        const text = await fs.readFile(path.join(d, f), 'utf8').catch(() => '');
        const name = prefix + f.slice(0, -3);
        if (!out.some(c => c.name === name)) out.push({ name, description: frontMatter(text).description || stripFrontMatter(text).split('\n')[0].slice(0, 100) });
      }
    }
    return out;
  }
}

function frontMatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) { const kv = /^([\w-]+):\s*(.*)$/.exec(line); if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, ''); }
  return out;
}
function stripFrontMatter(text: string): string { return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim(); }
