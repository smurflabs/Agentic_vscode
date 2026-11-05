# Changelog

## 0.2.24

- Light bulb (Ctrl+.): "Fix with Agentic" on a problem VS Code reports, and "Explain with Agentic" / "Fix with Agentic" on a selection (setting agentic.codeActions.enabled).
- Edit review: the proposed side of the diff is a real file, so you can revert single changes with the arrows in the diff's margin (or edit it) and Accept the rest; the model hears that you kept only part.
- Code blocks in the chat: Apply to a file (VS Code's diff first), Insert at the cursor, or Save as a new file.
- /plugin: Claude Code plugins - their commands, skills, agents, hooks and MCP servers work in the chat; turn them on or off, add a marketplace and install from it (a Claude Code plugin's hooks run once you turn it on here).
- IDE bridge for the Agentic CLI (/ide in a terminal of this workspace): it sees your open file and selection and VS Code's problems, and shows its edits here as diffs (setting agentic.ide.bridge).
- /feedback sends this extension's log with the report; ! commands in the message box run in this workspace.
- Lite mode: the new Find, Outline and Transcript buttons fit the narrow chat bar.

## 0.2.23

- Lite mode no longer watches every change in the page (it ran on every word of an answer being written): its buttons are added when the chat is drawn. Long chats stay smooth (with the server's chat fixes: tool cards drawn when opened, a window sized by weight, file links indexed once).

## 0.2.22

- Lite mode: the attach, tools, reasoning effort and permission mode menus open above the message box at every width (they were clipped).
- Lite mode: narrow views drop the chips you need least first (images, videos, Stable Diffusion, music, money, stocks, Polymarket, news at 820px; files, knowledge, limits, caveman at 620px; code, instructions, mic at 460px) instead of pushing the row off screen.
- Lite mode: the user button looks the same at every width and its menu opens under it; the Full app button goes at 400px and the user button at 340px.

## 0.2.21

- Lite mode: the user menu (theme, sounds, shortcuts, balance, sign out) is at the top right.

## 0.2.20

- Lite mode: the chats overlay has a close button, and closes with Escape or a click anywhere else (the model picker, the thread).

## 0.2.19

- Lite mode: the device chip in the chat bar (the computer whose tools the chat uses) is small, with the name cut short.

## 0.2.18

- Lite mode: the tool chips, the effort and permission controls and the send button sit on one line under the message box, as in
  the full app.

## 0.2.17

- Lite mode in a wide view (an editor tab, full screen) no longer squeezes the chat into a narrow column: the chat list is an
  overlay the chats button opens, in every width.
- Lite mode: the tool chips under the message box show only their icons (the name is in the tooltip).

## 0.2.16

- **Lite mode.** The Agentic view can show only the chat, looking like Claude Code: a monospace transcript with `>` before
  what you said, `●` before each answer and tool call, and `⎿` before the details; a plain `>` message box with the
  mode, effort and context controls under it. Everything the chat does works the same: tools in the workspace, approvals,
  Shift+Tab, `/commands`, MCP servers, subagents, hooks, Rewind. Links to other pages open the full app.
  - Switch with the button in the view's title bar, **Agentic: Lite Mode** / **Agentic: Full App**, the **Lite** chip in
    the chat, or the **Full app** button in lite mode. The choice is the setting `agentic.chat.mode` (`full` or `lite`).
  - The chat list is hidden in lite mode; the chats button opens it over the chat.

## 0.2.15

- **MCP servers, the easy way.** *Agentic: MCP Servers* (also `/mcp` in the chat) lists every server this VS Code can use, with its
  state, tools and log:
  - its own (`~/.agentic/mcp.json`, the project's `.mcp.json`);
  - the ones you already set up in Claude Code (`~/.claude.json`, its plugins), Claude Desktop and VS Code itself
    (`.vscode/mcp.json`, your user `mcp.json`). They are used as they are; nothing to import.
  - **Add server** takes a command or a URL, or a pasted config. Well-known servers are one click.
  - Switch any server on or off, reconnect it, or try its tools.
- **Hosted servers**: Streamable HTTP and the older HTTP+SSE, with **Sign in** (OAuth in the browser) for servers that need it.
  Tokens are kept in VS Code's secret storage.
- **Safer projects.** A project's servers start only after you allow them; a cloned repository no longer starts programs
  from its `.mcp.json` by itself.
- **More from MCP servers:**
  - pictures (a browser's screenshots) go to the model;
  - `${VAR}` and `${VAR:-default}` in configs;
  - resources (`list_mcp_resources`, `read_mcp_resource`);
  - prompts as `/mcp__server__prompt` commands;
  - questions a server asks you while a tool runs (input boxes).
- **VS Code's own abilities for the model:**
  - `ide_navigate`: definitions, references, symbols and types from the language servers;
  - `ide_refactor`: rename, quick fixes and format, all undoable;
  - `ide_run`: tasks and the debugger, with the debug console's output;
  - `vscode_command`: any VS Code command, approved each time;
  - `fetch_url`: localhost, the LAN and the intranet;
  - other extensions' tools (`vscode.lm.tools`).
- **Claude Code's permission rules** in `.claude/settings.json` (and `.agentic/settings.json`) apply to the chat:
  - `deny` blocks;
  - `ask` asks, in Auto mode too;
  - `allow` never asks;
  - `additionalDirectories` adds folders.
- **Outside the workspace**: a file outside the workspace asks (allow it or its folder) instead of failing.
  `agentic.tools.wholeComputer` lets the tools use files anywhere.
- **Hooks editor** in `/hooks`: add a hook, try it with a sample input, remove it.

## 0.2.14

- **Read before change.** Like Claude Code, `edit_file`, `write_file` and `edit_notebook` change an existing file only after the chat
  read it with `read_file` (or you attached it with `@`), and not when it changed since: the model reads it again first.
- **Your unsaved work stays yours.** An edit to a file with unsaved changes in the editor is made in the editor but not saved for you.
- **Pictures.** `read_file` of a PNG, JPEG or WebP gives the model the picture.
- **A `cd` carries over** to the chat's later commands (PowerShell, bash, sh, zsh), inside the workspace folders.
- **Hooks like Claude Code's.** JSON answers (`decision`, `permissionDecision`, `updatedInput`, `additionalContext`, `continue`),
  `PostToolUseFailure`, `PermissionRequest` (answers an approval card first), `Notification`, `PreCompact`/`PostCompact`,
  `SubagentStart`/`SubagentStop`, each hook's `timeout`, and `session_id`, `permission_mode` and `tool_use_id` in their input.
  A hook that exits with 2 now blocks under PowerShell too (PowerShell used to turn every failure into exit code 1).
  `agentic.hooks.includeClaudeUser` also runs the hooks in `~/.claude/settings.json`.
- **Line endings** of a file with mixed endings change only on the lines that were edited.

## 0.2.13

- **Claude Code as a model.** When the claude CLI is installed, "Claude Code" is a model in the chat, as in the desktop app. It runs on
  this computer with your own Claude account, tools, MCP servers, skills and settings, and continues its session. The Claude chip
  holds its model, effort, permission mode, folder and more. Its permission prompts and questions show as the chat's approval and
  question cards.
- **More hooks.** `UserPromptSubmit` runs before a message is sent: exit code 2 stops it, and what it prints goes with the message.
  `SessionStart` runs the first time a chat is used in this window.
- **Your own subagent types.** Agent files in `.claude/agents` or `.agentic/agents` (the project's or your home folder's) are offered
  to the model's task tool. Each works by its file's instructions with only the tools it lists. `/agents` lists them and creates new ones.
- **New chat commands:**
  - `/bashes` (or `/tasks`) and `/monitors`: the commands running in the background, with a Stop button.
  - `/worktree [name | list | done | remove <name>]`: work in a git worktree on its own branch.
  - `/diff`: the working tree's changes.
  - `/hooks`: your hooks.
  - `/skills`: your skills and commands.

## 0.2.12

- **Edits land more often.** `edit_file` now:
  - leaves out line numbers copied from `read_file`;
  - matches text whose only difference is spaces at line ends;
  - treats an edit that changes nothing as done;
  - when the text is not in the file, shows the closest lines with their numbers, so the next try can be right.
- **Tools installed after VS Code started are found.** On Windows, commands get the PATH as it is now in the registry, so
  `node`, `git` or `dotnet` installed later are no longer "not recognized".
- **More project instructions.** `CLAUDE.md`, `.claude/CLAUDE.md`, `AGENTS.local.md` and `CLAUDE.local.md` are read as
  well, and all of them, not only the first one found.

## 0.2.11

- **Dictation mode works in VS Code.** Its views cannot use the microphone, so the extension records it: Windows PowerShell
  with the waveIn API (nothing to install), or `parecord` / `arecord` / `sox` / `ffmpeg` (setting `agentic.speech.recorder`).
  Your pause ends the turn (the web app's pause, length and sensitivity settings), the Agentic server turns it into text,
  and each answer's spoken summary is spoken in your voice. Send, Pause and End work as in the web app.
- **Images, Music and Audio** open in an editor tab: *Agentic: Images*, *Agentic: Music*, *Agentic: Audio* (also in the chat
  view's ⋯ menu).

## 0.2.10

- **Commands never get stuck.** `run_command` waits up to `wait_seconds` (default `agentic.tools.commandTimeoutSeconds`, 120) for a command;
  one still running then is not stopped but goes on in the background, and the model gets its id and the output so far. It also
  returns as soon as the shell ends, even when something the command started (a server) keeps its output open - that used to
  hang the call until the server gave up after 15 minutes.
- **`run_command_background`** starts a command in the background at once. **`command_output`** audits a background command: running
  or finished (exit code), for how long, how long since it last printed something, its new output, and a warning when it seems to
  wait for input or to be stuck; `wait_seconds` waits for it to finish or print more. Without an id it lists them all.
- `kill_command` also stops what a finished shell left running (Windows), and background commands get their own process group
  elsewhere, so stopping one stops what it started.
- **Files open from the chat**, like Claude Code: the path in a tool card (Read, Edit, Write), a file in an answer's
  **Changed N files** list, and `src/app.js` written in an answer (when the chat worked on that file) open in the editor.
  An edit opens at the text it wrote.
- The side bar's top bar is slimmer and leaves out the logo (the view title already says Agentic).

## 0.2.9

- **Run and test the project** (like Claude Desktop's preview): the **Run** chip in the chat, the ▶ button on the chat
  view and **Agentic: Run Project…** list the ways to run the workspace — `.agentic/launch.json` (or Claude Code's
  `.claude/launch.json`), else what the project shows (package.json scripts, a static site, Python, .NET, Go, Rust, a
  Makefile). Each run gets a terminal tab (closing it stops the run); a web app opens in the Simple Browser beside the chat
  once it has an address; tests show their output and exit code, with **Ask Agentic to fix it**. A static site is served by
  a small built-in server. The model gets a **preview** tool for the same (after it builds something you can run).
  `/run <name>` starts one, `/run stop`, `/run share [project]`. Every workspace folder is a project.
- **Artifacts** (**Agentic: Artifacts: Run and Share Projects**, the chat view's ⋯ menu, `/artifacts`): the workspace's
  projects with their ways to run, and the pages and drawings from your chats. **Share** gives a project's website (its
  build, or a static site's folder) or a chat page a public link anyone can open; sharing again updates the same link.
- **Notifications**: when an answer finishes or a chat needs you while the chat is out of view (or VS Code is in the
  background), VS Code shows a notification with **Open Chat**. Switch it off with `/notify off` or in the user menu.
- New chat commands (server): `/btw` (a side question answered aside), `/recap`, `/research` (deep research with
  cited sources), `/fork`, `/loop`, `/schedule`, `/security-review`, `/simplify` and `/verify`.
- **monitor** tool: the model can watch a command (a log, a dev server, a watch build); its output lines go into the
  chat as they happen and the server answers them when the chat is not busy.

## 0.2.8

- **Agentic: Keyboard Shortcuts** changes any shortcut: the chat's own (send, new line, new chat, command palette,
  multitask …; saved to your Agentic account, so the browser and the desktop app use them too) or VS Code's shortcuts for
  Agentic's commands (VS Code's Keyboard Shortcuts, filtered to Agentic).
- With animations off, the server's Swagger page no longer jumps up and down while you scroll (server fix).

## 0.2.7

- Several VS Code windows no longer mix up their projects. Each workspace is now its own device on the Agentic server
  (it used to be one id shared by every window), so a tool call — and the workspace description the model gets — always
  belongs to the window whose project the chat uses. Files are written in the right folder.
- A tool call goes to exactly one window: the side bar and an editor tab of the same workspace never both run it, and a
  call sent again after a reconnect runs once.
- The device list names the workspace ("PC · VS Code · MyProject").
- Parallel agents (server): the model splits work into subagents that run at the same time; their cards show live progress.

## 0.2.6

- A command that times out tells the model how to run it longer or in the background (so it does not give up).

## 0.2.5

- Copy buttons in the chat work (VS Code copies; the webview does not let the page use the clipboard).
- Live updates reconnect by themselves after the Agentic server restarts (no need to reload the page).

## 0.2.4

- Edits are shown for review only in Manual permission mode (Auto never asks), and not when the call was just approved in the chat.

## 0.2.3

- Token usage for npx ccusage: each answer is logged in Claude Code's format (agentic.usage.ccusageLog).

## 0.2.2

- Claude Code features: background commands, notebook cell edits, hooks (.agentic/settings.json), local MCP servers (.mcp.json),
  skills and custom /commands, @-mentions of workspace files, diff review of every change (Accept / Reject), /add-dir, /doctor.
- Rewind (files and chat), AGENTIC.md editing from the chat.

## 0.2.0

- Multitask: up to four chats side by side in a wide editor tab (Agentic: Multitask, or multitask from the side bar).
- Updates itself from the Agentic server (Apps & updates), with SHA-256 check; Agentic: Check for Updates.
- Calmer page and chat animations inside VS Code (agentic.chat.animations; VS Code's Reduce Motion turns them off),
  and theme changes without a colour flash.

## 0.1.0

- First version: the Agentic chat in the activity bar and in editor tabs, served through a local proxy that adds the API key.
- Workspace tools for the model: read/list/glob/grep, write/edit through VS Code (undoable), diagnostics, editor context, commands, open file, Agentic API.
- VS Code as a device for chats started in the web or desktop app.
- Editor commands: ask about / explain / fix selection, review file, fix problems, add file to chat, new chat.
