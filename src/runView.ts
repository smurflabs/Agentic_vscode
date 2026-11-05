/**
 * The VS Code side of running the project (the Run chip in Chat, the model's preview tool, Agentic: Run Project…): each run
 * gets a terminal tab ("Agentic: Dev server") with its output as it comes - closing the tab stops it - and web pages open in
 * VS Code's Simple Browser beside the chat (forwarded when VS Code works on a remote machine).
 */
import * as vscode from 'vscode';
import { WorkspaceTools } from './tools/workspaceTools';
import { ProjectRunner, RunConfig } from './tools/runner';

interface Term { term: vscode.Terminal; write: vscode.EventEmitter<string>; open: boolean; pending: string; ended: boolean }

/** Shows a page in the Simple Browser beside the chat (the default browser when it is not there). */
export async function showPreview(url: string): Promise<void> {
  let uri = vscode.Uri.parse(url);
  try { uri = await vscode.env.asExternalUri(uri); } catch { /* a local address stays as it is */ }
  try {
    await vscode.commands.executeCommand('simpleBrowser.api.open', uri, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
  } catch {
    try { await vscode.commands.executeCommand('simpleBrowser.show', uri.toString()); } catch { await vscode.env.openExternal(uri); }
  }
}

/** A terminal tab for each run of the runner (its terminal by run id). */
export function attachTerminals(runner: ProjectRunner): Map<string, Term> {
  const terms = new Map<string, Term>();
  const emit = (t: Term, text: string) => {
    if (t.open) t.write.fire(text);
    else { t.pending += text; if (t.pending.length > 200_000) t.pending = t.pending.slice(-150_000); }
  };
  runner.hooks = {
    started: (cfg: RunConfig) => {
      const old = terms.get(cfg.id);
      if (old) { old.ended = true; terms.delete(cfg.id); old.term.dispose(); }
      const write = new vscode.EventEmitter<string>();
      const t: Term = { term: undefined as unknown as vscode.Terminal, write, open: false, pending: '', ended: false };
      const pty: vscode.Pseudoterminal = {
        onDidWrite: write.event,
        open: () => { t.open = true; if (t.pending) { write.fire(t.pending); t.pending = ''; } },
        // The user closed the tab: the run stops (not when a restart replaced it).
        close: () => { if (!t.ended) runner.stop(cfg.id); if (terms.get(cfg.id) === t) terms.delete(cfg.id); write.dispose(); }
      };
      t.term = vscode.window.createTerminal({ name: `Agentic: ${cfg.name}`, pty, iconPath: new vscode.ThemeIcon(cfg.kind === 'test' ? 'beaker' : cfg.kind === 'app' ? 'play' : 'globe') });
      terms.set(cfg.id, t);
      emit(t, `\x1b[2m> ${cfg.command || 'built-in server for ' + cfg.cwd}   (${cfg.cwd})\x1b[0m\r\n`);
    },
    output: (id, text) => { const t = terms.get(id); if (t) emit(t, text.replace(/\r?\n/g, '\r\n')); },
    ended: (id, code) => {
      const t = terms.get(id);
      if (!t || t.ended) return;
      t.ended = true;
      emit(t, `\r\n\x1b[2m[${code === 0 ? 'done' : code === -1 ? 'stopped' : 'exited with code ' + code}]\x1b[0m\r\n`);
    }
  };
  return terms;
}

export function wireRuns(ctx: vscode.ExtensionContext, tools: WorkspaceTools): void {
  const runner = tools.runner;
  const terms = attachTerminals(runner);
  tools.showPreview = (url: string) => showPreview(url);

  // Agentic: Run Project… - the same runs from the command palette.
  ctx.subscriptions.push(vscode.commands.registerCommand('agentic.runProject', async () => {
    const configs = runner.configs();
    const live = new Map(runner.status().filter(s => s.running).map(s => [s.id, s]));
    type Pick = vscode.QuickPickItem & { act: 'start' | 'stop' | 'stopAll' | 'edit' | 'share' | 'artifacts'; id?: string };
    const icon: Record<string, string> = { web: '$(globe)', static: '$(globe)', app: '$(play)', test: '$(beaker)' };
    const items: Pick[] = configs.map(c => ({
      label: `${icon[c.kind] || '$(play)'} ${c.name}`, description: c.command || 'built-in server',
      detail: live.has(c.id) ? `running${live.get(c.id)!.url ? ' at ' + live.get(c.id)!.url : ''} - pick it to show it` : undefined, act: 'start', id: c.id
    }));
    if (live.size) items.push({ label: '$(debug-stop) Stop everything that runs', act: 'stopAll' });
    for (const p of runner.projects().filter(x => x.share)) {
      items.push({ label: `$(link) Share ${p.name}`, description: `uploads ${p.share === '.' ? 'the folder' : p.share + '/'} and gives a link anyone can open`, act: 'share', id: p.id });
    }
    const root = tools.roots()[0];
    if (root) items.push({ label: '$(edit) Edit .agentic/launch.json', description: configs.length ? configs[0].source : 'written from what was found', act: 'edit' });
    items.push({ label: '$(package) All projects and artifacts…', description: 'run and share from the Artifacts page', act: 'artifacts' });
    if (!items.length) { void vscode.window.showInformationMessage('Open a folder first: Agentic runs the project in it.'); return; }
    const pick = await vscode.window.showQuickPick(items, { placeHolder: configs.length ? 'Run or test this project' : 'No way to run this project was found' });
    if (!pick) return;
    if (pick.act === 'stopAll') { runner.stopAll(); return; }
    if (pick.act === 'edit') { await vscode.window.showTextDocument(vscode.Uri.file(runner.ensureLaunchFile())); return; }
    if (pick.act === 'artifacts') { await vscode.commands.executeCommand('agentic.openArtifacts'); return; }
    if (pick.act === 'share') {
      try {
        const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Agentic: sharing the website…' }, () => runner.share(pick.id!));
        const link = r && (r.link || r);
        if (link && link.url) {
          await vscode.env.clipboard.writeText(link.url);
          const open = await vscode.window.showInformationMessage(`Agentic: ${r.updated ? 'link updated' : 'shared'} — ${link.url} (copied)`, 'Open');
          if (open) await vscode.env.openExternal(vscode.Uri.parse(link.url));
        }
      } catch (e) { void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e)); }
      return;
    }
    const running = pick.id ? live.get(pick.id) : undefined;
    if (running) { if (running.url) await showPreview(running.url); else terms.get(pick.id!)?.term.show(true); return; }
    try {
      const cfg = await runner.start(pick.id!);
      terms.get(cfg.id)?.term.show(true);
      if (cfg.kind !== 'web' && cfg.kind !== 'static') return;
      // A web app: its page opens once it has an address.
      for (let i = 0; i < 240; i++) {
        const s = runner.status().find(x => x.id === cfg.id);
        if (!s || !s.running) return;
        if (s.url) { await showPreview(s.url); return; }
        await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) {
      void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
    }
  }));
}
