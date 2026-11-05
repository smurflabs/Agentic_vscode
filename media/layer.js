'use strict';
/* Agentic VS Code layer. The chat view shows the Agentic web app itself (served through the extension, which adds the
   API key); this script adds what only VS Code can do:
   - tools in the open workspace (read, search, edit files through the editor; problems; the selection; commands;
     the Agentic API as you), offered to the model with every message (window.chatClient)
   - the same tools for chats started in the web app or the desktop app while this VS Code is open (device catalog)
   - editor commands: put text or a file into the message box, send it, start a new chat
   - VS Code's light or dark theme */
(function () {
  const meta = name => (document.querySelector(`meta[name="${name}"]`) || {}).content || '';
  const VS = { token: meta('vscode-token'), device: meta('vscode-device'), machine: meta('vscode-machine') || 'VS Code', version: meta('vscode-version') };
  const PREFS_KEY = 'vscode.chat';
  const inFrame = window.parent && window.parent !== window;
  // Chat in multitask mode shows panes: frames of this same page. Only the top page talks to VS Code.
  const pane = typeof IN_PANE !== 'undefined' && IN_PANE;

  document.documentElement.classList.add('vscode-app');

  /** Calls the extension's endpoints (/api/local/*) with this launch's token. */
  async function lapi(method, path, body) {
    const opts = { method, headers: { 'X-Vscode-Token': VS.token } };
    if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
    const res = await fetch('/api/local/' + path, opts);
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data && data.error ? (data.error.message || data.error) : res.statusText);
    return data;
  }
  const toHost = m => { if (inFrame && !pane) { try { window.parent.postMessage(Object.assign({ source: 'agentic-layer' }, m), '*'); } catch { /* gone */ } } };

  function prefs() {
    let p = null; try { p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); } catch { /* ignore */ }
    return Object.assign({ workspace: true }, p);
  }
  function savePrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* ignore */ } pushCatalog(); }

  // ------------------------------------------------------------------ sign-in: the key is VS Code's
  // There is no sign-in form here: a refused key asks VS Code to sign in again.
  window.showLogin = () => {
    lapi('POST', 'signin').catch(() => { });
    if (document.getElementById('vs-signin')) return;
    document.body.insertAdjacentHTML('beforeend', `<div id="vs-signin" class="vs-signin"><div><b>The Agentic server refused the API key.</b>
      <p>Sign in again from VS Code (Agentic: Sign In), then reload the chat.</p></div></div>`);
  };

  // ------------------------------------------------------------------ chat: tools in this workspace
  /** Asks whether a tool may use a path outside the workspace: 'file', 'folder' or null. */
  function askAccess(p, tool) {
    return new Promise(resolve => {
      if (typeof openModal !== 'function') { resolve(null); return; }
      const done = v => { delete ACTIONS['vs-access']; closeModal(); resolve(v); };
      ACTIONS['vs-access'] = el => done(el.dataset.choice || null);
      openModal('Outside the workspace', '<p>The model wants to use <code>' + esc(p) + '</code> (' + esc(tool) + '), which is outside this workspace.</p>',
        '<button class="btn" data-act="vs-access" data-choice="">Don\'t allow</button><button class="btn" data-act="vs-access" data-choice="file">Allow this</button>' +
        '<button class="btn primary" data-act="vs-access" data-choice="folder">Allow its folder</button>', 'narrow');
    });
  }
  async function prepareLocal(content) {
    if (!prefs().workspace) return { tools: [], instructions: '', device: VS.device };
    return lapi('POST', 'chat/prepare', { content: content || '' });
  }

  /** Tells the Agentic server what this VS Code offers, so chats started in the web or desktop app can use it while it is open. */
  let catalogTimer = 0;
  function pushCatalog() {
    clearTimeout(catalogTimer);
    catalogTimer = setTimeout(async () => {
      if (!VS.device || pane) return;
      try {
        const d = await prepareLocal();
        await fetch(`/api/chat/devices/${encodeURIComponent(VS.device)}/catalog`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: VS.machine, clientTools: d.tools, clientInstructions: d.instructions })
        });
      } catch { /* the server may be older or unreachable */ }
    }, 400);
  }

  const VS_ICON = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2"><path d="M17 3l4 2v14l-4 2L7 12l10-9zM7 12L3 9v6l4-3"/></svg>';
  // This page (stays the same when its event stream reconnects) and its current stream (the server's "subscriber"): a tool
  // call for this VS Code is addressed to one stream only, so the side bar and an editor tab never both run it.
  const PAGE = 'p' + Math.random().toString(36).slice(2, 12);
  const mine = new Set();
  const isMine = target => {
    try { if (typeof CHAT !== 'undefined' && CHAT.hello && CHAT.hello.subscriber) mine.add(CHAT.hello.subscriber); } catch { /* not the chat page */ }
    return !target || !mine.size || mine.has(target);
  };
  document.addEventListener('chathub-hello', ev => { const d = ev.detail || {}; if (d.subscriber) mine.add(d.subscriber); });
  window.chatClient = {
    deviceId: VS.device,
    // ! commands in the message box run here (with workspace tools on); /feedback says which app and version sent it.
    machineName: VS.machine + ' (VS Code)',
    appName: 'VS Code',
    appVersion: VS.version || '',
    shellEnabled() { return !!prefs().workspace; },
    logs() { return lapi('POST', 'logs', {}).then(r => (r && r.text) || ''); },
    /** Apply on a code block: VS Code's own diff (accept, reject, or revert single changes), written when accepted. */
    reviewApply({ path, content }) { return lapi('POST', 'chat/review-apply', { path, content }); },
    /** Insert at the cursor: into the editor the user was in. */
    insertCode({ code }) { return lapi('POST', 'editor/insert', { code }); },
    /** /plugin: Claude Code plugins on this computer. */
    plugins(body) { return lapi('POST', 'chat/plugins', body || {}); },
    hubQuery: () => `?device=${encodeURIComponent(VS.device)}&name=${encodeURIComponent(VS.machine)}&page=${PAGE}`,
    composerHtml() {
      const on = prefs().workspace;
      return `<button type="button" class="chip-toggle vs-ws-btn${on ? ' on' : ''}" data-act="vs-workspace"
        data-tip="${on ? 'The model can read, search and edit files in this VS Code workspace, see problems and the selection, and run commands (changes are approved per the permission mode). Click to turn off.' : 'Workspace tools are off. Click to let the model work in this VS Code workspace.'}">${VS_ICON} Workspace</button>` +
        (document.documentElement.classList.contains('vs-lite') ? '' : `<button type="button" class="chip-toggle vs-lite-btn" data-act="vs-lite" data-tip="Lite mode: only the chat, looking like Claude Code (Agentic: Lite Mode)">${VS_ICON} Lite</button>`);
    },
    async prepare(o) {
      const d = await prepareLocal(o && o.content);
      pushCatalog();
      return { tools: d.tools, instructions: d.instructions, device: VS.device, agents: d.agents || [], rules: d.rules };
    },
    /** Before a message is sent: SessionStart and UserPromptSubmit hooks (exit code 2 stops it; what they print goes with it). */
    checkPrompt({ content, chatId }) { return prefs().workspace ? lapi('POST', 'chat/check-prompt', { content, chatId }) : Promise.resolve({}); },
    // /bashes, /monitors, /hooks, /skills, /agents, /worktree and /diff in the chat.
    jobs() { return lapi('POST', 'chat/jobs', {}); },
    stopJob(id) { return lapi('POST', 'chat/job-stop', { id }); },
    hooks() { return lapi('POST', 'chat/hooks', {}); },
    // The hooks editor of /hooks: add (the project's or your own .agentic/settings.json), remove, try one.
    saveHook(h) { return lapi('POST', 'chat/hook-save', h); },
    removeHook(h) { return lapi('POST', 'chat/hook-remove', h); },
    testHook(h) { return lapi('POST', 'chat/hook-test', h); },
    skills() { return lapi('POST', 'chat/skills', {}); },
    agents() { return lapi('POST', 'chat/agents', {}); },
    saveAgent(a) { return lapi('POST', 'chat/agent-save', a); },
    worktree(arg) { return lapi('POST', 'chat/worktree', { arg }); },
    diff() { return lapi('POST', 'chat/diff', {}); },
    /** /mcp: this VS Code's MCP Servers page. */
    mcpPage() { if (typeof navigate === 'function') navigate('/local/mcp'); },
    /** Approvals are asked by the Agentic server (in the chat, per its permission mode), so the tool simply runs here. */
    async runTool(call, conv) {
      // mode and approved come from the server with the call: edits are reviewed only in Manual mode. id goes to the hooks (tool_use_id).
      const run = () => lapi('POST', 'chat/run', { name: call.name, arguments: call.arguments || '{}', chatId: (conv && conv.id) || undefined, mode: call.mode, approved: !!call.approved, id: call.id });
      let r = await run();
      // A path outside the workspace: the user decides (this path, its folder, or no), and the call runs again when allowed.
      if (r && r.needsAccess) {
        const choice = await askAccess(r.needsAccess, call.name);
        if (choice) { await lapi('POST', 'chat/allow-path', { path: r.needsAccess, folder: choice === 'folder' }); r = await run(); }
        else r = { ok: false, result: 'The user did not allow access to ' + r.needsAccess + ' (outside the workspace). Do not try it again; work inside the workspace or ask the user.' };
      }
      // image: a picture file it read, for the model; images: pictures an MCP tool made (a browser screenshot)
      return { ok: !!r.ok, result: r.result, image: r.image || undefined, images: r.images || undefined };
    },
    /** Hooks in this workspace for what happens in an answer this window runs (Notification, Pre/PostCompact, SubagentStart/Stop). */
    hookEvent({ event, chatId, payload }) { return prefs().workspace ? lapi('POST', 'chat/hook-event', { event, chatId, payload }) : Promise.resolve({}); },
    /** PermissionRequest hooks may answer an approval for a tool in this workspace: {decision: allow | deny, message}. */
    permissionRequest(a) { return prefs().workspace ? lapi('POST', 'chat/permission-request', a) : Promise.resolve({}); },
    /** A file's text as it is now (an approval card shows an overwrite as a diff). */
    fileText(path) { return lapi('POST', 'chat/file-text', { path }); },
    // Rewind: files are saved before an answer's first change to them, under the question that started it.
    beginTurn({ chatId, messageId }) { lapi('POST', 'chat/turn', { chatId, messageId }).catch(() => { }); },
    checkpoints({ chatId }) { return lapi('POST', 'chat/checkpoints', { chatId }); },
    restoreFiles({ chatId, messageIds }) { return lapi('POST', 'chat/restore', { chatId, messageIds }); },
    // The workspace's AGENTIC.md (instructions every message from VS Code includes).
    agenticMd: {
      read() { return lapi('POST', 'chat/agentic', {}); },
      write({ content }) { return lapi('POST', 'chat/agentic', { content }); }
    },
    // @ in the message box, /add-dir, /doctor, custom /commands and Stop hooks.
    listFiles(query) { return prefs().workspace ? lapi('POST', 'chat/files', { query }) : Promise.resolve([]); },
    addDir(path) { return lapi('POST', 'workspace/add', { path }); },
    doctor() { return lapi('POST', 'doctor', {}); },
    commands() { return prefs().workspace ? lapi('POST', 'chat/commands', {}) : Promise.resolve([]); },
    /** Copy buttons in the chat: VS Code's webview does not let the page use the clipboard, so VS Code copies. */
    copy(text) { return lapi('POST', 'clipboard', { text: String(text ?? '') }); },
    recordUsage({ chatId, message, cachedTokens }) { lapi('POST', 'chat/usage', { chatId, message, cachedTokens }).catch(() => { }); },
    afterAnswer({ chatId, text, active }) { return prefs().workspace ? lapi('POST', 'chat/stop', { chatId, text, active }) : Promise.resolve({}); },
    /** A notification (an answer finished, a chat needs you) while this page is in the background: VS Code shows it. */
    notify({ kind, title, body, chatId }) { lapi('POST', 'notify', { kind, title, body, chatId }).catch(() => { }); },
    /** Dictation mode: VS Code's webview cannot use the microphone, so VS Code records each turn (it stops at the user's
     *  pause) and the Agentic server turns it into text. onLevel shows the loudness; onTranscribing, when it turns to text. */
    async listen(o) {
      let busy = false, told = false;
      const poll = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const s = await lapi('GET', 'speech/state');
          if (s.state === 'listening' && o.onLevel) o.onLevel(s.level);
          if (s.state === 'transcribing' && !told) { told = true; if (o.onTranscribing) o.onTranscribing(); }
        } catch { /* asked again */ } finally { busy = false; }
      }, 120);
      try {
        return await lapi('POST', 'speech/listen', { silenceMs: o.silenceMs, maxTurnSeconds: o.maxTurnSeconds, noSpeechSeconds: o.noSpeechSeconds, sensitivity: o.sensitivity, language: o.language });
      } finally { clearInterval(poll); }
    },
    /** Ends the turn now: with what was heard (Send), or thrown away (discard: Pause, End, Skip). */
    stopListening(discard) { lapi('POST', 'speech/stop', { discard: !!discard }).catch(() => { }); },
    /** Dictation mode ended or paused: VS Code closes the microphone. */
    releaseMic() { lapi('POST', 'speech/release', {}).catch(() => { }); },
    /** The Run chip in Chat: runs the project in this workspace (a terminal tab each); a web app opens in the Simple Browser beside the chat. */
    run: {
      async configs() { return (await lapi('GET', 'run/configs')).configs; },
      start(id) { return lapi('POST', 'run/start', { id }); },
      stop(id) { return lapi('POST', 'run/stop', { id }); },
      status() { return lapi('GET', 'run/status'); },
      log(id, from) { return lapi('POST', 'run/log', { id, from: from || 0 }); },
      preview(url, title) { return lapi('POST', 'run/preview', { url, title: title || '' }); },
      edit() { return lapi('POST', 'run/edit', {}); },
      // The Artifacts page: the workspace folders, and a project's website as a public link (the same link when shared again).
      projects() { return lapi('GET', 'run/projects'); },
      share(id) { return lapi('POST', 'run/share', { id }); }
    },
    /** A file the chat names (a tool card's path, a changed file, `src/app.js` in an answer) opens in the editor, at the
     *  text an edit wrote (find) or a line. */
    openFileLabel: 'Open in the editor:',
    async openFile({ path, line, find }) {
      const r = await lapi('POST', 'open', { path, line: line || 0, find: find || '' });
      if (r && r.ok === false) throw new Error(r.result || 'The file could not be opened.');
      return r;
    },
    /** Opens a link outside VS Code (the webview cannot open windows). */
    openUrl(url) { return lapi('POST', 'open-url', { url: String(url || '') }); }
  };

  if (typeof ACTIONS !== 'undefined') {
    ACTIONS['vs-lite'] = () => toHost({ type: 'openLite' });
    ACTIONS['vs-workspace'] = el => {
      const p = prefs(); p.workspace = !p.workspace; savePrefs(p);
      el.classList.toggle('on', p.workspace);
      if (typeof toast === 'function') toast(p.workspace ? 'Workspace tools on' : 'Workspace tools off', 'ok');
    };
  }

  // Tool calls for this VS Code from chats started elsewhere (the web or desktop app): run them and send the result.
  // Only calls for this workspace's device AND this stream (target); each call once, even if the server sends it again
  // after this page's stream reconnected.
  const handled = new Set();
  document.addEventListener('chathub', async ev => {
    const m = ev.detail || {};
    if (pane || m.type !== 'client_tool' || !m.data || m.data.device !== VS.device) return;
    if (!isMine(m.data.target)) return;
    if (handled.has(m.data.id)) return;
    handled.add(m.data.id);
    if (handled.size > 500) handled.delete(handled.values().next().value);
    let r;
    try { r = await window.chatClient.runTool(m.data, { id: m.chatId }); } catch (e) { r = { ok: false, result: e.message }; }
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(`/api/chat/conversations/${encodeURIComponent(m.chatId)}/tool-results`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: m.data.id, ok: !!r.ok, result: String(r.result ?? ''), image: r.image || undefined, images: r.images || undefined })
        });
        if (res.ok || res.status === 404) return;
      } catch { /* network: try again */ }
      await new Promise(res => setTimeout(res, 1500 * attempt));
    }
  });

  // ------------------------------------------------------------------ theme and motion from VS Code
  /** calm (default) | full | off; kept so the next page load starts with it before VS Code says it again. */
  function applyMotionChoice(choice) {
    const c = choice === 'full' || choice === 'off' ? choice : 'calm';
    const html = document.documentElement;
    html.classList.toggle('vs-motion-calm', c === 'calm');
    let ours = false; try { ours = localStorage.getItem('vscode.motionOff') === '1'; } catch { /* ignore */ }
    if (c === 'off') {
      // VS Code asks for no animations (agentic.chat.animations, or workbench.reduceMotion): the app's own switch.
      try { localStorage.setItem('motion', 'off'); localStorage.setItem('vscode.motionOff', '1'); } catch { /* ignore */ }
      if (typeof applyMotion === 'function') applyMotion('off'); else html.dataset.motion = 'off';
    } else if (ours) {
      // Turned off by VS Code earlier: give the app back its default.
      try { localStorage.removeItem('motion'); localStorage.removeItem('vscode.motionOff'); } catch { /* ignore */ }
      if (typeof applyMotion === 'function') applyMotion(''); else delete html.dataset.motion;
    }
    try { localStorage.setItem('vscode.motion', c); } catch { /* ignore */ }
  }
  function applyTheme(theme) {
    const t = theme === 'light' ? 'light' : 'dark';
    const html = document.documentElement;
    try { localStorage.setItem('theme', t); } catch { /* ignore */ }
    if (html.dataset.theme === t) return;
    html.classList.add('vs-instant');
    html.dataset.theme = t;
    requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('vs-instant')));
  }
  if (!pane) { let c = 'calm'; try { c = localStorage.getItem('vscode.motion') || 'calm'; } catch { /* ignore */ } applyMotionChoice(c); }
  else document.documentElement.classList.add('vs-motion-calm');

  // ------------------------------------------------------------------ multitask
  // The side bar is narrower than multitask needs (900 px): there, multitask opens in a wide editor tab instead.
  const narrow = () => typeof MT_NARROW !== 'undefined' && MT_NARROW.matches;
  if (!pane && inFrame && typeof window.mtEnter === 'function') {
    const enter = window.mtEnter;
    window.mtEnter = function () {
      if (narrow()) { toHost({ type: 'openMultitask' }); return; }
      return enter.apply(this, arguments);
    };
  }
  function startMultitask() {
    if (document.querySelector('.mt-app')) return;
    if (narrow()) { toHost({ type: 'multitaskNarrow' }); return; }
    if (location.pathname !== '/chat' && !location.pathname.startsWith('/chat/') && typeof navigate === 'function') navigate('/chat');
    setTimeout(() => { if (typeof window.mtEnter === 'function') window.mtEnter(); }, 150);
  }

  // ------------------------------------------------------------------ messages from VS Code
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /** The page that gets text and files: in multitask, the focused pane; else this page. */
  function chatWindow() {
    if (document.querySelector('.mt-app') && typeof mtFocusedWindow === 'function') { const w = mtFocusedWindow(); if (w) return w; }
    return window;
  }
  /** The message box (and its page), opening the chat page — or, with fresh, a new chat — first. */
  async function chatInput(fresh) {
    const multi = !!document.querySelector('.mt-app');
    if (multi) {
      if (fresh && typeof mtOpenChat === 'function') { mtOpenChat(null); await sleep(400); }
    } else {
      const onChat = location.pathname === '/chat' || location.pathname.startsWith('/chat/');
      if ((fresh || !onChat) && typeof navigate === 'function') navigate('/chat');
    }
    for (let i = 0; i < 60; i++) {
      const w = chatWindow();
      let t = null; try { t = w.document.getElementById('chat-input'); } catch { /* a pane still loading */ }
      if (t && (!fresh || multi || i > 3)) return { t, w };
      await sleep(100);
    }
    return null;
  }
  function setInput(box, text, append) {
    const { t, w } = box;
    t.value = append && t.value.trim() ? t.value.replace(/\s+$/, '') + '\n\n' + text : text;
    t.dispatchEvent(new w.Event('input', { bubbles: true }));
    if (typeof w.autosize === 'function') w.autosize();
    t.focus();
    t.setSelectionRange(t.value.length, t.value.length);
  }

  async function onHostMessage(m) {
    switch (m.type) {
      case 'theme':
        applyTheme(m.theme);
        if (m.motion) applyMotionChoice(m.motion);
        return;
      case 'insert': {
        const box = await chatInput(!!m.newChat);
        if (!box) return;
        setInput(box, String(m.text || ''), !m.newChat && m.append !== false);
        if (m.send && typeof box.w.sendMessage === 'function') await box.w.sendMessage(false);
        return;
      }
      case 'attach': {
        const box = await chatInput(false);
        if (!box || typeof box.w.attachFiles !== 'function') return;
        const bytes = Uint8Array.from(atob(String(m.data || '')), c => c.charCodeAt(0));
        await box.w.attachFiles([new box.w.File([bytes], String(m.name || 'file.txt'), { type: String(m.mime || 'text/plain') })]);
        if (m.text) setInput(box, String(m.text), true); else box.t.focus();
        return;
      }
      case 'newChat': {
        const box = await chatInput(true);
        if (box) box.t.focus();
        return;
      }
      case 'multitask':
        startMultitask();
        return;
      case 'navigate':
        if (typeof navigate === 'function') navigate(String(m.path || '/chat'));
        return;
      case 'mcpChanged':
        // An MCP server connected, failed or changed its tools: chats in other windows see it, and the MCP page updates.
        pushCatalog();
        if (location.pathname === '/local/mcp' && typeof refreshNow === 'function') refreshNow();
        return;
      case 'shortcuts':
        // Keyboard shortcuts of the web app (keys.js); older servers do not have them.
        if (typeof ACTIONS !== 'undefined' && ACTIONS['keys-open']) ACTIONS['keys-open']();
        else if (typeof toast === 'function') toast('This Agentic server cannot change shortcuts yet: update the server.', 'warn');
        return;
    }
  }
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (pane || !m || m.source !== 'agentic-vscode' || ev.source !== window.parent) return;
    onHostMessage(m).catch(e => { if (typeof toast === 'function') toast('VS Code: ' + e.message, 'bad'); });
  });

  // Links to files on this computer open in the editor (file:// links, or paths the model wrote as links).
  document.addEventListener('click', ev => {
    const a = ev.target && ev.target.closest && ev.target.closest('a[href^="file:"], a[href^="vscode:"]');
    if (!a) return;
    ev.preventDefault();
    let p = a.getAttribute('href').replace(/^vscode:\/\/file\//, '').replace(/^file:\/\/\/?/, '');
    let line = 0;
    const lm = p.match(/[#:](?:L)?(\d+)(?::\d+)?$/);
    if (lm) { line = Number(lm[1]); p = p.slice(0, lm.index); }
    lapi('POST', 'open', { path: decodeURIComponent(p), line }).catch(e => { if (typeof toast === 'function') toast(e.message, 'bad'); });
  }, true);

  // ------------------------------------------------------------------ Claude Code in the chat (ported from the desktop app)
  /* When the claude CLI is installed, "Claude Code" is a model in Chat. A message to it runs claude on this computer (its own
     account, tools, MCP servers, skills, CLAUDE.md and settings) and continues the chat's Claude session; the exchange is
     then saved to the chat like any other. The Claude chip in the message box holds its options: model, effort, permission
     mode, working folder and more. Permission prompts and Claude's questions appear as Agentic's approval and question cards. */
  const CLAUDE_ID = 'claude-code';
  const CLAUDE_ICON = '<svg viewBox="0 0 24 24" class="ic"><path d="M12 2.5l1.6 5.2 5.4-1.6-3.6 4.3 4.3 3.6-5.4.2.4 5.5L12 15.9 9.3 19.7l.4-5.5-5.4-.2 4.3-3.6-3.6-4.3 5.4 1.6z"/></svg>';
  const VSC_CLAUDE = { status: null, commands: [] };
  (() => { try { VSC_CLAUDE.status = JSON.parse(localStorage.getItem('vs.claude.status') || 'null'); } catch { /* none */ } })();
  /** Whether claude is installed (remembered from the last check, so the model shows at once; checked again in the background). */
  async function claudeStatus(force) {
    if (VSC_CLAUDE.status && !force && VSC_CLAUDE.fresh) return VSC_CLAUDE.status;
    try {
      const s = await lapi('GET', 'claude');
      const was = !!(VSC_CLAUDE.status && VSC_CLAUDE.status.installed);
      VSC_CLAUDE.status = s; VSC_CLAUDE.fresh = true;
      try { localStorage.setItem('vs.claude.status', JSON.stringify(s)); } catch { /* ignore */ }
      // Installed or removed since last time: the model list and the open chat's controls follow.
      if (was !== !!s.installed && typeof CHAT !== 'undefined' && CHAT.meta && $('#composer-bar')) { $('#model-picker').innerHTML = modelButton(); $('#composer-bar').innerHTML = composerBarHtml(); }
    } catch { /* not in the desktop app */ }
    return VSC_CLAUDE.status || { installed: false };
  }
  setTimeout(() => claudeStatus(true), 1200);

  const CLAUDE_MODELS = [['default', 'Default', 'Your Claude Code setting'], ['opus', 'Opus', 'Most capable'], ['sonnet', 'Sonnet', 'Fast and capable'],
    ['haiku', 'Haiku', 'Fastest'], ['fable', 'Fable', 'Newest family'], ['opusplan', 'Opus plan', 'Opus to plan, Sonnet to work']];
  const CLAUDE_EFFORTS = [['default', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
  const CLAUDE_MODES = [['default', 'Ask first', 'Asks before edits and commands (your Claude settings apply)'], ['acceptEdits', 'Accept edits', 'Edits files without asking; asks for commands'],
    ['plan', 'Plan', 'Looks around and plans; changes nothing'], ['auto', 'Auto', 'Claude decides what is safe to run'],
    ['dontAsk', "Don't ask", 'Anything that would ask is refused'], ['bypassPermissions', 'Bypass', 'Never asks - only for throwaway folders']];
  function claudeDefaults() {
    let d = null; try { d = JSON.parse(localStorage.getItem('vs.claude.defaults') || 'null'); } catch { /* ignore */ }
    return Object.assign({ model: 'default', effort: 'default', permissionMode: 'default', cwd: '', addDirs: [], appendSystemPrompt: '', maxTurns: '', fallbackModel: '', allowedTools: '', disallowedTools: '', maxBudgetUsd: '' }, d);
  }
  function claudeOptions(chat) { return Object.assign(claudeDefaults(), chat.settings && chat.settings.claude || {}); }
  /** Changes one option for this chat; the choice is also the default for new Claude Code chats (not the session). */
  function setClaudeOption(chat, key, value) {
    const o = claudeOptions(chat);
    o[key] = value;
    chat.settings.claude = o;
    const d = Object.assign({}, o); delete d.sessionId;
    try { localStorage.setItem('vs.claude.defaults', JSON.stringify(d)); } catch { /* ignore */ }
    if (typeof saveSettings === 'function') saveSettings();
    const chip = $('#dk-claude-btn'); if (chip) chip.innerHTML = claudeChipText(chat);
  }
  function claudeChipText(chat) {
    const o = claudeOptions(chat), m = CLAUDE_MODELS.find(x => x[0] === o.model), mode = CLAUDE_MODES.find(x => x[0] === o.permissionMode);
    return `${CLAUDE_ICON} Claude · ${esc(m ? m[1] : o.model)}${o.permissionMode && o.permissionMode !== 'default' ? ` <b>${esc(mode ? mode[1] : o.permissionMode)}</b>` : ''}`;
  }

  Object.assign(window.chatClient, {
    externalModels() {
      const s = VSC_CLAUDE.status;
      return s && s.installed ? [{ id: CLAUDE_ID, name: 'Claude Code', description: `claude ${s.version || ''} on this computer${s.source && s.source !== 'PATH' ? ' · ' + s.source : ''} · your own Claude account` }] : [];
    },
    externalComposerHtml(chat) {
      return `<div class="tools-menu-wrap dk-claude-wrap"><button class="chip-toggle on" data-act="dk-claude-menu" id="dk-claude-btn" data-tip="Claude Code: model, effort, permission mode, folder and session">${claudeChipText(chat)}</button>
          <div class="menu tools-menu dk-claude-menu hidden" id="dk-claude-menu"></div></div>`;
    },
    setExternalOption(chat, key, value) { setClaudeOption(chat, key, value); },
    runExternal: runClaude
  });

  ACTIONS['dk-claude-menu'] = async () => {
    const m = $('#dk-claude-menu');
    if (!m.classList.contains('hidden')) { m.classList.add('hidden'); return; }
    const st = await claudeStatus(), o = claudeOptions(CHAT);
    let folders = []; try { folders = (await lapi('GET', 'info')).workspaces || []; } catch { /* none */ }
    const opt = (list, v) => list.map(x => `<option value="${esc(x[0])}"${x[0] === v ? ' selected' : ''}>${esc(x[1])}${x[2] ? ' — ' + esc(x[2]) : ''}</option>`).join('');
    const custom = !CLAUDE_MODELS.some(x => x[0] === o.model);
    m.innerHTML = `<div class="menu-title">Claude Code ${st.version ? `<span class="muted">${esc(st.version)}</span>` : ''}</div>
      <div class="dk-cl-form">
        <label>Model<select data-change="dk-cl" data-key="model">${opt(CLAUDE_MODELS, custom ? '' : o.model)}<option value="__custom"${custom ? ' selected' : ''}>Other model name…</option></select></label>
        <label class="${custom ? '' : 'hidden'}" id="dk-cl-custom">Model name<input data-change="dk-cl" data-key="model" value="${custom ? esc(o.model) : ''}" placeholder="e.g. claude-opus-5-5"></label>
        <label>Effort<select data-change="dk-cl" data-key="effort">${opt(CLAUDE_EFFORTS, o.effort)}</select></label>
        <label>Permissions<select data-change="dk-cl" data-key="permissionMode">${opt(CLAUDE_MODES, o.permissionMode)}</select></label>
        <label>Folder<input data-change="dk-cl" data-key="cwd" list="dk-cl-folders" value="${esc(o.cwd)}" placeholder="${esc(folders[0] || 'your workspace folder')}"><datalist id="dk-cl-folders">${folders.map(f => `<option value="${esc(f)}">`).join('')}</datalist></label>
        <details class="dk-cl-more"><summary>More options</summary>
          <label>Also allow these folders <span class="muted">(one per line)</span><textarea rows="2" data-change="dk-cl" data-key="addDirs">${esc((o.addDirs || []).join('\n'))}</textarea></label>
          <label>Extra instructions <span class="muted">(added to Claude's system prompt)</span><textarea rows="2" data-change="dk-cl" data-key="appendSystemPrompt">${esc(o.appendSystemPrompt || '')}</textarea></label>
          <label>Allowed tools <span class="muted">(e.g. Bash(git *), Edit)</span><input data-change="dk-cl" data-key="allowedTools" value="${esc(o.allowedTools || '')}"></label>
          <label>Blocked tools<input data-change="dk-cl" data-key="disallowedTools" value="${esc(o.disallowedTools || '')}"></label>
          <div class="dk-cl-row"><label>Max turns<input type="number" min="1" data-change="dk-cl" data-key="maxTurns" value="${esc(o.maxTurns || '')}"></label>
            <label>Budget (USD)<input type="number" min="0" step="0.5" data-change="dk-cl" data-key="maxBudgetUsd" value="${esc(o.maxBudgetUsd || '')}"></label></div>
          <label>Fallback model <span class="muted">(when the model is overloaded)</span><input data-change="dk-cl" data-key="fallbackModel" value="${esc(o.fallbackModel || '')}" placeholder="e.g. sonnet"></label>
        </details>
        <div class="dk-cl-session">${o.sessionId ? `Session <code>${esc(o.sessionId.slice(0, 8))}</code> continues with each message.` : 'A new Claude session starts with the next message.'}
          ${o.sessionId ? '<button type="button" class="btn xs" data-act="dk-cl-new-session">New session</button>' : ''}</div>
        <div class="muted small">${esc(st.path || '')}</div>
      </div>`;
    m.classList.remove('hidden');
    setTimeout(() => document.addEventListener('click', function close(ev) { if (!ev.target.closest('.dk-claude-wrap')) { m.classList.add('hidden'); document.removeEventListener('click', close); } }), 0);
  };
  CHANGES['dk-cl'] = el => {
    const key = el.dataset.key;
    if (key === 'model' && el.tagName === 'SELECT') {
      const box = $('#dk-cl-custom');
      if (el.value === '__custom') { box.classList.remove('hidden'); $('input', box).focus(); return; }
      box.classList.add('hidden');
    }
    let v = el.value;
    if (key === 'addDirs') v = v.split('\n').map(x => x.trim()).filter(Boolean);
    if (key === 'permissionMode' && v === 'bypassPermissions') toast('Bypass: Claude Code will run anything without asking. Use it only in a folder you can throw away.', 'warn');
    setClaudeOption(CHAT, key, v);
  };
  ACTIONS['dk-cl-new-session'] = el => { setClaudeOption(CHAT, 'sessionId', null); el.closest('.dk-cl-session').innerHTML = 'A new Claude session starts with the next message.'; toast('The next message starts a new Claude session', 'ok'); };

  async function fileAsBase64(uploadId) {
    const res = await fetch('/api/chat/files/' + encodeURIComponent(uploadId));
    if (!res.ok) throw new Error('Could not read an attached file.');
    const blob = await res.blob();
    const data = await new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] || ''); r.onerror = bad; r.readAsDataURL(blob); });
    return { mediaType: blob.type || 'application/octet-stream', data };
  }

  /** One message to Claude Code: runs it, turns its events into the chat's (delta, reasoning, tool, status, route) and returns the answer. */
  async function runClaude({ conv, content, attachments, settings, plan, signal, emit, approve, ask, history }) {
    const st = await claudeStatus();
    if (!st || !st.installed) throw new Error('Claude Code is not installed on this computer. Install it (npm install -g @anthropic-ai/claude-code, or the installer from claude.com/code) and try again.');
    const o = claudeOptions({ settings });
    const images = [], files = [];
    for (const a of attachments || []) {
      const f = await fileAsBase64(a.id);
      if (a.kind === 'image' && /^image\/(png|jpeg|gif|webp)$/.test(f.mediaType)) images.push(f); else files.push({ name: a.name, data: f.data });
    }
    // The first message of a Claude session in a chat that already has messages: Claude gets the conversation so far.
    let prompt = content || (images.length ? 'Look at the attached picture.' : 'See the attached files.');
    if (!o.sessionId && history && history.length) {
      const earlier = history.filter(m => m.role === 'user' || m.role === 'assistant').map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.content || '').slice(0, 4000)}`).join('\n\n');
      if (earlier.trim()) prompt = `Earlier in this conversation (it started in Agentic):\n\n${earlier.slice(-30000)}\n\n---\n\n${prompt}`;
    }
    const runId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^a-z0-9]/gi, '');
    let reader = null, stopTimer = 0;
    const onAbort = () => {
      lapi('POST', 'claude/interrupt', { runId }).catch(() => { });
      stopTimer = setTimeout(() => { if (reader) reader.cancel().catch(() => { }); }, 8000);
    };
    signal.addEventListener('abort', onAbort);
    const res = await fetch('/api/local/claude/run', {
      method: 'POST', headers: { 'X-Vscode-Token': VS.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, prompt, images, files, sessionId: o.sessionId || null, plan: !!plan, settings: o })
    });
    if (!res.ok) { let msg = res.statusText; try { msg = (await res.json()).error.message || msg; } catch { /* not JSON */ } throw new Error(msg); }
    const state = { text: '', reasoning: '', tools: new Map(), toolCalls: [], sessionId: null, model: null, result: null, error: null, cwd: '' };
    const respond = (requestId, response) => lapi('POST', 'claude/respond', { runId, requestId, response }).catch(e => console.warn('claude respond', e));
    const onControl = async m => {
      const r = m.request || {};
      if (r.subtype !== 'can_use_tool') { respond(m.request_id, {}); return; }
      if (r.tool_name === 'AskUserQuestion' && r.input && Array.isArray(r.input.questions)) {
        const qs = r.input.questions.map(q => ({ question: q.question, options: (q.options || []).map(x => typeof x === 'string' ? x : x.label).filter(Boolean).slice(0, 4), allowOther: true }));
        const answers = await ask(qs);
        if (!answers) { respond(m.request_id, { behavior: 'deny', message: 'The user did not answer here; they will reply in the chat.' }); return; }
        respond(m.request_id, { behavior: 'allow', updatedInput: Object.assign({}, r.input, { answers: Object.fromEntries(r.input.questions.map((q, i) => [q.question, answers[i]])) }) });
        return;
      }
      const choice = await approve({ requestId: m.request_id, toolName: r.display_name || r.tool_name, input: r.input, reason: r.decision_reason || r.description });
      if (choice === 'deny') respond(m.request_id, { behavior: 'deny', message: 'The user denied this.' });
      else respond(m.request_id, Object.assign({ behavior: 'allow', updatedInput: r.input }, choice === 'always' && r.permission_suggestions ? { updatedPermissions: r.permission_suggestions } : {}));
    };
    const handle = m => {
      switch (m.type) {
        case 'agentic_started': state.cwd = m.cwd; emit('status', { text: 'Starting Claude Code…' }); break;
        case 'agentic_error': state.error = m.message; break;
        case 'system':
          if (m.subtype === 'init') {
            state.sessionId = m.session_id; state.model = m.model;
            VSC_CLAUDE.commands = (m.slash_commands || []).slice(0, 400);
            emit('route', { model: m.model, label: 'Claude Code', reason: `${m.permissionMode || 'default'} · ${m.cwd || state.cwd}` });
            emit('status', { text: 'Thinking…' });
          } else if (m.subtype === 'compact_boundary') emit('status', { text: 'Claude compacted the conversation…' });
          break;
        case 'stream_event': {
          if (m.parent_tool_use_id) { emit('status', { text: 'A subagent is working…' }); break; }
          const ev = m.event || {};
          if (ev.type === 'content_block_delta' && ev.delta) {
            if (ev.delta.type === 'text_delta' && ev.delta.text) { state.text += ev.delta.text; emit('delta', { text: ev.delta.text }); }
            else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) { state.reasoning += ev.delta.thinking; emit('reasoning', { text: ev.delta.thinking }); }
          } else if (ev.type === 'content_block_start' && ev.content_block && ev.content_block.type === 'tool_use') emit('status', { text: `Using ${ev.content_block.name}…` });
          break;
        }
        case 'assistant':
          if (m.parent_tool_use_id) break;
          for (const b of (m.message && m.message.content) || []) {
            if (b.type !== 'tool_use') continue;
            const call = { id: b.id, name: b.name, server: 'claude-code', arguments: JSON.stringify(b.input || {}) };
            state.tools.set(b.id, call);
            if (state.text && !state.text.endsWith('\n')) state.text += '\n\n';
            emit('tool', { phase: 'start', call });
          }
          break;
        case 'user':
          if (m.parent_tool_use_id) break;
          for (const b of (m.message && Array.isArray(m.message.content) ? m.message.content : [])) {
            if (b.type !== 'tool_result') continue;
            const call = state.tools.get(b.tool_use_id) || { id: b.tool_use_id, name: 'tool', server: 'claude-code', arguments: '{}' };
            const text = typeof b.content === 'string' ? b.content : (b.content || []).map(c => c.type === 'text' ? c.text : `[${c.type}]`).join('\n');
            const done = Object.assign({}, call, { ok: !b.is_error, result: String(text || '').slice(0, 12000) });
            state.toolCalls.push(done);
            emit('tool', { phase: 'end', call: done });
          }
          break;
        case 'control_request': onControl(m); break;
        case 'result': state.result = m; break;
        case 'rate_limit_event': if (m.rate_limit_info && m.rate_limit_info.status === 'rejected') emit('status', { text: 'Claude usage limit reached…' }); break;
      }
    };
    try {
      reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (; ;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, cut); buf = buf.slice(cut + 2);
          if (!raw.startsWith('data: ')) continue;
          let m; try { m = JSON.parse(raw.slice(6)); } catch { continue; }
          handle(m);
        }
      }
    } finally {
      clearTimeout(stopTimer);
      signal.removeEventListener('abort', onAbort);
    }
    const r = state.result, u = (r && r.usage) || {};
    const cost = r && typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null;
    const failed = r && r.is_error;
    const answer = {
      content: (state.text.trim() || (r && !failed && typeof r.result === 'string' ? r.result : '')).trim(),
      reasoning: state.reasoning || null,
      toolCalls: state.toolCalls,
      routedModel: state.model,
      routeInfo: `Claude Code · ${(CLAUDE_MODES.find(x => x[0] === (plan ? 'plan' : o.permissionMode)) || ['', 'Ask first'])[1]}${cost !== null ? ` · ${cost.toFixed(cost < 0.1 ? 4 : 2)} on your Claude account` : ''}${r && r.num_turns ? ` · ${r.num_turns} turns` : ''}`,
      durationMs: r && r.duration_ms || 0,
      promptTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0),
      completionTokens: u.output_tokens || 0,
      // Stopped with the stop button: Claude reports the interrupted turn as an error; it is a stop.
      finishReason: signal.aborted ? 'stopped' : !r ? 'error' : failed ? 'error' : r.stop_reason === 'max_tokens' ? 'length' : 'stop',
      error: signal.aborted ? 'Stopped.' : state.error || (failed ? (typeof r.result === 'string' && r.result ? r.result : `Claude Code ended with ${r.subtype || 'an error'}.`) : (!r && !signal.aborted ? 'Claude Code stopped without finishing the answer.' : null))
    };
    return { answer, settings: { claude: Object.assign({}, o, { sessionId: (r && r.session_id) || state.sessionId || o.sessionId || null }) } };
  }

  const start = () => {
    if (pane) return;
    pushCatalog();
    toHost({ type: 'ready', version: VS.version });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

/* MCP Servers page (/local/mcp, Agentic: MCP Servers, /mcp in the chat): every MCP server this VS Code can use - its own
   (~/.agentic/mcp.json, the project's .mcp.json), Claude Code's, Claude Desktop's, Claude Code plugins' and VS Code's own -
   with their state, and one-click adding of well-known servers. Values of keys and headers never come to this page. */
(function () {
  if (typeof VIEWS === 'undefined' || typeof ROUTES === 'undefined') return;
  const token = (document.querySelector('meta[name="vscode-token"]') || {}).content || '';
  async function mapi(path, body) {
    const res = await fetch('/api/local/' + path, { method: 'POST', headers: { 'X-Vscode-Token': token, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) throw new Error(data && data.error ? (data.error.message || data.error) : res.statusText);
    return data;
  }
  const MC = { servers: [], userFile: '', projectFile: '', roots: [] };
  const catalog = () => (typeof MCP_CATALOG !== 'undefined' && Array.isArray(MCP_CATALOG)) ? MCP_CATALOG : [];
  const byId = id => MC.servers.find(s => s.id === id);
  const STATES = { connected: ['Connected', 'ok'], starting: ['Connecting', 'info'], failed: ['Failed', 'bad'], off: ['Off', 'outline'],
    approval: ['Waiting for you', 'warn'], input: ['Needs values', 'warn'], signin: ['Sign in needed', 'warn'] };
  const target = s => s.transport === 'stdio' ? `${s.command || ''} ${(s.args || []).join(' ')}` : (s.url || '');
  const lines = t => String(t || '').split('\n').map(x => x.trim()).filter(Boolean);
  const pairs = (t, sep) => Object.fromEntries(lines(t).filter(l => l.includes(sep)).map(l => [l.slice(0, l.indexOf(sep)).trim(), l.slice(l.indexOf(sep) + sep.length).trim()]));
  const envRef = k => '${' + k + '}';

  ROUTES.unshift([/^\/local\/mcp$/, 'vsMcp']);
  VIEWS.vsMcp = {
    live: true,
    async render() {
      setCrumbs([['VS Code', ''], ['MCP servers', '/local/mcp']]);
      Object.assign(MC, await mapi('mcp/list'));
      const up = MC.servers.filter(s => s.state === 'connected');
      const tools = up.reduce((n, s) => n + s.tools.length, 0);
      const waiting = MC.servers.filter(s => s.state === 'approval' && !s.denied);
      const actions = s => {
        const b = (label, action, cls = 'ghost', tip = '') => `<button class="btn xs ${cls}" data-act="vs-mcp" data-action="${action}" data-id="${esc(s.id)}"${tip ? ` data-tip="${esc(tip)}"` : ''}>${label}</button>`;
        const out = [];
        if (s.state === 'approval') out.push(b('Allow', 'allow', 'primary', 'Start this project server (it runs a command or reaches a URL from the project\'s files)'), s.denied ? '' : b('Don\'t allow', 'deny'));
        if (s.state === 'input') out.push(b('Enter values…', 'inputs', 'primary'));
        if (s.state === 'signin') out.push(b('Sign in', 'signin', 'primary', 'Opens the browser to sign in to this server'));
        if (s.tools.length) out.push(b(`Tools (${s.tools.length})`, 'tools', ''));
        out.push(b(s.enabled ? 'Turn off' : 'Turn on', s.enabled ? 'disable' : 'enable'));
        if (s.enabled && s.state !== 'approval' && s.state !== 'input') out.push(b('Reconnect', 'reconnect'));
        if (s.transport !== 'stdio' && s.state === 'connected') out.push(b('Sign out', 'signout', 'ghost', 'Forget this server\'s sign-in (OAuth) tokens'));
        if (s.stderr && s.stderr.length) out.push(b('Log', 'log'));
        out.push(b('Open file', 'open', 'ghost', s.file));
        if (s.editable) out.push(b('Remove', 'remove', 'ghost danger'));
        return out.join('');
      };
      const rows = table([
        { h: 'Server', f: s => `<b>${esc(s.name)}</b> <code class="muted">${esc(s.id)}</code><div class="cell-sub">${esc(s.source)}${s.requireApproval ? ' · asks before each call' : ''}</div>` },
        { h: 'Connection', cls: 'clip', f: s => `${tag(s.transport)} <code data-tip="${esc(target(s))}">${esc(target(s).slice(0, 90))}</code>` },
        { h: 'State', f: s => { const st = STATES[s.state] || [s.state, 'outline']; return badge(st[0], st[1]) + (s.error && s.state !== 'connected' ? `<div class="cell-sub error-text" data-tip="${esc(s.error)}">${esc(s.error.slice(0, 160))}</div>` : '') + (s.unset && s.unset.length ? `<div class="cell-sub">Not set: ${s.unset.map(u => `<code>${esc(u)}</code>`).join(', ')}</div>` : ''); } },
        { h: '', cls: 'act', f: actions }], MC.servers, { empty: 'No MCP servers yet.', key: s => s.id });
      return pageHead('MCP servers', {
        subtitle: 'MCP servers this VS Code gives the chat as tools (<code>mcp__server__tool</code>): its own, the project\'s <code>.mcp.json</code>, and the ones you set up in Claude Code, Claude Code plugins, Claude Desktop or VS Code itself (switch those off in the settings: <code>agentic.mcp.includeClaude</code>, <code>agentic.mcp.includeVsCode</code>). A project\'s servers start only after you allow them.',
        actions: `<button class="btn" data-act="vs-mcp" data-action="open" data-scope="user" data-tip="${esc(MC.userFile)}">Open mcp.json</button>${MC.projectFile ? `<button class="btn" data-act="vs-mcp" data-action="open" data-scope="project" data-tip="${esc(MC.projectFile)}">Open project .mcp.json</button>` : ''}<button class="btn primary" data-act="vs-mcp-add">${icon('plus')} Add server</button>`
      }) +
        `<div class="grid kpis">${kpi('Servers', num(MC.servers.length), `${num(MC.servers.filter(s => s.enabled).length)} on`)}${kpi('Connected', num(up.length), up.length ? 'ready for Chat' : 'none yet')}${kpi('Tools', num(tools), 'from connected servers')}</div>` +
        (waiting.length ? `<div class="notice warn section"><b>${waiting.length === 1 ? 'A project server waits' : waiting.length + ' project servers wait'} for you.</b> ${waiting.map(s => `<code>${esc(s.id)}</code> (${esc(target(s).slice(0, 80))})`).join(', ')} — they come from this project's files: allow only what you trust.</div>` : '') +
        card('', rows, { flush: true, cls: 'section' }) + catalogCard();
    }
  };

  function catalogCard() {
    const have = new Set(MC.servers.map(s => s.id.toLowerCase()));
    const recs = catalog().filter(r => !have.has(r.id.toLowerCase()));
    if (!recs.length) return '';
    const groups = [...new Set(recs.map(r => r.category))];
    const needsSetup = r => !!(r.env && r.env.length) || (r.args || []).includes('{folder}');
    const item = r => `<div class="mcp-cat-item"><div class="grow"><div class="cell-title">${esc(r.name)} ${r.url ? tag('hosted', 'outline') : ''}</div>
        <div class="small muted">${esc(r.blurb)}</div><div class="cell-sub"><code>${esc(r.url || (r.command + ' ' + r.args.join(' ')))}</code></div>
        <div class="cell-sub">Needs ${esc(r.needs)} · <a href="${esc(r.docs)}" target="_blank" rel="noopener noreferrer">docs</a></div></div>
      <button class="btn xs${needsSetup(r) ? '' : ' primary'}" data-act="vs-mcp-catalog" data-id="${esc(r.id)}">${needsSetup(r) ? 'Set up…' : 'Add'}</button></div>`;
    return card('Add a well-known server', groups.map(g => `<div class="menu-title mcp-cat-title">${esc(g)}</div><div class="mcp-cat-grid">${recs.filter(r => r.category === g).map(item).join('')}</div>`).join(''),
      { cls: 'section', hint: 'Added to ~/.agentic/mcp.json (the CLI uses it too). Keys you leave empty are read from your environment variables.' });
  }

  /** A catalog entry as a server entry (Claude Code's format); keys become ${KEY}, read from the environment. */
  function catalogEntry(r, folder) {
    const env = Object.fromEntries((r.env || []).filter(e => e.key !== r.bearer).map(e => [e.key, envRef(e.key)]));
    const e = r.url ? { type: 'http', url: r.url, headers: r.bearer ? { Authorization: 'Bearer ' + envRef(r.bearer) } : {} }
      : { command: r.command, args: r.args.map(a => a === '{folder}' ? (folder || '') : a) };
    if (Object.keys(env).length) e.env = env;
    if (r.approval) e.requireApproval = true;
    return e;
  }

  async function act(id, action, extra) {
    try {
      const d = await mapi('mcp/action', Object.assign({ id, action }, extra || {}));
      if (d && d.servers) MC.servers = d.servers;
      return d;
    } catch (e) { toast(e.message, 'bad'); return null; } finally { refreshNow(); }
  }

  ACTIONS['vs-mcp'] = async el => {
    const id = el.dataset.id, action = el.dataset.action, s = byId(id);
    if (action === 'open') { await act(id || '', 'open', { scope: el.dataset.scope }); return; }
    if (action === 'remove') { if (await confirmBox('Remove server', `Remove <b>${esc(id)}</b> from ${esc(s ? s.file : 'its file')}?`, { danger: true, confirm: 'Remove' })) await act(id, 'remove'); return; }
    if (action === 'log') { openModal(`${s.name} — recent output`, `<pre class="code-block">${esc((s.stderr || []).join('\n'))}</pre>`, '', 'wide'); return; }
    if (action === 'tools') { toolsModal(s); return; }
    if (action === 'inputs') {
      for (const i of s.inputs) {
        const v = await confirmBox(s.name, esc(i.description), { input: i.id + (i.password ? ' (kept in VS Code\'s secret storage)' : ''), confirm: 'Save' });
        if (v === null || v === false) return;
        await act(id, 'input', { input: i.id, value: v });
      }
      return;
    }
    if (action === 'signin') toast('Sign in in the browser that opened…', 'ok');
    el.disabled = true;
    await act(id, action);
    if (action === 'allow' || action === 'enable') toast('Starting ' + (s ? s.name : id) + '…', 'ok');
  };

  function toolsModal(s) {
    openModal(`${s.name} — ${num(s.tools.length)} tools`, s.tools.map((t, i) => `<details class="section"><summary><code>${esc(t.name)}</code> <span class="muted small">${esc((t.description || '').split('\n')[0].slice(0, 160))}</span></summary>
      ${t.description ? `<p class="small">${esc(t.description)}</p>` : ''}
      <label class="small">Arguments (JSON)<textarea rows="4" class="mono" id="vs-try-${i}">{}</textarea></label>
      <div class="row"><button class="btn small" data-act="vs-mcp-try" data-id="${esc(s.id)}" data-tool="${esc(t.name)}" data-i="${i}">Run tool</button></div><div id="vs-try-out-${i}"></div></details>`).join(''), '', 'wide');
  }
  ACTIONS['vs-mcp-try'] = async el => {
    const out = $('#vs-try-out-' + el.dataset.i);
    let args; try { args = JSON.parse($('#vs-try-' + el.dataset.i).value || '{}'); } catch { out.innerHTML = '<div class="notice bad small">The arguments are not valid JSON.</div>'; return; }
    out.innerHTML = '<div class="muted small">Running…</div>';
    try {
      const r = await mapi('mcp/action', { id: el.dataset.id, action: 'call', tool: el.dataset.tool, args });
      out.innerHTML = `<div>${r.ok ? badge('ok', 'ok') : badge('error', 'bad')}</div><pre class="code-block">${esc(r.result || '')}</pre>` +
        (r.images || []).map(img => `<img alt="" style="max-width:100%" src="data:${esc(img.mediaType)};base64,${esc(img.data)}">`).join('');
    } catch (e) { out.innerHTML = `<div class="notice bad small">${esc(e.message)}</div>`; }
  };

  function addForm(preset) {
    const p = preset || { name: '', entry: { command: '', args: [] } };
    const e = p.entry, t = e.url ? (e.type === 'sse' ? 'sse' : 'http') : 'stdio';
    const kv = (o, sep) => Object.entries(o || {}).map(([k, v]) => k + sep + (String(v).startsWith('${') ? '' : v)).join('\n');
    openModal(preset ? 'Add ' + p.name : 'Add an MCP server', `<form class="stack" data-form="vs-mcp-save">
      <div class="form-grid"><label>Name<input name="name" required value="${esc(p.name)}" placeholder="e.g. github"><span class="help">Tools are named mcp__name__tool.</span></label>
        <label>Where<select name="scope"><option value="user">Me, every project (~/.agentic/mcp.json)</option>${MC.projectFile ? '<option value="project">This project (.mcp.json, shared with the repository)</option>' : ''}</select></label></div>
      <label>Connection<select name="transport" data-change="vs-mcp-transport">
        <option value="stdio"${t === 'stdio' ? ' selected' : ''}>Program on this computer (stdio)</option>
        <option value="http"${t === 'http' ? ' selected' : ''}>HTTP (Streamable HTTP, sign-in with OAuth when the server asks)</option>
        <option value="sse"${t === 'sse' ? ' selected' : ''}>HTTP + SSE (older servers)</option></select></label>
      <div class="stack" data-show="stdio"><label>Command<input name="command" value="${esc(e.command || '')}" placeholder="npx, uvx, node, python, docker or a program's full path"></label>
        <label>Arguments<textarea name="args" rows="3" class="mono" placeholder="one per line">${esc((e.args || []).join('\n'))}</textarea></label></div>
      <div class="stack" data-show="http sse"><label>URL<input name="url" value="${esc(e.url || '')}" placeholder="https://example.com/mcp"></label>
        <label>Headers<textarea name="headers" rows="2" class="mono" placeholder="Authorization: Bearer ${esc(envRef('MY_TOKEN'))}">${esc(kv(e.headers, ': '))}</textarea></label></div>
      <label>Environment variables<textarea name="env" rows="3" class="mono" placeholder="API_KEY=…   (one per line; left empty: read from your environment)">${esc(kv(e.env, '='))}</textarea></label>
      <label class="check"><input type="checkbox" name="requireApproval"${e.requireApproval ? ' checked' : ''}> Ask before each tool call, in every permission mode</label>
      ${preset ? '' : `<details><summary>Or paste a config (Claude Code, Claude Desktop, Cursor or VS Code)</summary><textarea id="vs-mcp-paste" rows="6" class="mono" placeholder='{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }'></textarea></details>`}
      <div data-errors></div></form>`,
      `<button class="btn" data-act="modal-close">Cancel</button><button class="btn primary" data-act="vs-mcp-submit">Add and connect</button>`, 'wide');
    CHANGES['vs-mcp-transport']($('#modal-card select[name="transport"]'));
  }
  CHANGES['vs-mcp-transport'] = el => $$('#modal-card [data-show]').forEach(x => x.classList.toggle('hidden', !x.dataset.show.split(' ').includes(el.value)));
  ACTIONS['vs-mcp-add'] = () => addForm(null);
  ACTIONS['vs-mcp-submit'] = () => $('#modal-card form').requestSubmit();
  ACTIONS['vs-mcp-catalog'] = async el => {
    const r = catalog().find(x => x.id === el.dataset.id); if (!r) return;
    const entry = catalogEntry(r, MC.roots[0]);
    if ((r.env && r.env.length) || (r.args || []).includes('{folder}')) { addForm({ name: r.id, entry }); return; }
    el.disabled = true; el.textContent = 'Adding…';
    try { await mapi('mcp/save', { name: r.id, entry, scope: 'user' }); toast(`Added ${r.name} — connecting${r.url ? '' : ' (the first run downloads it)'}`, 'ok'); }
    catch (e) { toast(e.message, 'bad'); el.disabled = false; el.textContent = 'Add'; }
    refreshNow();
  };
  FORMS['vs-mcp-save'] = async f => {
    const v = n => (f.elements[n] ? f.elements[n].value : '').trim();
    const scope = v('scope') || 'user';
    const pasted = ($('#vs-mcp-paste') || {}).value || '';
    const errors = $('[data-errors]', f);
    try {
      if (pasted.trim()) {
        let j; try { j = JSON.parse(pasted); } catch { throw new Error('The pasted config is not valid JSON.'); }
        const servers = j.mcpServers || j.servers || (j.command || j.url ? { [v('name') || 'server']: j } : j);
        const names = Object.keys(servers || {});
        if (!names.length) throw new Error('No servers in the pasted config.');
        for (const n of names) await mapi('mcp/save', { name: n, entry: servers[n], scope });
        toast(`Added ${names.length} server${names.length === 1 ? '' : 's'}`, 'ok');
      } else {
        const t = v('transport');
        const entry = t === 'stdio' ? { command: v('command'), args: lines(v('args')) } : { type: t, url: v('url') };
        if (t === 'stdio' && !entry.command) throw new Error('Give the command that starts the server.');
        if (t !== 'stdio' && !/^https?:\/\//i.test(entry.url)) throw new Error('Give the server\'s http(s) URL.');
        const headers = pairs(v('headers'), ':');
        if (t !== 'stdio' && Object.keys(headers).length) entry.headers = headers;
        const env = Object.fromEntries(Object.entries(pairs(v('env'), '=')).map(([k, x]) => [k, x || envRef(k)]));
        if (Object.keys(env).length) entry.env = env;
        if (f.elements.requireApproval && f.elements.requireApproval.checked) entry.requireApproval = true;
        const name = v('name');
        if (!name) throw new Error('Give the server a name.');
        await mapi('mcp/save', { name, entry, scope });
        toast(`Added ${name} — connecting`, 'ok');
      }
      closeModal();
      refreshNow();
    } catch (e) { if (errors) errors.innerHTML = `<div class="notice bad small">${esc(e.message)}</div>`; else toast(e.message, 'bad'); }
  };
  // "Install on my computer" from the web app's My MCP servers page: the server sends the MCP server to this window, which
  // opens the add form filled in (nothing is added until the user clicks Add).
  const installs = new Set();
  document.addEventListener('chathub', ev => {
    const m = ev.detail || {};
    if (m.type !== 'mcp_install' || !m.data || installs.has(m.data.id)) return;
    installs.add(m.data.id);
    navigate('/local/mcp');
    setTimeout(() => { addForm({ name: m.data.name, entry: m.data.entry || {} }); toast('An MCP server from the web app: check it, fill in any keys, then Add', 'ok'); }, 600);
  });
})();


/* Lite mode: the chat only, looking like Claude Code's terminal (monospace, "> you", "● answer", "● Tool …" lines,
   "⎿" details), with the rest of the web app out of the way. Same page, same chat logic: tools, approvals, subagents,
   commands, hooks and the rest work as in the full app. The extension opens the page with ?lite=1 (setting
   agentic.chat.mode); a page that lands elsewhere (sign-in, a link) switches the extension to the full app instead. */
(function () {
  const params = new URLSearchParams(location.search);
  let lite;
  if (params.has('lite')) { lite = params.get('lite') === '1'; try { sessionStorage.setItem('vscode.lite', lite ? '1' : '0'); } catch { /* ignore */ } }
  else { try { lite = sessionStorage.getItem('vscode.lite') === '1'; } catch { lite = false; } }
  const pane = typeof IN_PANE !== 'undefined' && IN_PANE;
  if (!lite || pane) return;
  const html = document.documentElement;
  html.classList.add('vs-lite');
  const toHost = m => { if (window.parent && window.parent !== window) { try { window.parent.postMessage(Object.assign({ source: 'agentic-layer' }, m), '*'); } catch { /* gone */ } } };

  // The chat list is hidden; its button shows it over the chat (html.vs-side), and picking a chat hides it again.
  if (typeof ACTIONS !== 'undefined') ACTIONS['chat-side'] = () => html.classList.toggle('vs-side');
  // It closes when a chat is picked, with its × button, with Escape, or with a click anywhere else (the model picker, the thread).
  document.addEventListener('click', ev => {
    if (!html.classList.contains('vs-side')) return;
    if (ev.target.closest('.chat-side .chat-item, .chat-side .new-chat-btn')) { html.classList.remove('vs-side'); return; }
    if (!ev.target.closest('.chat-side, [data-act="chat-side"], #modal, #palette')) html.classList.remove('vs-side');
  }, true);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && html.classList.contains('vs-side')) html.classList.remove('vs-side'); }, true);
  const addClose = () => {
    const top = document.querySelector('.chat-side .chat-side-top');
    if (!top || top.querySelector('.vs-side-close')) return;
    const b = document.createElement('button');
    b.className = 'btn icon ghost vs-side-close';
    b.setAttribute('data-act', 'chat-side');
    b.setAttribute('aria-label', 'Close the chats');
    b.setAttribute('data-tip', 'Close the chats (Esc)');
    b.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    top.appendChild(b);
  };
  // Added again when the chat page is drawn (#main changes) or a chat opens - not on every change in the page: watching the
  // whole page ran this on every word of an answer being written.
  const onChatDrawn = fn => {
    const main = document.getElementById('main');
    if (main) new MutationObserver(fn).observe(main, { childList: true });
    document.addEventListener('chat:mounted', fn);
  };
  onChatDrawn(addClose);
  addClose();

  // Only the chat here: another page (a link in an answer, the palette, /artifacts) opens in the full app.
  if (typeof navigate === 'function') {
    const real = navigate;
    window.navigate = function (path, push) {
      const p = String(path || '/chat').split('?')[0];
      if (/^\/chat(\/|$)/.test(p)) return real.call(this, path, push);
      toHost({ type: 'openFull', path: String(path || '/') });
      return undefined;
    };
  }

  // A "Full app" button in the chat's top bar (the extension switches the mode and reloads the page).
  const FULL_ICON = '<svg viewBox="0 0 24 24" class="ic"><path d="M4 4h16v16H4zM4 9h16M9 9v11"/></svg>';
  const addButton = () => {
    const top = document.querySelector('.chat-top');
    if (!top || top.querySelector('.vs-full-btn')) return;
    const b = document.createElement('button');
    b.className = 'btn ghost small vs-full-btn';
    b.setAttribute('data-act', 'vs-full');
    b.setAttribute('data-tip', 'Open the full Agentic app in this view (every page: agents, artifacts, images, settings …)');
    b.innerHTML = FULL_ICON + ' Full app';
    const head = top.querySelector('.chat-head');
    top.insertBefore(b, head || null);
  };
  onChatDrawn(addButton);
  addButton();
  if (typeof ACTIONS !== 'undefined') ACTIONS['vs-full'] = () => toHost({ type: 'openFull', path: location.pathname });
})();
