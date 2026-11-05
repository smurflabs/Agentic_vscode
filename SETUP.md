# Setting up Agentic for VS Code

The extension brings your Agentic server's Chat into VS Code. Workspace tools (read, edit, search, run) work through VS Code's own APIs. [README.md](README.md) lists the commands and settings.

## 1. What you need

- **A running Agentic server.** See the Agentic repository's `SETUP.md`.
- **An account on that server:**
  - **Chat & model API** for Chat.
  - **Chat tools & code** as well, to use the server's tools from Chat.
- **A personal API key.** In the web app, open the user menu → **API key** → **Generate**.
- **VS Code 1.90 or later.**
- **To build from source:** [Node.js](https://nodejs.org/) 20 or later and npm. `vsce`, the packaging tool, does not run on Node 18.

## 2. Install

### From your server (no build)

When the server's administrator has published the extension (Agentic `SETUP.md`, section 9):
1. Download `agentic-vscode-<version>.vsix` from **Apps & updates** in the web app.
2. Install it:

   ```
   code --install-extension agentic-vscode-<version>.vsix
   ```

   Or use VS Code's Extensions view → `…` → **Install from VSIX…**.

### From source

```
git clone <this repository> Agentic_vscode
cd Agentic_vscode
npm ci                      # exact versions from package-lock.json
npm test                    # compile + unit and proxy tests
npm run package             # agentic-vscode-<version>.vsix
code --install-extension agentic-vscode-<version>.vsix
```

To try changes without installing, compile and start VS Code with the extension loaded from this folder:

```
npm run compile             # or: npm run watch
code --extensionDevelopmentPath="<full path to this folder>"
```

`npm run test:integration` starts the installed VS Code with an isolated profile and a temporary workspace, and runs the end-to-end suite (`integration/`).

## 3. Sign in

1. Run **Agentic: Sign In** from the Command Palette, or click *Agentic: Sign in* in the status bar.
2. Enter your server's address, for example `https://agentic.example.com` or `http://127.0.0.1:8080`.
3. Enter your API key.

The key is kept in VS Code's secret storage. The address is the `agentic.serverUrl` setting. The `AGENTIC_SERVER` and `AGENTIC_API_KEY` environment variables also work, as in the Agentic CLI.

## 4. Using it

- Open Agentic from the activity bar (or the secondary side bar).
- **Explain / Fix / Review** act on the editor selection.
- The model's workspace tools ask before they change files or run commands. Settings:
  - `agentic.tools.enabled` turns the tools on or off.
  - `agentic.tools.allowCommands` allows or blocks shell commands.
  - `agentic.tools.shell` picks the shell.
  - `agentic.tools.commandTimeoutSeconds` limits how long one command may run.
- **Dictation mode** records with Windows PowerShell on Windows (nothing to install). On Linux it needs `parecord`, `arecord`, `sox` or `ffmpeg`, and on macOS `sox` or `ffmpeg`. Set `agentic.speech.recorder` to choose one.

## 5. Updates

The extension checks your server for newer versions (`agentic.updates.enabled`) and installs them (`agentic.updates.automatic`).

To release a new version from source:
1. Raise `version` in `package.json`.
2. Run `.\tools\publish-clients.ps1 -Apps vscode` in the Agentic repository, with this repository cloned next to it. The script builds the `.vsix` into the server's updates folder.

**Publishing your own build to the Marketplace:** change `publisher` in `package.json` to your own publisher id. The integration suite looks the extension up as `<publisher>.agentic-vscode`, so update `integration/suite.js` to match.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| `npm run package` fails with `File is not defined` | Use Node.js 20 or later. |
| *Agentic: Sign in* stays in the status bar | Run **Agentic: Sign In** again. Check the address and that the server answers `/healthz`. |
| 401 / 403 in the chat | Generate a new key, or ask an administrator for **Chat & model API**. |
| Integration tests start VS Code as plain Node | `ELECTRON_RUN_AS_NODE` is set (as in VS Code's own terminal); `integration/run.js` clears it, so start the tests through `npm run test:integration`. |

## License

Agentic for VS Code is free software, licensed under the GNU General Public License v3.0 or later. See [LICENSE](LICENSE).
