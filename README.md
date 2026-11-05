# Agentic for VS Code

Your Agentic server's chat, inside VS Code — the same app the Agentic desktop client shows, with tools that work in
your workspace.

**Setting it up:** `SETUP.md` in this repository covers installing, building from source and signing in to your server.

## What you get

- **The full Agentic chat** in the activity bar (or an editor tab): every provider model and custom model (Axiom,
  Onyx, Zenith…), goals, plan mode, reasoning effort, web search, knowledge bases, attachments, images, saved prompts,
  slash commands, multitask panes, history — everything the web and desktop apps have, always in step with your server.
- **Workspace tools for the model** (the "Workspace" chip in the message box turns them on or off):
  - `read_file`, `list_dir`, `glob_files`, `grep` — read and search, including unsaved changes in open editors
  - `write_file`, `edit_file` — changes go through VS Code, so they show in the editor and can be undone (Ctrl+Z)
  - `vscode_diagnostics` — errors and warnings from the Problems panel, to check its own edits
  - `vscode_editor_context` — the active file, the selection and the open editors ("explain *this*")
  - `run_command` — shell commands in the workspace (output also in *Agentic: Commands*)
  - `open_file` — show you a file at a line
  - `agentic_api` — the Agentic REST API as you (agents, tasks, results…)

  Changes, commands and API writes are approved in the chat according to its permission mode, exactly as in the
  desktop app. Paths outside the open workspace folders are refused.
- **Run and test the project** (like Claude Desktop's preview): the **Run** chip in the message box (or `/run`; `/run <name>`,
  `/run stop`, `/run share`), the ▶ button on the chat view and *Agentic: Run Project…* list the ways to run each workspace folder — `.agentic/launch.json`
  or Claude Code's `.claude/launch.json` (`{"configurations": [{"name", "runtimeExecutable", "runtimeArgs", "cwd", "port"}]}`;
  `command` and `kind`: web | app | test | static also work), else what the project shows (package.json scripts, a static
  site served by a built-in server, Django/Flask/FastAPI, pytest, .NET, Go, Rust, a Makefile). Each run gets a terminal tab
  ("Agentic: Dev server"; closing it stops the run). A web app opens in the Simple Browser beside the chat once its address
  appears; tests show their output and exit code in the chat, with **Ask Agentic to fix it**. The model's `preview` tool does
  the same (status, start, open, stop, share).
- **Read aloud and Dictation mode** with the server's voices: an answer's speaker button reads it aloud as the speech server
  makes it, and Dictation mode (the headset button, or `/dictation`) talks with the chat. VS Code's views cannot use the
  microphone, so the extension records it (Windows: PowerShell with the system's waveIn API, nothing to install; Linux and
  macOS: see `agentic.speech.recorder`); a pause ends your turn, the server turns it into text, and each answer's short
  spoken summary is spoken.
- **Images, Music and Audio**: *Agentic: Images*, *Agentic: Music* and *Agentic: Audio* (also in the chat view's ⋯ menu)
  open those tabs of the web app in an editor tab: pictures from Stable Diffusion, songs from Suno, speech and voices.
- **Artifacts** (*Agentic: Artifacts: Run and Share Projects*, the chat view's ⋯ menu, or `/artifacts`): the projects and the
  pages and drawings from your chats, to run or share. **Share** uploads a project's website (its build — `dist`, `build`,
  `out` … — or a static site's folder; no hidden files or `node_modules`) or a chat page and gives a public link anyone can
  open; sharing the project again updates the same link.
- **Your VS Code as a device**: while VS Code is open, chats started in the web or desktop app can use these tools too.
- **Editor commands** (right-click → *Agentic*, or the Command Palette):
  - *Ask About Selection* (Ctrl+Alt+L) — puts the selected code into the message box
  - *Explain This Code*, *Fix This Code* — with the problems VS Code reports for it
  - *Review This File*, *Fix Problems in This File*
  - *Add File to Chat* — attaches a file (also from the Explorer and editor tabs)
  - *New Chat*, *Open Chat in Editor*, *Open Agentic in Browser*, *Reload Chat*
- **Multitask**: up to four chats side by side, each live at once — *Agentic: Multitask* (the layout button on the chat
  view). It opens in a wide editor tab (the side bar is too narrow for it); editor commands go to the focused pane.
- **Updates itself** from your Agentic server: when VS Code starts and every few hours it checks the server's
  *Apps & updates*, downloads a newer build, checks its SHA-256 and installs it (you are asked to reload the window).
  *Agentic: Check for Updates* checks now.
- Follows VS Code's light or dark theme, with calm page animations (`agentic.chat.animations`; VS Code's
  *Reduce Motion* turns them off). Open the chat with **Ctrl+Alt+A**.
- **Agentic: Keyboard Shortcuts** changes any shortcut: the chat's own (send, new line, new chat, palette … — saved to your Agentic
  account, so the browser and the desktop app use them too) or VS Code's for Agentic's commands (VS Code's Keyboard Shortcuts,
  filtered to Agentic, saved in your keybindings.json).

## Sign in

Run **Agentic: Sign In** (or click *Agentic: Sign in* in the status bar) and enter your server's address and an API
key (Agentic web app → your account → API keys). The key is kept in VS Code's secret storage. As with the Agentic CLI,
the `AGENTIC_SERVER` and `AGENTIC_API_KEY` environment variables work too.

## How it works

Like the desktop app, the extension runs a small web server on `127.0.0.1` that forwards to your Agentic server with
the API key added (the page never sees the key) and adds a VS Code layer to the app. The layer offers the workspace
tools through the chat's client-tool interface (`window.chatClient`); the tools run in the extension through VS Code's
APIs. The layer talks to the extension with a per-launch token.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `agentic.serverUrl` | | Your Agentic server |
| `agentic.tools.enabled` | `true` | Workspace tools for the model |
| `agentic.tools.allowCommands` | `true` | Let the model run shell commands |
| `agentic.tools.shell` | `auto` | Shell for commands (PowerShell 7 / Windows PowerShell on Windows, bash / sh elsewhere) |
| `agentic.tools.commandTimeoutSeconds` | `120` | Time limit for one command |
| `agentic.chat.sendSelectionCommandsImmediately` | `true` | Explain / Fix / Review send at once (off: fill the message box) |
| `agentic.chat.animations` | `calm` | `calm` (fades), `full` (the web app's animations) or `off` |
| `agentic.speech.recorder` | | Dictation mode's recorder. Empty: Windows PowerShell (nothing to install) on Windows; `parecord`, `arecord`, `sox` or `ffmpeg` on Linux; `sox` or `ffmpeg` on macOS. Or a command that writes 16-bit mono PCM at 16 kHz to stdout |
| `agentic.updates.enabled` | `true` | Check the Agentic server for new versions |
| `agentic.updates.automatic` | `true` | Install them without asking first |

## Publishing to your server

`Agentic\tools\publish-clients.ps1 -Apps vscode` builds the .vsix and puts it in the server's updates folder
(`updates\vscode`); the web app's *Apps & updates* page then offers it for download, and installed copies update to it.
Bump `version` in package.json for each release.

## Build

```
npm install
npm test          # compile + unit and proxy tests
npm run package   # agentic-vscode-<version>.vsix (needs Node 20+)
npm run test:integration   # real VS Code, isolated profile, temp workspace
code --install-extension agentic-vscode-0.1.0.vsix
```

## Not in this version (desktop app only)

Local MCP servers, Claude Code as a chat model, Claude Code skills, screenshots, global hotkeys and the tray icon.

## License

Agentic for VS Code is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It comes WITHOUT ANY WARRANTY. See the `LICENSE` file for the full text.
