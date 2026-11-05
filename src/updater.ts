/**
 * Updates from the Agentic server, like the desktop app and the CLI: the server publishes the extension as the
 * "vscode" app (Apps & updates). The extension asks GET /api/updates/vscode?version=… when VS Code starts and then
 * every few hours (the server says how often); a newer build is downloaded, checked against its SHA-256, and installed
 * through VS Code, which then asks to reload the window.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AgenticConfig } from './config';

interface Latest { version: string; sha256: string; downloadUrl: string; notes?: string; size?: number }
interface CheckResult { updateAvailable: boolean; mandatory: boolean; checkIntervalMinutes?: number; latest: Latest }

export class Updater implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  /** The version installed this session (VS Code still runs the old one until it reloads). */
  private installed: string | undefined;
  private intervalMinutes = 360;

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly config: AgenticConfig, private readonly log: (s: string) => void) { }

  get version(): string { return String(this.ctx.extension.packageJSON.version || '0.0.0'); }
  private get cfg() { return vscode.workspace.getConfiguration('agentic'); }

  /** First check shortly after start-up, then on the server's interval. Not while the extension is being developed. */
  start(): void {
    if (this.ctx.extensionMode !== vscode.ExtensionMode.Production) return;
    this.schedule(45_000);
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.check(false).finally(() => this.schedule(this.intervalMinutes * 60_000)); }, ms);
  }

  dispose(): void { if (this.timer) clearTimeout(this.timer); }

  /** Checks the server; manual = the user asked (Agentic: Check for Updates), so every outcome is reported. */
  async check(manual: boolean): Promise<void> {
    if (this.busy) { if (manual) void vscode.window.showInformationMessage('Agentic: already checking for updates.'); return; }
    if (!manual && !this.cfg.get<boolean>('updates.enabled', true)) return;
    const base = this.config.baseUrl(), key = this.config.apiKey();
    if (!base || !key) { if (manual) void vscode.window.showInformationMessage('Agentic: sign in first to check for updates.'); return; }
    this.busy = true;
    try {
      const q = new URLSearchParams({ version: this.installed || this.version, installId: this.config.installId(), machine: os.hostname() });
      const res = await fetch(`${base}/api/updates/vscode?${q}`, { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (res.status === 404 || res.status === 409) {
        if (manual) void vscode.window.showInformationMessage(res.status === 404
          ? 'Agentic: this server does not publish the VS Code extension (Apps & updates).'
          : 'Agentic: client updates are turned off on this server.');
        return;
      }
      if (!res.ok) throw new Error(`the server answered HTTP ${res.status}`);
      const d = await res.json() as CheckResult;
      if (d.checkIntervalMinutes && d.checkIntervalMinutes >= 5) this.intervalMinutes = d.checkIntervalMinutes;
      if (!d.updateAvailable || !d.latest) {
        if (manual) void vscode.window.showInformationMessage(this.installed
          ? `Agentic ${this.installed} is installed: reload the window to use it.`
          : `Agentic ${this.version} is up to date.`);
        return;
      }
      if (this.installed === d.latest.version) return;
      this.log(`update available: ${this.version} -> ${d.latest.version}${d.mandatory ? ' (required)' : ''}`);
      const automatic = this.cfg.get<boolean>('updates.automatic', true);
      if (!automatic && !d.mandatory && !manual) {
        const pick = await vscode.window.showInformationMessage(`Agentic ${d.latest.version} is available (you have ${this.version}).`, 'Install', 'Not Now');
        if (pick !== 'Install') return;
      }
      await this.install(base, key, d.latest);
    } catch (e: any) {
      this.log('update check failed: ' + (e && (e.cause && e.cause.message || e.message) || e));
      if (manual) void vscode.window.showErrorMessage('Agentic: could not check for updates: ' + (e && e.message || e));
    } finally {
      this.busy = false;
    }
  }

  private async install(base: string, key: string, latest: Latest): Promise<void> {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Agentic: updating to ${latest.version}…` }, async () => {
      const res = await fetch(base + latest.downloadUrl, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(300000) });
      if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (latest.sha256 && sha.toLowerCase() !== latest.sha256.toLowerCase()) throw new Error('the download does not match its SHA-256; not installed.');
      // A plain file: VS Code installs a .vsix only from a file: URI ("No Servers" for its storage folders' schemes).
      const dir = path.join(os.tmpdir(), 'agentic-vscode-updates');
      await fs.mkdir(dir, { recursive: true });
      const fullPath = path.join(dir, `agentic-vscode-${latest.version.replace(/[^\w.-]/g, '_')}.vsix`);
      await fs.writeFile(fullPath, bytes);
      try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(fullPath));
      } finally {
        await fs.rm(fullPath, { force: true }).catch(() => undefined);
      }
      this.installed = latest.version;
      this.log(`installed ${latest.version}`);
    });
    // Not awaited: the notification stays until the user answers, and the check must finish now.
    void vscode.window.showInformationMessage(
      `Agentic was updated to ${latest.version}.${latest.notes ? ' ' + firstLine(latest.notes) : ''} Reload the window to use it.`, 'Reload Window')
      .then(pick => { if (pick) void vscode.commands.executeCommand('workbench.action.reloadWindow'); });
  }
}

function firstLine(s: string): string {
  const l = s.split(/\r?\n/).find(x => x.trim()) || '';
  return l.length > 140 ? l.slice(0, 140) + '…' : l;
}
