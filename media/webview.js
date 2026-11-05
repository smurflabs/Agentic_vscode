// Runs in the VS Code webview around the Agentic page (a frame from the local proxy). Relays messages both ways: from
// the extension to the page (held until the page says it is ready), and from the page to the extension. Also tells the
// page VS Code's theme (light, dark or high contrast), now and whenever it changes.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const frame = document.getElementById('app');
  const wait = document.getElementById('wait');
  const origin = frame.dataset.origin;
  let ready = false;
  const queue = [];

  const theme = () => {
    const c = document.body.classList;
    return c.contains('vscode-light') || c.contains('vscode-high-contrast-light') ? 'light' : 'dark';
  };
  const toPage = m => { try { frame.contentWindow.postMessage(Object.assign({ source: 'agentic-vscode' }, m), origin); } catch { /* reloading */ } };
  // The motion choice (calm, full, off) comes from the extension's settings: on the frame, updated by a 'motion' message.
  const sendTheme = () => toPage({ type: 'theme', theme: theme(), motion: frame.dataset.motion || 'calm' });

  window.addEventListener('message', ev => {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (ev.source === frame.contentWindow) {
      // From the page.
      if (m.source !== 'agentic-layer') return;
      if (m.type === 'ready') {
        ready = true;
        wait.classList.add('gone');
        sendTheme();
        while (queue.length) toPage(queue.shift());
      }
      vscode.postMessage(m);
      return;
    }
    // From the extension.
    if (m.source !== 'agentic-vscode') return;
    if (m.type === 'reload') { ready = false; wait.classList.remove('gone'); frame.src = frame.src; return; }
    if (m.type === 'motion') { frame.dataset.motion = m.motion || 'calm'; if (ready) sendTheme(); return; }
    if (ready) toPage(m); else queue.push(m);
  });

  // The page reloads by itself (sign-in, navigation by URL): wait for its "ready" again.
  frame.addEventListener('load', () => { setTimeout(() => { if (!ready) wait.classList.add('gone'); }, 8000); });
  new MutationObserver(() => { if (ready) sendTheme(); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
})();
