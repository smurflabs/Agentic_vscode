/**
 * The chat in VS Code: the sidebar view (Agentic in the activity bar) and an editor panel. Both show the Agentic web
 * app from the local proxy in a frame; messages from the extension (insert text, attach a file, new chat) go to the
 * frame through media/webview.js, which holds them until the page has loaded.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';

export interface ToPage { type: string; [key: string]: unknown }
export interface FromPage { type: string; [key: string]: unknown }

export interface ChatViewHost {
  ready(): boolean;
  /** The address of the page to show (the local proxy, mapped for remote windows), or undefined when unavailable. */
  pageUrl(): Promise<string | undefined>;
  serverLabel(): string;
  /** Page animations: calm | full | off. */
  motion(): string;
  onPageMessage(m: FromPage): void;
}

export class ChatViews implements vscode.WebviewViewProvider {
  /** The chat in the left activity bar (VS Code before 1.106) and in the right, secondary side bar (like Chat, Claude Code, Codex). */
  static readonly viewIds = ['agentic.chatView', 'agentic.chatViewSecondary'];
  private readonly views = new Set<vscode.WebviewView>();
  /** The view that 'open the chat' focuses: the side bar this VS Code shows it in. */
  readonly viewId: string;
  private panel?: vscode.WebviewPanel;
  /** Messages for a chat whose page has not said it is ready yet (just created, reloading, signing in). */
  private readonly pending = new Map<vscode.Webview, { ready: boolean; queue: ToPage[] }>();

  constructor(private readonly ctx: vscode.ExtensionContext, private readonly host: ChatViewHost, secondarySidebar: boolean) {
    this.viewId = ChatViews.viewIds[secondarySidebar ? 1 : 0];
  }

  /** Whether a chat is in view: the editor tab or a side-bar chat. */
  get anyVisible(): boolean {
    if (this.panel && this.panel.visible) return true;
    for (const v of this.views) { if (v.visible) return true; }
    return false;
  }

  /** The side-bar chat in use: a visible one, else any. */
  private get view(): vscode.WebviewView | undefined {
    let any: vscode.WebviewView | undefined;
    for (const v of this.views) { if (v.visible) return v; any = v; }
    return any;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.views.add(view);
    this.setup(view.webview);
    view.onDidDispose(() => { this.pending.delete(view.webview); this.views.delete(view); });
    void this.render(view.webview);
  }

  /** Opens (or shows) the chat in an editor tab: beside the editor, or in the active group (wide, for multitask). */
  openPanel(column: vscode.ViewColumn = vscode.ViewColumn.Beside): void {
    if (this.panel) { this.panel.reveal(column === vscode.ViewColumn.Beside ? undefined : column); return; }
    const panel = vscode.window.createWebviewPanel('agentic.chatPanel', 'Agentic', { viewColumn: column, preserveFocus: false }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')]
    });
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.png');
    this.panel = panel;
    this.setup(panel.webview);
    panel.onDidDispose(() => { this.pending.delete(panel.webview); if (this.panel === panel) this.panel = undefined; });
    void this.render(panel.webview);
  }

  /** Shows the sign-in screen or the app in every open chat (after signing in or out, or a new server). */
  async refresh(): Promise<void> {
    for (const v of this.views) await this.render(v.webview);
    if (this.panel) await this.render(this.panel.webview);
  }

  /** Sends a message to every open chat (a setting changed). */
  async broadcast(m: ToPage): Promise<void> {
    for (const w of [...[...this.views].map(v => v.webview), this.panel?.webview]) if (w) await this.send(w, m);
  }

  /** Sends a message to the editor-tab chat (held by the page until it has loaded). */
  async postToPanel(m: ToPage): Promise<void> {
    if (this.panel) await this.send(this.panel.webview, m);
  }

  /** Sends a message to the chat the user is using: the editor panel if it is visible, else the sidebar (opened). */
  async post(m: ToPage): Promise<void> {
    let target: vscode.Webview | undefined;
    if (this.panel && this.panel.visible) target = this.panel.webview;
    else {
      if (!this.view || !this.view.visible) await vscode.commands.executeCommand(`${this.viewId}.focus`);
      for (let i = 0; i < 30 && !this.view; i++) await new Promise(r => setTimeout(r, 100));
      target = this.view?.webview || this.panel?.webview;
    }
    if (!target) { void vscode.window.showWarningMessage('Agentic: the chat could not be opened.'); return; }
    await this.send(target, m);
  }

  /** Delivers now if the page is ready, else when it says so. */
  private async send(webview: vscode.Webview, m: ToPage): Promise<void> {
    const st = this.pending.get(webview);
    if (st && !st.ready) { st.queue.push(m); return; }
    await webview.postMessage({ source: 'agentic-vscode', ...m });
  }

  private setup(webview: vscode.Webview): void {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'media')] };
    webview.onDidReceiveMessage((m: FromPage) => {
      if (!m || typeof m.type !== 'string') return;
      if (m.type === 'signin') { void vscode.commands.executeCommand('agentic.signIn'); return; }
      if (m.type === 'ready') {
        const st = this.pending.get(webview);
        if (st) { st.ready = true; const q = st.queue.splice(0); for (const x of q) void webview.postMessage({ source: 'agentic-vscode', ...x }); }
      }
      this.host.onPageMessage(m);
    });
  }

  private async render(webview: vscode.Webview): Promise<void> {
    // A new page: hold messages until its layer is ready (keep what was already waiting).
    const st = this.pending.get(webview);
    this.pending.set(webview, { ready: false, queue: st ? st.queue : [] });
    if (!this.host.ready()) { webview.html = this.signInHtml(webview); return; }
    const url = await this.host.pageUrl();
    webview.html = url ? this.appHtml(webview, url) : this.errorHtml(webview, 'The local chat server could not start. See "Agentic: Show Log".');
  }

  private appHtml(webview: vscode.Webview, url: string): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const origin = new URL(url).origin;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'webview.js'));
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:var(--vscode-sideBar-background)}
iframe{border:0;width:100%;height:100%;display:block}
#wait{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:13px var(--vscode-font-family);color:var(--vscode-descriptionForeground)}
#wait.gone{display:none}</style></head>
<body><div id="wait">Connecting to Agentic…</div>
<iframe id="app" src="${escapeAttr(url)}" data-origin="${escapeAttr(origin)}" data-motion="${escapeAttr(this.host.motion())}" allow="clipboard-read; clipboard-write; microphone; autoplay; fullscreen"></iframe>
<script nonce="${nonce}" src="${script}"></script></body></html>`;
  }

  private signInHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const logo = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.png'));
    const server = this.host.serverLabel();
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
<style>body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:24px 18px;text-align:center}
img{width:56px;height:56px;border-radius:12px;margin:8px auto 14px;display:block}
h2{font-size:15px;margin:0 0 6px}p{color:var(--vscode-descriptionForeground);line-height:1.5;margin:0 0 16px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:7px 16px;border-radius:4px;cursor:pointer;font:inherit}
button:hover{background:var(--vscode-button-hoverBackground)}code{font-family:var(--vscode-editor-font-family)}</style></head>
<body><img src="${logo}" alt=""><h2>Agentic</h2>
<p>Chat with every model on your Agentic server, with tools that work in this workspace.${server ? `<br>Server: <code>${escapeHtml(server)}</code>` : ''}</p>
<button id="go">Sign in</button>
<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('go').onclick=()=>vscode.postMessage({type:'signin'});</script>
</body></html>`;
  }

  private errorHtml(webview: vscode.Webview, message: string): string {
    void webview;
    return `<!doctype html><html><body style="font:13px var(--vscode-font-family);color:var(--vscode-errorForeground);padding:18px">${escapeHtml(message)}</body></html>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
function escapeAttr(s: string): string { return escapeHtml(s); }
