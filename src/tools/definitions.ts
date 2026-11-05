/**
 * The tools the chat model can call in this workspace, in the shape the Agentic server takes from a client app
 * (`clientTools`): `{name, description, parameters, "x-risk"}`. The risk drives the chat's permission mode on the
 * server, which asks the user before a call when needed (read = never; change = unless Auto; conditional = only for a
 * change, e.g. a non-GET API call; ask = always).
 */
export type Risk = 'read' | 'change' | 'conditional' | 'ask';

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  'x-risk': Risk;
}

export interface DefinitionOptions {
  workspaces: string[];
  shellLabel: string;
  osLabel: string;
  allowCommands: boolean;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) =>
  ({ type: 'object', properties, ...(required.length ? { required } : {}) });

export function toolDefinitions(o: DefinitionOptions): ToolDefinition[] {
  const ws = o.workspaces.length ? o.workspaces.join('; ') : '(no folder is open)';
  const list: ToolDefinition[] = [
    {
      name: 'read_file', 'x-risk': 'read',
      description: `Read a file in the user's VS Code workspace (${ws}). Returns numbered lines and includes unsaved changes in open editors; use offset/limit for big files. ` +
        'A picture (PNG, JPEG, WebP) comes back as an image for you to look at. Read a file before you edit_file or write_file it.',
      parameters: obj({ path: { type: 'string' }, offset: { type: 'integer', description: 'first line (1-based)' }, limit: { type: 'integer' } }, ['path'])
    },
    {
      name: 'list_dir', 'x-risk': 'read',
      description: 'List a folder in the workspace (files with sizes, sub-folders).',
      parameters: obj({ path: { type: 'string', description: 'folder; empty = the first workspace folder' } })
    },
    {
      name: 'glob_files', 'x-risk': 'read',
      description: 'Find files by name pattern, e.g. **/*.ts or src/**/test_*.py (node_modules, .git, bin and obj are skipped).',
      parameters: obj({ pattern: { type: 'string' }, path: { type: 'string', description: 'folder to search in; empty = all workspace folders' } }, ['pattern'])
    },
    {
      name: 'grep', 'x-risk': 'read',
      description: 'Search file contents with a regular expression; returns path:line: text.',
      parameters: obj({
        pattern: { type: 'string' }, path: { type: 'string' },
        glob: { type: 'string', description: 'only files matching, e.g. **/*.vb' }, ignore_case: { type: 'boolean' }
      }, ['pattern'])
    },
    {
      name: 'write_file', 'x-risk': 'change',
      description: 'Create or overwrite a text file in the workspace. Goes through VS Code, so it can be undone in the editor. To overwrite an existing file, ' +
        'read it with read_file first in this chat; it fails when the file changed since you read it.',
      parameters: obj({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content'])
    },
    {
      name: 'edit_file', 'x-risk': 'change',
      description: 'Replace exact text in a file (old_string must match exactly and be unique unless replace_all). Applied through VS Code, so it can be undone. ' +
        'Read the file with read_file first in this chat; the edit fails when the file changed since you read it (read it again then).',
      parameters: obj({
        path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' }
      }, ['path', 'old_string', 'new_string'])
    },
    {
      name: 'edit_notebook', 'x-risk': 'change',
      description: 'Change a Jupyter notebook (.ipynb) cell: replace its source, insert a new cell before it, or delete it. Read the notebook first (read_file shows its JSON; cells are numbered from 0).',
      parameters: obj({
        path: { type: 'string' }, cell: { type: 'integer', description: 'cell index (0-based); for insert, the new cell goes there' },
        mode: { type: 'string', enum: ['replace', 'insert', 'delete'] }, source: { type: 'string' }, cell_type: { type: 'string', enum: ['code', 'markdown'] }
      }, ['path', 'cell'])
    },
    {
      name: 'vscode_editor_context', 'x-risk': 'read',
      description: "What the user is looking at in VS Code: the active file, its language, the selected text with its line range, and the other open editors. Use it when the user says 'this', 'here' or 'the selection'.",
      parameters: obj({})
    },
    {
      name: 'vscode_diagnostics', 'x-risk': 'read',
      description: "Errors and warnings from VS Code's Problems panel (compilers, linters, language servers) for one file or the whole workspace. Check it after editing code.",
      parameters: obj({ path: { type: 'string', description: 'a file; empty = every file with problems' }, include_warnings: { type: 'boolean' } })
    },
    {
      name: 'open_file', 'x-risk': 'read',
      description: 'Open a file in the user\'s editor, optionally at a line, to show them something.',
      parameters: obj({ path: { type: 'string' }, line: { type: 'integer' } }, ['path'])
    },
    {
      name: 'agentic_api', 'x-risk': 'conditional',
      description: "Call the Agentic server's REST API as the user (same permissions as the dashboard): agents, tasks, global tasks, results, finance, models… Reading (GET) is free; changes need the user's approval. Paths start with /api/.",
      parameters: obj({
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }, path: { type: 'string' }, body: { type: 'object' }
      }, ['method', 'path'])
    }
  ];
  if (o.allowCommands) {
    list.splice(6, 0, {
      name: 'run_command', 'x-risk': 'change',
      description: `Run a ${o.shellLabel} command on the user's ${o.osLabel} computer and return its output. Starts in ${o.workspaces[0] || 'the home folder'} unless cwd is given` +
        (/cmd/i.test(o.shellLabel) ? '. ' : '; a cd carries over to the chat\'s later commands (inside the workspace folders). ') +
        'It waits up to wait_seconds (default 120, at most 3600) for the command. One still running then is not stopped: it goes on in the background and you get ' +
        'its id and output so far - check on it with command_output, stop it with kill_command. For something that keeps running (a dev server, a watcher) or may take ' +
        'long, use run_command_background.',
      parameters: obj({ command: { type: 'string' }, cwd: { type: 'string' }, wait_seconds: { type: 'integer', description: 'How long to wait for it before it goes on in the background (default 120)' } }, ['command'])
    }, {
      name: 'run_command_background', 'x-risk': 'change',
      description: `Start a ${o.shellLabel} command in the background on the user's ${o.osLabel} computer and return its id at once; it runs until it ends or you stop it. ` +
        'Use it for dev servers, watchers, long builds and tests, and anything that may wait or hang - then audit it with command_output (is it still running, for how ' +
        'long, when did it last print something, its new output, warnings when it seems stuck or waits for input) and stop it with kill_command.',
      parameters: obj({ command: { type: 'string' }, cwd: { type: 'string' } }, ['command'])
    }, {
      name: 'command_output', 'x-risk': 'read',
      description: 'Audit a background command (from run_command_background, or a run_command still running after its wait): running or finished (exit code), for how ' +
        'long, how long since it last printed something, its new output since you last looked, and a warning when it seems to wait for input or to be stuck. ' +
        'wait_seconds: first wait up to that long for it to finish or print more (instead of calling again and again). Without id: all background commands.',
      parameters: obj({ id: { type: 'string' }, wait_seconds: { type: 'integer' } }, [])
    }, {
      name: 'kill_command', 'x-risk': 'change',
      description: 'Stop a background command (and what it started).',
      parameters: obj({ id: { type: 'string' } }, ['id'])
    }, {
      name: 'monitor', 'x-risk': 'change',
      description: "Watch a command's output: it runs in the background on the user's computer, and its output lines (only those matching filter, a regular " +
        'expression, when given) are sent into this chat as they happen - when the chat is not busy, you answer them by yourself. Use it for logs, dev ' +
        'servers, watch builds and long tests instead of polling. It ends when the command exits or after timeout_seconds (default 600, at most 3600); ' +
        'stop it earlier with kill_command and its id. Keep filter selective: every matching line is sent.',
      parameters: obj({ command: { type: 'string' }, description: { type: 'string', description: 'What is watched, in a few words' },
        filter: { type: 'string', description: 'Regular expression: only matching lines are sent (e.g. ERROR|Listening on|FAILED)' },
        timeout_seconds: { type: 'integer' }, cwd: { type: 'string' } }, ['command', 'description'])
    }, {
      name: 'preview', 'x-risk': 'conditional',
      description: "Run this project and show it to the user beside the chat (VS Code's Simple Browser), like Claude Desktop's preview; use it after you build or " +
        'change something they can run (a web page, an app, a game) so they see it, and to run its tests. action status lists the ' +
        'run configurations (a dev server, the static site, the app, its tests) and what runs; start runs one (name) and opens a web app once it has an ' +
        'address; open shows a page (url); stop stops one (name) or all; share uploads a project\'s website (its build or static files: name = ' +
        'the project) and returns a public link anyone can open - only when the user asks to share it. The configurations come from ' +
        '.agentic/launch.json (or Claude Code\'s .claude/launch.json), else from the project\'s files; when they are missing or wrong, write ' +
        '.agentic/launch.json: {"configurations": [{"name", "runtimeExecutable", "runtimeArgs": [], "cwd", "port", "kind": "web|app|test"}]}.',
      parameters: obj({ action: { type: 'string', enum: ['status', 'start', 'open', 'stop', 'share'] }, name: { type: 'string', description: 'the configuration (start, stop) or the project (share)' },
        url: { type: 'string', description: 'the page to show (open)' } }, ['action'])
    });
  }
  return list;
}

export function toolInstructions(o: DefinitionOptions): string {
  const ws = o.workspaces.length ? o.workspaces.join('; ') : 'none (no folder is open)';
  return `You are inside the user's VS Code. Workspace folders: ${ws}. Platform: ${process.platform}. Shell: ${o.shellLabel}. ` +
    'Read before you change files, keep edits minimal, and say what you changed. Edits go through VS Code, so the user can undo them. ' +
    'After changing code, check vscode_diagnostics for new errors. When the user refers to "this" or "the selection", call vscode_editor_context.';
}
