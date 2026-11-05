// Runs integration/suite.js inside a real VS Code (the installed one, or VSCODE_EXE) with an isolated profile and a
// temporary workspace: node integration/run.js
const path = require('path');
const os = require('os');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');

// Started from inside VS Code (an extension host, a terminal task) this is set, and Code.exe would run as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

(async () => {
  const ext = path.resolve(__dirname, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-it-'));
  const ws = path.join(tmp, 'workspace');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'hello.txt'), 'alpha\nbeta\ngamma\n');
  fs.writeFileSync(path.join(ws, 'dup.txt'), 'dup dup\n');
  const version = JSON.parse(fs.readFileSync(path.join(ext, 'package.json'), 'utf8')).version;
  const vsix = [path.join(ext, `agentic-vscode-${version}.vsix`)].find(f => fs.existsSync(f)) || '';
  const exe = process.env.VSCODE_EXE || path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe');
  const code = await runTests({
    vscodeExecutablePath: exe,
    extensionDevelopmentPath: ext,
    extensionTestsPath: path.join(__dirname, 'suite.js'),
    launchArgs: [ws, '--user-data-dir', path.join(tmp, 'user'), '--extensions-dir', path.join(tmp, 'ext'),
      '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu'],
    // The update test installs the packaged .vsix (npm run package first; skipped without it) into this profile.
    extensionTestsEnv: { AGENTIC_IT_WS: ws, AGENTIC_API_KEY: 'it-key', AGENTIC_IT_EXTDIR: path.join(tmp, 'ext'), AGENTIC_IT_VSIX: vsix }
  });
  process.exit(code);
})().catch(e => { console.error('integration run failed:', e); process.exit(1); });
