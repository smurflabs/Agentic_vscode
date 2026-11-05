/**
 * Agentic for VS Code: the Agentic desktop app's chat, inside VS Code. The chat view shows the Agentic web app from a
 * local proxy that adds the API key (like the desktop app), so every model, custom model, goal, plan, attachment and
 * setting works as it does there; a layer in the page adds tools that work in this workspace through VS Code, and the
 * editor commands below put code, files and problems into the chat.
 */
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AgenticConfig, normalizeUrl } from './config';
import { LocalProxy } from './proxy';
import { localApi } from './localApi';
import { WorkspaceTools } from './tools/workspaceTools';
import { Checkpoints } from './tools/checkpoints';
import { ChatViews, FromPage } from './chatView';
import { Updater } from './updater';
import { wireRuns } from './runView';
import { IdeServer } from './ideServer';

/** full: the whole Agentic web app in the view; lite: the chat only, looking like Claude Code (setting agentic.chat.mode). */
function chatMode(): 'full' | 'lite' {
  return vscode.workspace.getConfiguration('agentic').get<string>('chat.mode', 'full') === 'lite' ? 'lite' : 'full';
}
let pendingFullPath: string | undefined;
async function setChatMode(mode: 'full' | 'lite', path?: string): Promise<void> {
  pendingFullPath = mode === 'full' ? path : undefined;
  if (chatMode() === mode) { if (path) await vscode.commands.executeCommand('agentic.openChat'); return; }
  // The change event re-renders the views (and sets the context key for the title buttons).
  await vscode.workspace.getConfiguration('agentic').update('chat.mode', mode, vscode.ConfigurationTarget.Global);
}

let proxy: LocalProxy | undefined;

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel('Agentic');
  const commandsOut = vscode.window.createOutputChannel('Agentic: Commands');
  ctx.subscriptions.push(out, commandsOut);
  const devLog = ctx.extensionMode !== vscode.ExtensionMode.Production;
  // The latest lines also go with /feedback (the app's logs).
  const logLines: string[] = [];
  const log = (line: string) => {
    const stamped = `[${new Date().toLocaleTimeString()}] ${line}`;
    logLines.push(stamped);
    if (logLines.length > 3000) logLines.splice(0, logLines.length - 3000);
    out.appendLine(stamped);
    // Developing or testing the extension: the same lines in the extension host's console.
    if (devLog) console.log('[agentic] ' + line);
  };
  const version = String(ctx.extension.packageJSON.version || '0.0.0');

  const config = new AgenticConfig(ctx);
  await config.load();
  // MCP servers: tokens and VS Code's ${input:} values in the secret storage; a change (a server connected, failed, needs you) tells
  // the chat page (set once the views exist).
  let mcpChanged = () => { };
  let mcpTimer: NodeJS.Timeout | undefined;
  const tools = new WorkspaceTools({
    baseUrl: () => config.baseUrl(), apiKey: () => config.apiKey(), log, commandsChannel: commandsOut, deviceId: () => config.deviceId(),
    mcp: {
      state: ctx.globalState, secrets: ctx.secrets, version,
      openBrowser: url => vscode.env.openExternal(vscode.Uri.parse(url)),
      // An MCP server asks the user something while a tool runs: one box per field (a pick list for yes/no and choices).
      elicit: async (server, message, schema) => {
        const props: Record<string, any> = schema && schema.properties ? schema.properties : {};
        const keys = Object.keys(props);
        if (!keys.length) {
          const pick = await vscode.window.showInformationMessage(`${server}: ${message}`, { modal: true }, 'OK', 'Decline');
          return pick === 'OK' ? { action: 'accept', content: {} } : { action: pick === 'Decline' ? 'decline' : 'cancel' };
        }
        const content: Record<string, unknown> = {};
        for (const k of keys) {
          const p = props[k] || {};
          const title = `${server}: ${message}`;
          const label = p.title || p.description || k;
          if (p.type === 'boolean' || Array.isArray(p.enum)) {
            const items = p.type === 'boolean' ? ['true', 'false'] : p.enum.map(String);
            const v = await vscode.window.showQuickPick(items, { title, placeHolder: label, ignoreFocusOut: true });
            if (v === undefined) return { action: 'cancel' };
            content[k] = p.type === 'boolean' ? v === 'true' : v;
          } else {
            const v = await vscode.window.showInputBox({ title, prompt: label, value: p.default !== undefined ? String(p.default) : '', ignoreFocusOut: true,
              password: /password|secret|token|key/i.test(k) });
            if (v === undefined) return { action: 'cancel' };
            content[k] = p.type === 'number' || p.type === 'integer' ? Number(v) : v;
          }
        }
        return { action: 'accept', content };
      },
      vscodeUserDir: () => path.resolve(ctx.globalStorageUri.fsPath, '..', '..'),
      onChange: () => { clearTimeout(mcpTimer); mcpTimer = setTimeout(() => mcpChanged(), 400); }
    }
  });
  tools.checkpoints = new Checkpoints(path.join(ctx.globalStorageUri.fsPath, 'checkpoints'));
  ctx.subscriptions.push({ dispose: () => tools.dispose() });
  // Running the project: a terminal tab per run, web pages in the Simple Browser beside the chat.
  wireRuns(ctx, tools);

  // Edit review: a change the model makes opens as a diff (current file | proposed) to accept or reject. The proposed side
  // is a real file, so single changes can be reverted with the arrows in the diff's margin (or edited) before accepting:
  // the file then gets what the user left.
  const proposed = new Map<string, string>();
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('agentic-proposed', {
    provideTextDocumentContent: uri => proposed.get(uri.query) ?? ''
  }));
  const proposedDir = path.join(ctx.globalStorageUri.fsPath, 'proposed');
  try { fs.rmSync(proposedDir, { recursive: true, force: true }); } catch { /* in use */ }
  let reviewing: Promise<unknown> = Promise.resolve();
  tools.reviewChange = (full, before, after, existed) => {
    // One review at a time: parallel edits wait their turn.
    const run = reviewing.then(async (): Promise<boolean | string> => {
      const id = crypto.randomBytes(8).toString('hex');
      const name = path.basename(full);
      const dir = path.join(proposedDir, id), tmp = path.join(dir, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(tmp, after, 'utf8');
      proposed.set(id + 'b', before);
      const right = vscode.Uri.file(tmp);
      const left = existed ? vscode.Uri.file(full) : vscode.Uri.from({ scheme: 'agentic-proposed', path: '/' + name, query: id + 'b' });
      try {
        await vscode.commands.executeCommand('vscode.diff', left, right, `${name}: proposed change (Agentic)`, { preview: true });
        const pick = await vscode.window.showInformationMessage(
          `Agentic wants to ${existed ? 'change' : 'create'} ${vscode.workspace.asRelativePath(full)}. To leave out a change, revert it with the arrow in the diff's margin (or edit the right side), then Accept.`,
          'Accept', 'Reject');
        if (pick !== 'Accept') return false;
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === right.fsPath);
        const text = doc ? doc.getText() : fs.readFileSync(tmp, 'utf8');
        return text === after ? true : text;
      } finally {
        proposed.delete(id + 'b');
        // The proposed file: saved first when changed (its tab then closes without asking), then removed.
        const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === right.fsPath);
        if (doc && doc.isDirty) await doc.save().then(() => { }, () => { });
        for (const g of vscode.window.tabGroups.all) for (const t of g.tabs) {
          const inp = t.input as { modified?: vscode.Uri } | undefined;
          if (inp && inp.modified && inp.modified.fsPath === right.fsPath) await vscode.window.tabGroups.close(t).then(() => { }, () => { });
        }
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* still open */ }
      }
    });
    reviewing = run.catch(() => { });
    return run;
  };

  // The IDE bridge: the Agentic CLI in a terminal here (/ide) sees the open file, the selection and problems, and shows its
  // edits as diffs here (agentic.ide.bridge).
  const ide = new IdeServer(() => tools.roots(), version, (f, b, a, e) => tools.reviewChange!(f, b, a, e), log);
  ctx.subscriptions.push(ide);
  if (vscode.workspace.getConfiguration('agentic').get<boolean>('ide.bridge', true)) void ide.start().catch(e => log('IDE bridge failed: ' + (e && e.message || e)));

  const token = crypto.randomBytes(24).toString('hex');
  const media = (name: string) => path.join(ctx.extensionPath, 'media', name);
  const staticTypes: Record<string, string> = { 'layer.js': 'text/javascript; charset=utf-8', 'layer.css': 'text/css; charset=utf-8' };
  proxy = new LocalProxy({
    baseUrl: () => config.baseUrl(),
    apiKey: () => config.apiKey(),
    token,
    headTags: () =>
      `  <meta name="vscode-token" content="${token}">\n` +
      `  <meta name="vscode-version" content="${version}">\n` +
      `  <meta name="vscode-device" content="${escapeAttr(config.deviceId())}">\n` +
      `  <meta name="vscode-machine" content="${escapeAttr(config.machineName())}">\n` +
      '  <link rel="stylesheet" href="/vscode/layer.css">\n' +
      '  <script src="/vscode/layer.js" defer></script>\n',
    staticFile: name => {
      const type = staticTypes[name];
      if (!type) return undefined;
      try { return { body: fs.readFileSync(media(name)), type }; } catch { return undefined; }
    },
    // views is created below; the notification check runs later, when the page asks.
    local: localApi(tools, config, version, log, () => views.anyVisible, undefined, { logs: () => logLines.join('\n'), editor: () => ide.editor() }),
    log
  });
  const p = proxy;

  // The right (secondary) side bar takes views from VS Code 1.106 on, as Claude Code and Codex use it; earlier, the left activity bar.
  const [major, minor] = vscode.version.split('.').map(n => parseInt(n, 10) || 0);
  const secondarySidebar = major > 1 || (major === 1 && minor >= 106);
  void vscode.commands.executeCommand('setContext', 'agentic:noSecondarySidebar', !secondarySidebar);
  const views: ChatViews = new ChatViews(ctx, {
    ready: () => config.ready(),
    serverLabel: () => config.baseUrl(),
    motion: () => motionChoice(),
    pageUrl: async () => {
      try {
        await p.start();
        // Lite mode: the chat only, looking like Claude Code (the layer reads ?lite).
        const local = vscode.Uri.parse(`http://127.0.0.1:${p.port}/chat?lite=${chatMode() === 'lite' ? 1 : 0}`);
        return (await vscode.env.asExternalUri(local)).toString(true);
      } catch (e: any) {
        log('local server failed: ' + (e && e.message || e));
        return undefined;
      }
    },
    onPageMessage: (m: FromPage) => {
      if (m.type === 'ready') {
        log(`chat page ready (${config.baseUrl()})`);
        if (pendingFullPath && chatMode() === 'full') { const path = pendingFullPath; pendingFullPath = undefined; if (!/^\/chat(\/|$)/.test(path)) void views.post({ type: 'navigate', path }); }
      }
      // Multitask asked for in the side bar (too narrow for it): open it in a wide editor tab.
      else if (m.type === 'openMultitask') void vscode.commands.executeCommand('agentic.openMultitask');
      else if (m.type === 'multitaskNarrow') void multitaskTooNarrow();
      // The Lite chip / Full app button in the page: switch the mode (the views reload with the other look).
      else if (m.type === 'openLite') void setChatMode('lite');
      else if (m.type === 'openFull') void setChatMode('full', typeof m.path === 'string' ? m.path : undefined);
    }
  }, secondarySidebar);
  for (const id of ChatViews.viewIds) ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(id, views, { webviewOptions: { retainContextWhenHidden: true } }));

  // ------------------------------------------------------------------ status bar
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const updateStatus = () => {
    if (config.ready()) {
      status.text = '$(sparkle) Agentic';
      status.tooltip = `Agentic: ${config.baseUrl()}\nClick to open the chat (Ctrl+Alt+A).`;
      status.command = 'agentic.openChat';
    } else {
      status.text = '$(sparkle) Agentic: Sign in';
      status.tooltip = 'Sign in to your Agentic server';
      status.command = 'agentic.signIn';
    }
    status.show();
  };
  updateStatus();
  ctx.subscriptions.push(status);
  ctx.subscriptions.push(config.onDidChange(() => { updateStatus(); void views.refresh(); }));
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('agentic.chat.animations') || e.affectsConfiguration('workbench.reduceMotion')) void views.broadcast({ type: 'motion', motion: motionChoice() });
    if (e.affectsConfiguration('agentic.chat.mode')) { void vscode.commands.executeCommand('setContext', 'agentic.liteMode', chatMode() === 'lite'); void views.refresh(); }
  }));
  void vscode.commands.executeCommand('setContext', 'agentic.liteMode', chatMode() === 'lite');

  const updater = new Updater(ctx, config, log);
  ctx.subscriptions.push(updater);
  updater.start();

  // Multitask (up to four chats side by side) needs a wide page: the editor area, not the side bar.
  const multitaskTooNarrow = async () => {
    const pick = await vscode.window.showInformationMessage('Agentic: multitask needs a wider view (900 px). Maximize the Agentic tab?', 'Maximize');
    if (!pick) return;
    for (const cmd of ['workbench.action.maximizeEditorHideSidebar', 'workbench.action.toggleMaximizeEditorGroup']) {
      try { await vscode.commands.executeCommand(cmd); break; } catch { /* older VS Code */ }
    }
    setTimeout(() => { void views.postToPanel({ type: 'multitask' }); }, 400);
  };

  // ------------------------------------------------------------------ commands
  const sendNow = () => vscode.workspace.getConfiguration('agentic').get<boolean>('chat.sendSelectionCommandsImmediately', true);
  const needSignIn = async (): Promise<boolean> => {
    if (config.ready()) return false;
    const pick = await vscode.window.showInformationMessage('Sign in to your Agentic server first.', 'Sign In');
    if (pick) await vscode.commands.executeCommand('agentic.signIn');
    return !config.ready();
  };
  const reg = (id: string, fn: (...args: any[]) => unknown) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // Lite mode (the chat only, like Claude Code) or the full app: a setting, so the choice stays; the views reload with it.
  reg('agentic.liteMode', () => setChatMode('lite'));
  reg('agentic.fullMode', () => setChatMode('full'));
  reg('agentic.toggleChatMode', () => setChatMode(chatMode() === 'lite' ? 'full' : 'lite'));

  reg('agentic.openChat', () => vscode.commands.executeCommand(`${views.viewId}.focus`));
  reg('agentic.openChatInEditor', () => views.openPanel());
  reg('agentic.newChat', async () => { if (!await needSignIn()) await views.post({ type: 'newChat' }); });
  reg('agentic.reload', () => views.refresh());
  reg('agentic.checkForUpdates', () => updater.check(true));
  reg('agentic.openMultitask', async () => {
    if (await needSignIn()) return;
    views.openPanel(vscode.ViewColumn.Active);
    await views.postToPanel({ type: 'multitask' });
  });
  reg('agentic.showLog', () => out.show());
  // Every shortcut can be changed: the chat's own (saved to the Agentic account) or VS Code's for these commands (keybindings.json).
  reg('agentic.keyboardShortcuts', async () => {
    const pick = await vscode.window.showQuickPick([
      { id: 'chat', label: '$(comment-discussion) In the chat', description: 'send, new line, new chat, command palette, multitask …',
        detail: 'Saved to your Agentic account: the same in the browser and the desktop app.' },
      { id: 'vscode', label: '$(keyboard) VS Code commands', description: 'open the chat, ask about the selection, new chat …',
        detail: "VS Code's Keyboard Shortcuts, showing only Agentic's commands." }
    ], { placeHolder: 'Which shortcuts do you want to change?' });
    if (!pick) return;
    if (pick.id === 'vscode') { await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', `@ext:${ctx.extension.id}`); return; }
    if (!await needSignIn()) await views.post({ type: 'shortcuts' });
  });
  reg('agentic.openInBrowser', () => {
    const base = config.baseUrl();
    if (!base) { void vscode.commands.executeCommand('agentic.signIn'); return; }
    void vscode.env.openExternal(vscode.Uri.parse(base + '/chat'));
  });
  // Artifacts: the projects of this workspace and the pages from your chats, to run or share (a wide editor tab).
  reg('agentic.openArtifacts', async () => {
    if (await needSignIn()) return;
    views.openPanel();
    await views.postToPanel({ type: 'navigate', path: '/artifacts' });
  });
  // MCP servers: their page (a wide editor tab), and a notice when a project's server waits to be allowed - it would run a
  // command or reach a URL named in the repository's files.
  const openMcp = async () => { if (await needSignIn()) return; views.openPanel(); await views.postToPanel({ type: 'navigate', path: '/local/mcp' }); };
  reg('agentic.mcpServers', openMcp);
  reg('agentic.addMcpServer', openMcp);
  const askedMcp = new Set<string>();
  const checkMcpApprovals = () => {
    for (const s of tools.mcp.snapshot()) {
      if (s.state !== 'approval' || s.denied || askedMcp.has(s.id)) continue;
      askedMcp.add(s.id);
      const what = s.transport === 'stdio' ? `runs ${[s.command, ...(s.args || [])].join(' ').slice(0, 120)}` : `connects to ${s.url}`;
      void vscode.window.showWarningMessage(`This project's ${String(s.source).replace(/^Project /, '')} adds the MCP server "${s.name}" (it ${what}). Start it for the chat?`,
        'Allow', "Don't allow", 'MCP Servers').then(async pick => {
          if (pick === 'Allow') await tools.mcp.setApproval(s.id, true);
          else if (pick === "Don't allow") await tools.mcp.setApproval(s.id, false);
          else if (pick) await openMcp();
        });
    }
  };
  mcpChanged = () => { void views.post({ type: 'mcpChanged' }); void views.postToPanel({ type: 'mcpChanged' }); checkMcpApprovals(); };
  // The servers start in the background now, so the first message has their tools.
  setTimeout(() => { if (tools.enabled) tools.mcp.ensure(0).then(checkMcpApprovals, () => { }); }, 1500);
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { if (tools.enabled) tools.mcp.ensure(0).then(checkMcpApprovals, () => { }); }));
  // The Images, Music and Audio tabs of the web app, in a wide editor tab (the side bar is too narrow for them).
  for (const [id, path] of [['agentic.openImages', '/images'], ['agentic.openMusic', '/music'], ['agentic.openAudio', '/audio']]) {
    reg(id, async () => {
      if (await needSignIn()) return;
      views.openPanel();
      await views.postToPanel({ type: 'navigate', path });
    });
  }

  reg('agentic.signIn', async (opts?: { reason?: string }) => {
    if (opts && opts.reason === 'refused') {
      const pick = await vscode.window.showWarningMessage('The Agentic server refused the API key.', 'Sign In Again');
      if (!pick) return;
    }
    const url = await vscode.window.showInputBox({
      title: 'Agentic: Sign In (1/2)', prompt: 'Address of your Agentic server', ignoreFocusOut: true,
      value: config.baseUrl() || 'https://', placeHolder: 'https://agentic.example.com',
      validateInput: v => /^https?:\/\/[^/\s]+/i.test(normalizeUrl(v)) ? undefined : 'Enter the server address, e.g. https://agentic.example.com'
    });
    if (!url) return;
    const key = await vscode.window.showInputBox({
      title: 'Agentic: Sign In (2/2)', prompt: 'API key (Agentic web app → your account → API keys)', password: true, ignoreFocusOut: true,
      validateInput: v => v.trim().length >= 8 ? undefined : 'Paste the API key'
    });
    if (!key) return;
    const base = normalizeUrl(url);
    const check = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Agentic: checking the sign-in…' },
      () => verifyKey(base, key.trim()));
    if (!check.ok) {
      const again = check.status === 401 || check.status === 403 ? 'Try Again' : 'Save Anyway';
      const pick = await vscode.window.showErrorMessage(`Agentic: ${check.message}`, again);
      if (pick === 'Try Again') { void vscode.commands.executeCommand('agentic.signIn'); return; }
      if (pick !== 'Save Anyway') return;
    }
    await config.save(base, key.trim());
    log(`signed in to ${base}${check.ok ? ` as ${check.user || 'the key\'s account'}` : ' (not verified)'}`);
    void vscode.window.showInformationMessage(`Agentic: signed in to ${base}.`);
    await vscode.commands.executeCommand(`${views.viewId}.focus`);
  });

  reg('agentic.signOut', async () => {
    const pick = await vscode.window.showWarningMessage('Sign out of Agentic? The API key is removed from VS Code.', { modal: true }, 'Sign Out');
    if (pick !== 'Sign Out') return;
    await config.signOut();
    void vscode.window.showInformationMessage('Agentic: signed out.');
  });

  reg('agentic.askAboutSelection', async () => {
    if (await needSignIn()) return;
    const s = editorSnippet();
    if (!s) { await views.post({ type: 'newChat' }); return; }
    await views.post({ type: 'insert', text: `${s.where}:\n${s.block}\n\n`, append: true });
  });

  reg('agentic.explainSelection', async () => {
    if (await needSignIn()) return;
    const s = editorSnippet(true);
    if (!s) { void vscode.window.showInformationMessage('Agentic: open a file and select some code first.'); return; }
    await views.post({ type: 'insert', newChat: true, send: sendNow(), text: `Explain this code from ${s.where}: what it does, how, and anything surprising.\n${s.block}` });
  });

  reg('agentic.fixSelection', async () => {
    if (await needSignIn()) return;
    const s = editorSnippet(true);
    if (!s) { void vscode.window.showInformationMessage('Agentic: open a file and select some code first.'); return; }
    const problems = problemsIn(s.uri, s.range);
    await views.post({
      type: 'insert', newChat: true, send: sendNow(),
      text: `Fix this code in ${s.where}.${problems ? `\nVS Code reports:\n${problems}` : ''}\n${s.block}\n` +
        'Apply the fix in the file with edit_file, then check vscode_diagnostics and tell me what you changed.'
    });
  });

  // The light bulb: "Fix with Agentic" on a problem, and "Explain" / "Fix" on a selection (agentic.codeActions).
  reg('agentic.fixDiagnostic', async (uri?: vscode.Uri, range?: vscode.Range, message?: string, source?: string) => {
    if (await needSignIn()) return;
    if (!uri || !range) return;
    const doc = await vscode.workspace.openTextDocument(uri);
    const start = Math.max(0, range.start.line - 3), end = Math.min(doc.lineCount - 1, range.end.line + 3);
    const code = doc.getText(new vscode.Range(start, 0, end, doc.lineAt(end).text.length));
    const rel = vscode.workspace.asRelativePath(uri);
    await views.post({
      type: 'insert', newChat: true, send: sendNow(),
      text: `Fix this problem VS Code reports in \`${rel}\` at line ${range.start.line + 1}: ${message || ''}${source ? ` [${source}]` : ''}\n` +
        `Lines ${start + 1}-${end + 1}:\n${fence(code, doc.languageId)}\n` +
        'Read the file, fix the cause with edit_file, then check vscode_diagnostics and tell me what you changed.'
    });
  });
  const agenticKind = vscode.CodeActionKind.Refactor.append('agentic');
  ctx.subscriptions.push(vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, {
    provideCodeActions(doc, range, context) {
      if (!vscode.workspace.getConfiguration('agentic').get<boolean>('codeActions.enabled', true)) return [];
      const actions: vscode.CodeAction[] = [];
      for (const d of context.diagnostics.filter(x => x.severity <= vscode.DiagnosticSeverity.Warning).slice(0, 3)) {
        const msg = d.message.split('\n')[0];
        const a = new vscode.CodeAction(`Fix with Agentic: ${msg.length > 60 ? msg.slice(0, 59) + '…' : msg}`, vscode.CodeActionKind.QuickFix);
        a.command = { command: 'agentic.fixDiagnostic', title: 'Fix with Agentic', arguments: [doc.uri, d.range, d.message, d.source || ''] };
        a.diagnostics = [d];
        actions.push(a);
      }
      if (!range.isEmpty) {
        const explain = new vscode.CodeAction('Explain with Agentic', agenticKind);
        explain.command = { command: 'agentic.explainSelection', title: 'Explain with Agentic' };
        const fix = new vscode.CodeAction('Fix with Agentic', agenticKind);
        fix.command = { command: 'agentic.fixSelection', title: 'Fix with Agentic' };
        actions.push(explain, fix);
      }
      return actions;
    }
  }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, agenticKind] }));

  reg('agentic.reviewFile', async (uri?: vscode.Uri) => {
    if (await needSignIn()) return;
    const target = fileUri(uri);
    if (!target) { void vscode.window.showInformationMessage('Agentic: open a file to review.'); return; }
    const rel = vscode.workspace.asRelativePath(target);
    await views.post({
      type: 'insert', newChat: true, send: sendNow(),
      text: `Review \`${rel}\` for bugs, security problems, error handling and readability. Read it with read_file first; ` +
        'list the findings by severity with line numbers, and do not change anything yet.'
    });
  });

  reg('agentic.fixProblems', async (uri?: vscode.Uri) => {
    if (await needSignIn()) return;
    const target = fileUri(uri);
    if (!target) { void vscode.window.showInformationMessage('Agentic: open a file first.'); return; }
    const problems = problemsIn(target);
    const rel = vscode.workspace.asRelativePath(target);
    if (!problems) { void vscode.window.showInformationMessage(`Agentic: VS Code reports no problems in ${rel}.`); return; }
    await views.post({
      type: 'insert', newChat: true, send: sendNow(),
      text: `Fix the problems VS Code reports in \`${rel}\`:\n${problems}\n` +
        'Read the file, fix them with edit_file, then check vscode_diagnostics again and tell me what you changed.'
    });
  });

  reg('agentic.addFileToChat', async (uri?: vscode.Uri) => {
    if (await needSignIn()) return;
    const target = fileUri(uri);
    if (!target) { void vscode.window.showInformationMessage('Agentic: choose a file to add.'); return; }
    let bytes: Uint8Array;
    const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === target.toString());
    try { bytes = open ? Buffer.from(open.getText(), 'utf8') : await vscode.workspace.fs.readFile(target); }
    catch (e: any) { void vscode.window.showErrorMessage('Agentic: ' + (e && e.message || e)); return; }
    if (bytes.length > 10 * 1024 * 1024) { void vscode.window.showWarningMessage('Agentic: the file is larger than 10 MB.'); return; }
    await views.post({
      type: 'attach', name: path.basename(target.fsPath), mime: mimeOf(target.fsPath),
      data: Buffer.from(bytes).toString('base64'), text: `\`${vscode.workspace.asRelativePath(target)}\` `
    });
  });

  // First run with nothing set up: offer to sign in once.
  if (!config.ready() && !ctx.globalState.get<boolean>('agentic.welcomed')) {
    void ctx.globalState.update('agentic.welcomed', true);
    void vscode.window.showInformationMessage('Agentic: sign in to your Agentic server to chat in VS Code.', 'Sign In')
      .then(pick => { if (pick) void vscode.commands.executeCommand('agentic.signIn'); });
  }
  log(`Agentic ${version} ready (${config.baseUrl() || 'no server set'})`);
}

export function deactivate(): void {
  proxy?.stop();
  proxy = undefined;
}

// ------------------------------------------------------------------ helpers

/** Page animations: the setting (calm by default), or none when VS Code is set to reduce motion. */
function motionChoice(): string {
  if (vscode.workspace.getConfiguration('workbench').get<string>('reduceMotion') === 'on') return 'off';
  const c = vscode.workspace.getConfiguration('agentic').get<string>('chat.animations', 'calm');
  return c === 'full' || c === 'off' ? c : 'calm';
}

/** The selected code (or, with wholeFileIfEmpty, the whole file) of the active editor as a fenced block. */
function editorSnippet(wholeFileIfEmpty = false): { where: string; block: string; uri: vscode.Uri; range: vscode.Range } | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return undefined;
  const doc = ed.document;
  let range: vscode.Range = ed.selection;
  if (ed.selection.isEmpty) {
    if (!wholeFileIfEmpty) {
      const line = ed.selection.active.line;
      const rel = doc.uri.scheme === 'file' ? vscode.workspace.asRelativePath(doc.uri) : doc.fileName;
      return { where: `\`${rel}\` (line ${line + 1})`, block: fence(doc.lineAt(line).text, doc.languageId), uri: doc.uri, range: doc.lineAt(line).range };
    }
    if (doc.lineCount > 3000) return undefined;
    range = new vscode.Range(0, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length);
  }
  const rel = doc.uri.scheme === 'file' ? vscode.workspace.asRelativePath(doc.uri) : doc.fileName;
  const lines = range.start.line === range.end.line ? `line ${range.start.line + 1}` : `lines ${range.start.line + 1}-${range.end.line + 1}`;
  return { where: `\`${rel}\` (${lines})`, block: fence(doc.getText(range), doc.languageId), uri: doc.uri, range };
}

function fence(code: string, lang: string): string {
  const ticks = code.includes('```') ? '````' : '```';
  return `${ticks}${lang}\n${code.replace(/\s+$/, '')}\n${ticks}`;
}

/** Errors and warnings VS Code reports for a file (within a range, if given), one per line. */
function problemsIn(uri: vscode.Uri, range?: vscode.Range): string {
  return vscode.languages.getDiagnostics(uri)
    .filter(d => d.severity <= vscode.DiagnosticSeverity.Warning && (!range || range.intersection(d.range)))
    .slice(0, 50)
    .map(d => `- line ${d.range.start.line + 1}: ${d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning'}: ${d.message}${d.source ? ` [${d.source}]` : ''}`)
    .join('\n');
}

function fileUri(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri instanceof vscode.Uri) return uri;
  const ed = vscode.window.activeTextEditor;
  return ed && !ed.document.isUntitled ? ed.document.uri : undefined;
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.json': 'application/json', '.md': 'text/markdown', '.html': 'text/html', '.csv': 'text/csv', '.xml': 'application/xml'
};
function mimeOf(file: string): string { return MIME[path.extname(file).toLowerCase()] || 'text/plain'; }

function escapeAttr(s: string): string { return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)); }

/** Checks the key against the server (GET /api/chat/meta, which any account may read). */
async function verifyKey(base: string, key: string): Promise<{ ok: boolean; status?: number; message: string; user?: string }> {
  try {
    const res = await fetch(base + '/api/chat/meta', { headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (res.ok) return { ok: true, status: res.status, message: 'ok' };
    if (res.status === 401 || res.status === 403) return { ok: false, status: res.status, message: 'the server refused the API key.' };
    return { ok: false, status: res.status, message: `the server answered HTTP ${res.status}.` };
  } catch (e: any) {
    return { ok: false, message: `cannot reach ${base}: ${e && (e.cause && e.cause.message || e.message) || e}` };
  }
}
