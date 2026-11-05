// Tests for commands on the user's computer (run_command, run_command_background, command_output, kill_command):
// nothing is stopped for taking long, a shell that ends is not waited on for what it started, and command_output audits.
// No VS Code needed: node --test test/
const test = require('node:test');
const assert = require('node:assert');
const { BackgroundCommands, duration } = require('../out/tools/extras');
const { killTree } = require('../out/tools/runner');

const win = process.platform === 'win32';
const shell = win
  ? { exe: 'powershell.exe', args: c => ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', c] }
  : { exe: 'bash', args: c => ['-c', c] };
const sleepFor = s => win ? `Start-Sleep -Seconds ${s}` : `sleep ${s}`;
const say = t => win ? `Write-Output '${t}'` : `echo '${t}'`;

test('a quick command finishes with its output and exit code', async () => {
  const bg = new BackgroundCommands();
  const id = bg.start(shell.exe, shell.args(say('hello there')), process.cwd(), 'say hello');
  assert.strictEqual(await bg.waitFor(id, 20000), 'finished');
  assert.match(bg.take(id), /hello there/);
  assert.strictEqual(bg.exitCode(id), 0);
});

test('a long command is not stopped: it goes on in the background, is audited, then stopped', async () => {
  const bg = new BackgroundCommands();
  const id = bg.start(shell.exe, shell.args(`${say('started')}; ${sleepFor(60)}`), process.cwd(), 'long one');
  assert.strictEqual(await bg.waitFor(id, 3000), 'running');
  const report = await bg.status(id, 30);
  assert.match(report, /running for \d+ s/);
  assert.match(report, /started/);
  assert.match(await bg.status(''), /long one \(running for/);
  assert.match(bg.kill(id, killTree), /Stopped/);
  assert.match(await bg.status(id), /No background command/);
});

test('a shell that ends is not waited on for a process it started that keeps its output open', async () => {
  const bg = new BackgroundCommands();
  const cmd = win ? 'cmd /c "start /b ping -n 40 127.0.0.1"' : '(sleep 40; echo late) & echo shell done';
  const t0 = Date.now();
  const id = bg.start(shell.exe, shell.args(cmd), process.cwd(), 'starts something');
  assert.strictEqual(await bg.waitFor(id, 30000), 'shell-ended');
  assert.ok(Date.now() - t0 < 15000, `returned after ${Date.now() - t0} ms`);
  assert.match(await bg.status(id), /finished with exit code 0 after .*; something it started is still running/);
  bg.kill(id, killTree);
});

test('command_output warns about a question waiting for an answer', async () => {
  const bg = new BackgroundCommands();
  const id = bg.start(shell.exe, shell.args(`${say('Overwrite the file? (y/n)')}; ${sleepFor(30)}`), process.cwd(), 'asks');
  // Once the question is out (waited for, however slowly the shell starts), 5 s of silence make it a warning.
  assert.match(await bg.status(id, 30), /Overwrite the file\?/);
  await new Promise(r => setTimeout(r, 6000));
  const report = await bg.status(id);
  assert.match(report, /Warning: its last line looks like a question waiting for an answer/);
  bg.kill(id, killTree);
});

test('command_output can wait for a command to finish', async () => {
  const bg = new BackgroundCommands();
  const id = bg.start(shell.exe, shell.args(`${sleepFor(2)}; ${say('all done')}`), process.cwd(), 'short wait');
  const report = await bg.status(id, 30);
  assert.match(report, /finished with exit code 0/);
  assert.match(report, /all done/);
});

test('durations read naturally', () => {
  assert.strictEqual(duration(45000), '45 s');
  assert.strictEqual(duration(200000), '3 min 20 s');
  assert.strictEqual(duration(3900000), '1 h 5 min');
});
