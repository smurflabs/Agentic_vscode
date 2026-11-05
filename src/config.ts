/**
 * Where the Agentic server is and how to sign in: the address from the setting (or AGENTIC_SERVER, like the Agentic
 * CLI), the API key from VS Code's secret storage (or AGENTIC_API_KEY). Also this install's device id, which the server
 * uses to send tool calls from chats started elsewhere to this VS Code while it is open.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as os from 'os';

const KEY_SECRET = 'agentic.apiKey';
const DEVICE_STATE = 'agentic.deviceId';

export class AgenticConfig {
  private key: string | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly ctx: vscode.ExtensionContext) { }

  async load(): Promise<void> {
    this.key = (await this.ctx.secrets.get(KEY_SECRET)) || undefined;
    this.ctx.subscriptions.push(this.ctx.secrets.onDidChange(async e => {
      if (e.key !== KEY_SECRET) return;
      this.key = (await this.ctx.secrets.get(KEY_SECRET)) || undefined;
      this.changed.fire();
    }));
    this.ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('agentic.serverUrl')) this.changed.fire();
    }));
  }

  /** The server address without a trailing slash, or ''. */
  baseUrl(): string {
    const set = vscode.workspace.getConfiguration('agentic').get<string>('serverUrl', '') || process.env.AGENTIC_SERVER || '';
    return normalizeUrl(set);
  }

  apiKey(): string | undefined { return this.key || process.env.AGENTIC_API_KEY || undefined; }

  /** Signed in: a server and a key. */
  ready(): boolean { return !!this.baseUrl() && !!this.apiKey(); }

  async save(url: string, key: string): Promise<void> {
    await vscode.workspace.getConfiguration('agentic').update('serverUrl', normalizeUrl(url), vscode.ConfigurationTarget.Global);
    await this.ctx.secrets.store(KEY_SECRET, key.trim());
    this.key = key.trim();
    this.changed.fire();
  }

  async signOut(): Promise<void> {
    await this.ctx.secrets.delete(KEY_SECRET);
    this.key = undefined;
    this.changed.fire();
  }

  /** This VS Code install (the same in every window): for updates. */
  installId(): string {
    let id = this.ctx.globalState.get<string>(DEVICE_STATE);
    if (!id) {
      id = 'vscode-' + crypto.randomBytes(8).toString('hex');
      void this.ctx.globalState.update(DEVICE_STATE, id);
    }
    return id;
  }

  /**
   * The device this window is to the server: this install AND its workspace. Every VS Code window used to share one id
   * (it lives in globalState, which all windows share), so the server could send a tool call — and the workspace
   * instructions of whichever window spoke last — to a different window, and files were written in the wrong project.
   * Now each workspace is its own device; a window without a folder gets an id of its own.
   */
  deviceId(): string {
    const base = this.installId().replace(/^vscode-/, '').slice(0, 10);
    return `vscode-${base}-${workspaceKey()}`;
  }

  /** "HOST · VS Code · project", so the device list tells windows apart. */
  machineName(): string { return `${os.hostname()} · VS Code · ${workspaceLabel()}`; }
}

/** A window without a workspace still needs an id no other window shares (one per extension host = per window). */
const WINDOW_KEY = crypto.randomBytes(5).toString('hex');

/** A short, stable key for this window's workspace: the .code-workspace file, else its folders (case-folded on Windows). */
export function workspaceKey(): string {
  const file = vscode.workspace.workspaceFile && vscode.workspace.workspaceFile.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : '';
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.scheme === 'file' ? f.uri.fsPath : f.uri.toString()).sort();
  let identity = file || folders.join('|');
  if (!identity) return 'w' + WINDOW_KEY;
  if (process.platform === 'win32') identity = identity.toLowerCase();
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12);
}

/** The workspace's name as VS Code shows it ("LeagueClientDebugger"), or "no folder". */
export function workspaceLabel(): string {
  const name = vscode.workspace.name || (vscode.workspace.workspaceFolders || [])[0]?.name || '';
  return (name || 'no folder').replace(/\s*\(Workspace\)$/i, '').slice(0, 40);
}

export function normalizeUrl(url: string): string {
  let u = (url || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  return u.replace(/\/+$/, '');
}
