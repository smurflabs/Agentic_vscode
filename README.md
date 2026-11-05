<div align="center">

<img src="docs/logo.png" alt="Agentic" width="288">

**Agentic for VS Code: your Agentic server's chat inside VS Code, with tools that read, edit and run code in your workspace.**

![License: GPL v3](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)
![VS Code 1.90+](https://img.shields.io/badge/VS%20Code-1.90%2B-007ACC)

[Install](#install) · [Features](#features) · [Settings](#settings) · [Setup guide](SETUP.md) · [Agentic server](https://github.com/smurflabs/Agentic)

</div>

---

## What is it?

Agentic for VS Code brings the chat of your [Agentic server](https://github.com/smurflabs/Agentic) into the editor. It is the same app as in the browser and the desktop app, with the same models, conversations and settings. The model gets tools that work through VS Code itself: its edits show in the editor and can be undone, it sees the Problems panel, and it runs commands in your workspace with your approval.

The extension runs a small local server on `127.0.0.1`. That server forwards requests to your Agentic server and adds your API key, so the page never sees the key.

## Features

### The full Agentic chat

- **Chat with every model your account may use,** including custom models. Goals, plan mode, reasoning effort, web search, knowledge bases, attachments, images, saved prompts and slash commands all work here.
- **Two views:** **Full app** has every page of the web app, and **Lite mode** shows only the chat, like Claude Code.
- **Multitask:** up to four chats side by side, all live at once.
- **Always current:** history and live answers stay in step with the web and desktop apps.

### Tools that work through VS Code

- **Read and search** the workspace, including unsaved changes in open editors.
- **Edits go through VS Code,** so they show in the editor and Ctrl+Z undoes them. You can review an edit before it is applied.
- **Problems panel:** the model reads VS Code's diagnostics to check its own work.
- **Editor context:** the active file, the selection and the open editors ("explain *this*").
- **Commands** in the workspace, in PowerShell or bash.
- **Local MCP servers,** including the ones you set up for VS Code or Claude Code, with sign-in for hosted servers.
- **Approvals:** changes and commands follow the chat's permission mode, and paths outside the workspace are refused.
- **Use from other windows:** while VS Code is open, chats in the web and desktop apps can use this workspace's tools.

### Editor commands

- **Ask About Selection** (Ctrl+Alt+L), **Explain This Code**, **Fix This Code** and **Fix This Problem**, with the problems VS Code reports for that code.
- **Review This File**, **Fix Problems in This File** and **Add File to Chat**, from the editor, its tabs or the Explorer.
- **Open the chat** with Ctrl+Alt+A, or in an editor tab.

### Run, preview and share

- **Run Project…** finds how each workspace folder runs: `.agentic/launch.json` or `.claude/launch.json`, or what the project shows (npm scripts, static sites, Python, .NET, Go, Rust, Makefiles).
- **Runs in a terminal:** each run gets its own terminal tab, and web apps open in the Simple Browser beside the chat.
- **Artifacts:** projects and chat pages can be shared as public links.

### And more

- **Voice:** answers read aloud and hands-free Dictation mode with the server's voices. The extension records the microphone itself.
- **Media tabs:** Images, Music and Audio open the server's media tabs in an editor tab.
- **Agentic CLI link:** the CLI's `/ide` sends your selection, shows its edits as diffs here and reads the Problems panel.
- **Keyboard shortcuts:** change the chat's keys and VS Code's keys for Agentic in one place.
- **Updates:** the extension installs new versions from your Agentic server.

## Install

1. Download `agentic-vscode-<version>.vsix` from this repository's [Releases](https://github.com/smurflabs/Agentic_vscode/releases) or from **Apps & updates** in the Agentic web app.
2. Install it:

   ```text
   code --install-extension agentic-vscode-<version>.vsix
   ```

   You can also use the Extensions view: **…** → **Install from VSIX…**.
3. Run **Agentic: Sign In** and enter your server's address and an API key. To create the key, open the web app's user menu, then **API key** → **Generate**.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `agentic.serverUrl` | (empty) | Your Agentic server |
| `agentic.chat.mode` | `full` | `full` (every page of the web app) or `lite` (chat only) |
| `agentic.tools.enabled` | `true` | Workspace tools for the model |
| `agentic.tools.allowCommands` | `true` | Let the model run shell commands |
| `agentic.tools.shell` | `auto` | Shell for commands: PowerShell on Windows, bash or sh elsewhere |
| `agentic.tools.commandTimeoutSeconds` | `120` | How long a command runs before it goes on in the background |
| `agentic.tools.ideTools` | `true` | Definitions, references and symbols from VS Code's language servers |
| `agentic.tools.wholeComputer` | `false` | Let the tools work on files outside the workspace |
| `agentic.tools.reviewEdits` | `true` | In Manual permission mode, show each change as a diff to accept or reject |
| `agentic.mcp.includeVsCode`, `agentic.mcp.includeClaude` | `true` | Also use the MCP servers set up for VS Code, Claude Code and Claude Desktop |
| `agentic.codeActions.enabled` | `true` | "Fix with Agentic" and "Explain with Agentic" in the light bulb menu |
| `agentic.ide.bridge` | `true` | Let the Agentic CLI's `/ide` connect to this workspace |
| `agentic.chat.sendSelectionCommandsImmediately` | `true` | Explain, Fix and Review send at once (off: fill the message box) |
| `agentic.chat.animations` | `calm` | `calm`, `full` or `off` |
| `agentic.speech.recorder` | (empty) | Dictation's recorder. Empty means PowerShell on Windows, or `parecord`, `arecord`, `sox` or `ffmpeg` elsewhere |
| `agentic.updates.enabled`, `agentic.updates.automatic` | `true` | Check the server for new versions, and install them without asking |

The `AGENTIC_SERVER` and `AGENTIC_API_KEY` environment variables also work, as in the Agentic CLI.

## Building

```text
npm ci
npm test                    # compile, then unit and proxy tests
npm run package             # agentic-vscode-<version>.vsix (Node.js 20 or later)
npm run test:integration    # real VS Code, isolated profile, temporary workspace
```

[SETUP.md](SETUP.md) covers development runs and releases.

## License

Agentic for VS Code is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License](LICENSE) as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
