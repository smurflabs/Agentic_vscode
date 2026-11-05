/**
 * /api/local/* — what the VS Code layer in the chat page asks of the extension (with the per-launch token):
 *   GET  info                  this VS Code: device id, name, workspace folders, version
 *   POST chat/prepare          the tools and instructions for one chat message
 *   POST chat/run              runs one tool call {name, arguments}
 *   POST signin                the server refused the key: ask the user to sign in again
 *   POST open                  opens a file {path, line, find} in the editor (find: text to select, an edit's first line)
 *   POST chat/turn             an answer to this question starts {chatId, messageId} (code checkpoints for Rewind)
 *   POST chat/checkpoints      the files each question's answer changed {chatId}
 *   POST chat/restore          puts those files back {chatId, messageIds}
 *   POST chat/agentic          the project's AGENTIC.md: {} reads it, {content} writes it
 *   POST chat/files            workspace files matching {query} (the @ list in the message box)
 *   POST chat/commands         the custom slash commands (.agentic/commands, .claude/commands)
 *   POST chat/stop             runs the Stop hooks after an answer; {followUp} when one asks for more work
 *   POST workspace/add         adds a folder to the workspace {path} (/add-dir)
 *   POST clipboard             copies {text} (copy buttons in the chat)
 *   POST mcp/list, mcp/save, mcp/action  the MCP Servers page: servers from every source; add, switch on/off, allow, sign in, try a tool
 *   POST doctor                checks of this VS Code's tools, MCP servers, hooks and skills
 *   POST chat/usage            an answer finished: its tokens go to the log npx ccusage reads {chatId, message, cachedTokens}
 *   POST notify                an answer finished or a chat needs you {title, body}: a VS Code notification, unless the chat is in view
 *   GET  run/configs           how the project runs (.agentic/launch.json, .claude/launch.json or its files)
 *   POST run/start|stop        starts or stops one {id}; GET run/status: what runs; POST run/log {id, from}: its output
 *   POST run/preview           shows a page {url} beside the chat; POST run/edit: opens .agentic/launch.json
 *   GET  run/projects          the workspace folders and what each can share; POST run/share {id}: a project's website as a link
 *   POST open-url              opens {url} (http/https) in the default browser
 *   POST chat/review-apply     Apply on a code block: {path, content} as a diff to accept (single changes can be reverted), then written
 *   POST editor/insert         Insert at the cursor: {code} into the editor the user was in
 *   POST chat/plugins          /plugin: {action: list | enable | disable | install | uninstall | marketplace-add | -remove | -update}
 *   POST logs                  /feedback: the latest lines of the extension's log
 *   POST speech/listen         Dictation mode: records one turn from the microphone and answers its text {silenceMs, maxTurnSeconds,
 *                              noSpeechSeconds, sensitivity, language}; GET speech/state: {state, level}; POST speech/stop {discard}:
 *                              ends the turn now; POST speech/release: closes the microphone
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { LocalHandler } from './proxy';
import { WorkspaceTools } from './tools/workspaceTools';
import { AgenticConfig } from './config';
import { recordUsage } from './tools/usageLog';
import { SpeechInput } from './speech';
import { agentDefs, diffOf, PromptHooks, saveAgent, worktreeCommand } from './tools/gaps';
import { ClaudeCode, claudeStatus } from './claudeCode';
import { pluginAction } from './tools/plugins';

/** A recording (WAV) as text: the Agentic server's speech-to-text (/api/chat/transcribe), as the signed-in user. */
export async function transcribe(config: AgenticConfig, wav: Buffer, language: string): Promise<string> {
  const base = config.baseUrl(), key = config.apiKey();
  if (!base || !key) throw new Error('Sign in to the Agentic server first (Agentic: Sign In).');
  const res = await fetch(`${base}/api/chat/transcribe?name=speech.wav&language=${encodeURIComponent(language || 'en')}`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/octet-stream' }, body: wav
  });
  const text = await res.text();
  let data: any = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) throw new Error((data && data.error && (data.error.message || data.error)) || `Speech to text failed (HTTP ${res.status}).`);
  return String(data && data.text || '');
}

export function localApi(tools: WorkspaceTools, config: AgenticConfig, version: string, log: (s: string) => void,
  chatVisible: () => boolean = () => false,
  speech: SpeechInput = new SpeechInput(() => vscode.workspace.getConfiguration('agentic').get<string>('speech.recorder') || process.env.AGENTIC_VSCODE_RECORDER, log),
  extra: { logs?: () => string; editor?: () => vscode.TextEditor | undefined } = {}): LocalHandler {
  const promptHooks = new PromptHooks(tools);
  const claude = new ClaudeCode();
  return async (method, route, body) => {
    switch (`${method} ${route}`) {
      // Claude Code as a model in the chat (like the desktop app): is it installed, one message (events streamed), its
      // permission prompts answered, and stop.
      case 'GET claude':
        return { json: await claudeStatus() };
      case 'POST claude/run':
        return {
          stream: async (write, signal) => {
            log('claude run');
            await claude.run(body || {}, tools.roots()[0] || '', line => write(`data: ${line}\n\n`), signal);
          }
        };
      case 'POST claude/respond':
        return { json: { delivered: claude.respond(body || {}) } };
      case 'POST claude/interrupt':
        return { json: { stopped: claude.interrupt(String(body && body.runId || '')) } };
      case 'GET info':
        return {
          json: {
            device: config.deviceId(), machine: config.machineName(), version,
            workspaces: tools.roots(), toolsEnabled: tools.enabled, commands: tools.allowCommands
          }
        };
      case 'POST chat/prepare': {
        const content = String(body && body.content || '');
        // What UserPromptSubmit / SessionStart hooks printed goes with this message; your own subagent types go to the task tool.
        const extra = content ? promptHooks.take() : '';
        const agents = tools.enabled ? agentDefs(tools.roots()).map(a => ({ name: a.name, description: a.description, tools: a.tools, prompt: a.prompt })) : [];
        // rules: Claude Code's permission rules from the settings files, for the server to apply to this message.
        const r = tools.enabled ? tools.rules() : null;
        return { json: { tools: await tools.allDefinitions(), instructions: await tools.allInstructions(content) + extra, device: config.deviceId(), agents,
          rules: r && (r.allow.length || r.ask.length || r.deny.length) ? { allow: r.allow, ask: r.ask, deny: r.deny } : undefined } };
      }
      case 'POST chat/check-prompt':
        return { json: tools.enabled ? await promptHooks.check(String(body && body.content || ''), body && body.chatId ? String(body.chatId) : undefined) : {} };
      case 'POST chat/jobs':
        return { json: tools.background.entries() };
      case 'POST chat/job-stop': {
        const text = tools.stopCommand(String(body && body.id || ''));
        return { json: { stopped: text.startsWith('Stopped'), message: text } };
      }
      case 'POST chat/hooks':
        return { json: tools.hooks.list() };
      case 'POST chat/hook-save':
        try { return { json: { file: tools.hooks.save(String(body.scope || 'project'), String(body.event || ''), String(body.matcher || ''), String(body.command || ''), Number(body.timeout) || 0) } }; }
        catch (e: any) { return { status: 400, json: { error: { message: e.message || String(e) } } }; }
      case 'POST chat/hook-remove':
        try { return { json: { removed: tools.hooks.remove(String(body.file || ''), String(body.event || ''), String(body.matcher || ''), String(body.command || '')) } }; }
        catch (e: any) { return { status: 400, json: { error: { message: e.message || String(e) } } }; }
      case 'POST chat/hook-test':
        return { json: await tools.hooks.test(String(body.event || 'PreToolUse'), String(body.command || '')) };
      case 'POST chat/skills': {
        const skills = (await tools.skills.skills()).map(s => ({ name: s.name, description: s.description, kind: 'skill' }));
        const commands = (await tools.skills.commands()).map(c => ({ name: c.name, description: c.description, kind: 'command' }));
        return { json: [...skills, ...commands] };
      }
      case 'POST chat/agents':
        return { json: agentDefs(tools.roots()).map(a => ({ name: a.name, description: a.description, tools: a.tools, file: a.file, scope: a.scope })) };
      case 'POST chat/agent-save':
        try { return { json: { file: saveAgent(tools.roots(), body || {}) } }; }
        catch (e: any) { return { status: 400, json: { error: { message: e.message || String(e) } } }; }
      case 'POST chat/worktree':
        return { json: worktreeCommand(tools, String(body && body.arg || '')) };
      case 'POST chat/diff':
        return { json: diffOf(tools.roots()[0]) };
      case 'POST chat/run': {
        const name = String(body && body.name || '');
        if (!name) return { status: 400, json: { error: { message: 'name is required.' } } };
        log(`tool ${name}`);
        const r = await tools.run(name, body.arguments, body.chatId ? String(body.chatId) : undefined,
          { mode: typeof body.mode === 'string' ? body.mode : undefined, approved: !!body.approved, id: body.id ? String(body.id) : undefined });
        // image: a picture file it read, for the model (not added to the answer: the user has the file); images: pictures an
        // MCP tool made (a browser screenshot), shown with the answer too.
        if (r.images && r.images.length) return { json: { ok: r.ok, result: r.result, images: r.images.map(i => ({ ...i, show: true })) } };
        return { json: r.image ? { ...r, image: { ...r.image, show: false } } : r };
      }
      // The MCP Servers page and /mcp: every server from every source, and what can be done with each.
      case 'POST mcp/list':
        await tools.mcp.ensure(0).catch(() => { });
        return { json: { servers: tools.mcp.snapshot(), userFile: tools.mcp.userFile(), projectFile: tools.roots()[0] ? tools.mcp.projectFile() : '', roots: tools.roots() } };
      case 'POST mcp/save': {
        const b = body || {};
        try {
          if (b.previousId && b.previousId !== b.name) tools.mcp.remove(String(b.previousId));
          const id = tools.mcp.upsert(String(b.name || ''), b.entry || {}, b.scope === 'project' ? 'project' : 'user', b.root ? String(b.root) : undefined);
          await tools.mcp.ensure(20_000);
          return { json: { id, servers: tools.mcp.snapshot() } };
        } catch (e: any) { return { status: 400, json: { error: { message: e.message || String(e) } } }; }
      }
      case 'POST mcp/action': {
        const b = body || {}, id = String(b.id || '');
        try {
          switch (String(b.action || '')) {
            case 'remove': if (!tools.mcp.remove(id)) throw new Error('Only servers in Agentic\'s own files can be removed here; switch others off.'); break;
            case 'enable': await tools.mcp.setEnabled(id, true); break;
            case 'disable': await tools.mcp.setEnabled(id, false); break;
            case 'allow': await tools.mcp.setApproval(id, true); break;
            case 'deny': await tools.mcp.setApproval(id, false); break;
            case 'reconnect': await tools.mcp.reconnect(id); break;
            case 'signin': await tools.mcp.signIn(id); break;
            case 'signout': await tools.mcp.signOut(id); break;
            case 'input': await tools.mcp.setInput(String(b.input || ''), String(b.value ?? '')); break;
            case 'call': {
              const r = await tools.mcp.connection(id)?.callTool(String(b.tool || ''), b.args || {});
              return { json: r || { ok: false, result: 'Not connected.', images: [] } };
            }
            case 'open': {
              const s = tools.mcp.snapshot().find(x => x.id === id);
              const file: string = s ? s.file : b.scope === 'project' ? tools.mcp.projectFile() : tools.mcp.userFile();
              if (file && file !== 'settings.json') {
                if (!fs.existsSync(file)) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '{\n  "mcpServers": {}\n}\n'); }
                await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
              } else await vscode.commands.executeCommand('workbench.action.openSettingsJson');
              break;
            }
            default: throw new Error('Unknown action.');
          }
          await tools.mcp.ensure(b.action === 'enable' || b.action === 'allow' || b.action === 'input' ? 20_000 : 0);
          return { json: { servers: tools.mcp.snapshot() } };
        } catch (e: any) { return { status: 400, json: { error: { message: e.message || String(e) } } }; }
      }
      case 'POST chat/hook-event':
        // Something happened in an answer this window runs (a subagent, a compaction, a question): its hooks here.
        if (!tools.enabled) return { json: {} };
        try { return { json: await promptHooks.pageEvent(String(body && body.event || ''), body && body.chatId ? String(body.chatId) : undefined, (body && body.payload) || {}) }; }
        catch (e: any) { return { status: 400, json: { error: { message: e.message || String(e) } } }; }
      case 'POST chat/permission-request':
        // An approval for a tool in this workspace: PermissionRequest hooks may answer it first.
        return { json: tools.enabled ? await promptHooks.permission(body || {}) : {} };
      case 'POST chat/allow-path': {
        // The user allowed a path outside the workspace (a file, or its folder) for this window.
        const p = String(body && body.path || '');
        if (!p) return { status: 400, json: { error: { message: 'path is required.' } } };
        tools.allowPath(body.folder ? (fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : path.dirname(p)) : p);
        return { json: { ok: true } };
      }
      case 'POST chat/file-text':
        // A file's text as it is now, so an approval card can show an overwrite as a diff.
        return { json: { text: tools.enabled ? await tools.fileTextForApproval(String(body && body.path || '')) : null } };
      case 'POST chat/turn':
        tools.checkpoints?.beginTurn(String(body && body.chatId || ''), String(body && body.messageId || ''));
        return { json: { ok: true } };
      case 'POST chat/checkpoints':
        return { json: tools.checkpoints ? await tools.checkpoints.list(String(body && body.chatId || '')) : [] };
      case 'POST chat/restore': {
        if (!tools.checkpoints) return { status: 409, json: { error: { message: 'Checkpoints are not available.' } } };
        const ids = Array.isArray(body && body.messageIds) ? body.messageIds.map(String) : [];
        return { json: await tools.checkpoints.restore(String(body && body.chatId || ''), ids) };
      }
      case 'POST chat/agentic': {
        const p = await tools.agenticMdPath();
        if (!p) return { status: 409, json: { error: { message: 'Open a folder first: AGENTIC.md is kept in the project folder.' } } };
        if (body && typeof body.content === 'string') {
          await vscode.workspace.fs.writeFile(vscode.Uri.file(p), Buffer.from(body.content, 'utf8'));
        }
        const text = await vscode.workspace.fs.readFile(vscode.Uri.file(p)).then(b => Buffer.from(b).toString('utf8'), () => null);
        return { json: { path: p, exists: text !== null, content: text ?? '' } };
      }
      case 'POST chat/usage': {
        if (!vscode.workspace.getConfiguration('agentic').get<boolean>('usage.ccusageLog', true)) return { json: { logged: false } };
        const cwd = tools.roots()[0] || '';
        return { json: { logged: recordUsage(String(body && body.chatId || ''), cwd, version, (body && body.message) || {}, Number(body && body.cachedTokens) || 0) } };
      }
      case 'POST clipboard':
        // Copy buttons in the chat: the webview does not let the page use the clipboard.
        await vscode.env.clipboard.writeText(String(body && body.text || ''));
        return { json: { ok: true } };
      case 'POST chat/files':
        return { json: tools.enabled ? await tools.listFiles(String(body && body.query || '')) : [] };
      case 'POST chat/commands':
        // Custom commands, and the MCP servers' prompts (/mcp__server__prompt).
        return { json: tools.enabled ? [...await tools.skills.commands(), ...tools.mcp.promptCommands()] : [] };
      case 'POST chat/stop': {
        if (!tools.enabled) return { json: {} };
        const r = await tools.hooks.run('Stop', '', { chat_id: body && body.chatId, last_message: body && body.text, stop_hook_active: !!(body && body.active) });
        return { json: r.blocked && r.message ? { followUp: r.message } : {} };
      }
      case 'POST workspace/add':
        try { return { json: { path: tools.addFolder(String(body && body.path || '')) } }; }
        catch (e: any) { return { status: 400, json: { error: { message: e.message || String(e) } } }; }
      case 'POST doctor': {
        const rows: { ok: boolean; what: string; detail: string }[] = [];
        const roots = tools.roots();
        rows.push({ ok: tools.enabled, what: 'Workspace tools', detail: tools.enabled ? (roots.length ? roots.join(', ') : 'no folder open') : 'off (agentic.tools.enabled)' });
        rows.push({ ok: true, what: 'Commands', detail: tools.allowCommands ? 'allowed' : 'off (agentic.tools.allowCommands)' });
        rows.push({ ok: true, what: 'Edit review', detail: tools.reviewEdits ? 'changes open as a diff to accept or reject' : 'off (agentic.tools.reviewEdits)' });
        const md = await tools.agenticMdPath();
        rows.push({ ok: true, what: 'AGENTIC.md', detail: md ? (await vscode.workspace.fs.stat(vscode.Uri.file(md)).then(() => md, () => 'none yet (/init writes one)')) : 'no folder open' });
        if (tools.enabled) await tools.mcp.ensure().catch(() => { });
        const mcp = tools.mcp.status();
        rows.push({ ok: mcp.every(m => m.ok), what: 'Local MCP servers', detail: mcp.length ? mcp.map(m => `${m.name}: ${m.detail}`).join(', ') : 'none (.mcp.json)' });
        rows.push({ ok: true, what: 'Hooks', detail: String(tools.hooks.count()) + ' (.agentic/settings.json)' });
        const skills = await tools.skills.skills(), cmds = await tools.skills.commands();
        rows.push({ ok: true, what: 'Skills and commands', detail: `${skills.length} skills, ${cmds.length} commands` });
        rows.push({ ok: true, what: 'Version', detail: version });
        return { json: rows };
      }
      case 'POST notify': {
        // The page asks when it is in the background; the chat in view of a focused VS Code needs no notification.
        if (vscode.window.state.focused && chatVisible()) return { json: { ok: true, shown: false } };
        const title = String(body && body.title || 'Agentic').slice(0, 100);
        const text = String(body && body.body || '').slice(0, 200);
        void vscode.window.showInformationMessage(`Agentic · ${title}: ${text}`, 'Open Chat').then(pick => {
          if (pick === 'Open Chat') void vscode.commands.executeCommand('agentic.openChat');
        });
        return { json: { ok: true, shown: true } };
      }
      case 'POST signin':
        void vscode.commands.executeCommand('agentic.signIn', { reason: 'refused' });
        return { json: { ok: true } };
      // The Run chip in Chat (chatrun.js).
      case 'GET run/configs':
        return { json: { root: tools.roots()[0] || null, configs: tools.enabled ? tools.runner.configs() : [] } };
      case 'GET run/status':
        return { json: tools.runner.status() };
      case 'GET run/projects':
        return { json: tools.enabled ? tools.runner.projects() : [] };
      case 'POST run/share':
        try {
          if (!tools.enabled) throw new Error('Workspace tools are switched off in the VS Code settings (agentic.tools.enabled).');
          return { json: await tools.runner.share(String(body && body.id || '')) };
        } catch (e: any) {
          return { status: 400, json: { error: { message: e && e.message ? e.message : String(e) } } };
        }
      case 'POST open-url': {
        // Links the page opens outside VS Code (the Artifacts page: a shared link).
        const url = String(body && body.url || '');
        if (!/^https?:\/\//i.test(url)) return { status: 400, json: { error: { message: 'Not a web address.' } } };
        await vscode.env.openExternal(vscode.Uri.parse(url));
        return { json: { ok: true } };
      }
      case 'POST run/log':
        return { json: tools.runner.log(String(body && body.id || ''), Number(body && body.from) || 0) };
      case 'POST run/start':
      case 'POST run/stop':
      case 'POST run/preview':
      case 'POST run/edit':
        try {
          if (!tools.enabled) throw new Error('Workspace tools are switched off in the VS Code settings (agentic.tools.enabled).');
          if (route === 'run/start') return { json: { started: (await tools.runner.start(String(body && body.id || ''))).id } };
          if (route === 'run/stop') return { json: { stopped: tools.runner.stop(String(body && body.id || '')) } };
          if (route === 'run/preview') {
            const url = String(body && body.url || '');
            if (!/^https?:\/\//i.test(url)) throw new Error('Not a web address.');
            await tools.showPreview?.(url, String(body && body.title || ''));
            return { json: { shown: !!tools.showPreview } };
          }
          const file = tools.runner.ensureLaunchFile();
          await vscode.window.showTextDocument(vscode.Uri.file(file));
          return { json: { path: file } };
        } catch (e: any) {
          return { status: 400, json: { error: { message: e && e.message ? e.message : String(e) } } };
        }
      case 'POST open': {
        const r = await tools.run('open_file', { path: body && body.path, line: body && body.line, find: body && typeof body.find === 'string' ? body.find : '' });
        return { json: r };
      }
      // Apply on a code block in the chat: the change as a diff (single changes can be reverted there), written when accepted.
      case 'POST chat/review-apply': {
        if (!tools.enabled) return { status: 409, json: { error: { message: 'Workspace tools are switched off in the VS Code settings (agentic.tools.enabled).' } } };
        const p = String(body && body.path || '');
        if (!p) return { status: 400, json: { error: { message: 'path is required.' } } };
        return { json: await tools.applyFromChat(p, String(body && body.content || '')) };
      }
      // Insert at the cursor: a code block goes into the editor you were in (replacing its selection).
      case 'POST editor/insert': {
        const ed = (extra.editor && extra.editor()) || vscode.window.activeTextEditor || vscode.window.visibleTextEditors.find(e => e.document.uri.scheme === 'file');
        if (!ed) return { json: { ok: false, result: 'Open a file in the editor first, and put the cursor where the code goes.' } };
        const code = String(body && body.code || '');
        const done = await ed.edit(b => { for (const s of ed.selections) b.replace(s, code); });
        await vscode.window.showTextDocument(ed.document, { viewColumn: ed.viewColumn, preserveFocus: false });
        return { json: { ok: done, result: done ? `Inserted into ${vscode.workspace.asRelativePath(ed.document.uri)}` : 'VS Code did not insert it.' } };
      }
      // /plugin: Claude Code plugins (list, on or off, install from a marketplace, add a marketplace).
      case 'POST chat/plugins':
        try { return { json: await pluginAction(body || {}, tools.roots()) }; }
        catch (e: any) { return { status: 400, json: { error: { message: e && e.message ? e.message : String(e) } } }; }
      // /feedback: the latest lines of this extension's log.
      case 'POST logs':
        return { json: { text: extra.logs ? extra.logs().slice(-150_000) : '' } };
      // Dictation mode: the webview cannot use the microphone, so VS Code records it (speech.ts).
      case 'POST speech/listen':
        try {
          return { json: await speech.listen(body || {}, (wav, language) => transcribe(config, wav, language)) };
        } catch (e: any) {
          return { status: 409, json: { error: { message: e && e.message ? e.message : String(e) } } };
        }
      case 'GET speech/state':
        return { json: speech.state };
      case 'POST speech/stop':
        speech.stop(!!(body && body.discard));
        return { json: { ok: true } };
      case 'POST speech/release':
        speech.release();
        return { json: { ok: true } };
    }
    return { status: 404, json: { error: { message: `No local route ${method} /api/local/${route}.` } } };
  };
}
