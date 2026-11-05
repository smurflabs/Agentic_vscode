/**
 * Dictation mode's microphone in VS Code. A webview cannot use the microphone, so the extension records it: a recorder
 * process writes raw 16-bit mono PCM at 16 kHz to its stdout (Windows: PowerShell with the waveIn API, nothing to
 * install; Linux: parecord, arecord, sox or ffmpeg; macOS: sox or ffmpeg). The setting agentic.speech.recorder (or
 * AGENTIC_VSCODE_RECORDER) names another command that does the same.
 *
 * A turn ends like it does in the web app: loudness is measured every 50 ms against the room's noise (learned while
 * nobody speaks; the user's sensitivity), and a pause of silenceMs after speech ends it. The recording goes to the Agentic
 * server as a WAV file (/api/chat/transcribe), which answers the text. The recorder keeps running between turns (the
 * microphone stays open while Dictation mode is on) and stops when the page releases it.
 */
import { ChildProcess, spawn } from 'child_process';

export const RATE = 16000;
const FRAME = RATE / 20; // 50 ms of samples

export interface ListenOptions {
  silenceMs?: number;
  maxTurnSeconds?: number;
  noSpeechSeconds?: number;
  sensitivity?: number;
  language?: string;
}

export interface SpeechState { state: 'idle' | 'listening' | 'transcribing'; level: number; error?: string }

/** Turns a recording (WAV) into text: the Agentic server's /api/chat/transcribe. */
export type Transcriber = (wav: Buffer, language: string) => Promise<string>;

// The waveIn recorder for Windows: PowerShell compiles it (Windows PowerShell 5.1 is always there) and it writes 50 ms
// buffers of PCM to stdout until the extension stops it.
const WINDOWS_RECORDER = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class AgenticMic {
  [StructLayout(LayoutKind.Sequential)] public struct Fmt { public ushort tag; public ushort channels; public uint rate; public uint bytesPerSec; public ushort align; public ushort bits; public ushort extra; }
  [StructLayout(LayoutKind.Sequential)] public struct Hdr { public IntPtr data; public uint length; public uint recorded; public IntPtr user; public uint flags; public uint loops; public IntPtr next; public IntPtr reserved; }
  [DllImport("winmm.dll")] static extern int waveInOpen(out IntPtr h, UIntPtr dev, ref Fmt f, IntPtr cb, IntPtr inst, int flags);
  [DllImport("winmm.dll")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInUnprepareHeader(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, int size);
  [DllImport("winmm.dll")] static extern int waveInStart(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInReset(IntPtr h);
  [DllImport("winmm.dll")] static extern int waveInClose(IntPtr h);
  public static int Run(int rate) {
    Fmt f = new Fmt(); f.tag = 1; f.channels = 1; f.rate = (uint)rate; f.bits = 16; f.align = 2; f.bytesPerSec = (uint)(rate * 2);
    IntPtr h;
    int err = waveInOpen(out h, new UIntPtr(0xFFFFFFFFu), ref f, IntPtr.Zero, IntPtr.Zero, 0);
    if (err != 0) { Console.Error.WriteLine("No microphone could be opened (waveInOpen error " + err + "): check that one is connected and that Windows Audio is running."); return 3; }
    int n = 8, bytes = rate / 10, size = Marshal.SizeOf(typeof(Hdr));
    IntPtr[] hdrs = new IntPtr[n];
    for (int i = 0; i < n; i++) {
      Hdr x = new Hdr(); x.data = Marshal.AllocHGlobal(bytes); x.length = (uint)bytes;
      hdrs[i] = Marshal.AllocHGlobal(size); Marshal.StructureToPtr(x, hdrs[i], false);
      waveInPrepareHeader(h, hdrs[i], size); waveInAddBuffer(h, hdrs[i], size);
    }
    Stream o = Console.OpenStandardOutput();
    byte[] buf = new byte[bytes];
    waveInStart(h);
    try {
      int at = 0;
      while (true) {
        Hdr x = (Hdr)Marshal.PtrToStructure(hdrs[at], typeof(Hdr));
        if ((x.flags & 1) == 0) { Thread.Sleep(5); continue; }
        int got = (int)x.recorded;
        if (got > 0) { Marshal.Copy(x.data, buf, 0, got); o.Write(buf, 0, got); o.Flush(); }
        waveInUnprepareHeader(h, hdrs[at], size);
        x.flags = 0; x.recorded = 0; Marshal.StructureToPtr(x, hdrs[at], false);
        waveInPrepareHeader(h, hdrs[at], size); waveInAddBuffer(h, hdrs[at], size);
        at = (at + 1) % n;
      }
    } catch (IOException) {
    } finally {
      waveInReset(h);
      for (int i = 0; i < n; i++) waveInUnprepareHeader(h, hdrs[i], size);
      waveInClose(h);
    }
    return 0;
  }
}
'@
exit [AgenticMic]::Run(${RATE})
`;

/** The recorders to try, in order: [command, args]. */
export function recorderCandidates(platform: string, custom: string | undefined): [string, string[], boolean][] {
  if (custom && custom.trim()) return [[custom.trim(), [], true]];
  if (platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_RECORDER, 'utf16le').toString('base64');
    return [['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], false]];
  }
  const raw = ['-t', 'raw', '-r', String(RATE), '-e', 'signed', '-b', '16', '-c', '1', '-'];
  const sox: [string, string[], boolean] = ['sox', ['-q', '-d', ...raw], false];
  if (platform === 'darwin') {
    return [sox, ['ffmpeg', ['-loglevel', 'error', '-f', 'avfoundation', '-i', ':0', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], false]];
  }
  return [
    ['parecord', ['--raw', '--format=s16le', `--rate=${RATE}`, '--channels=1'], false],
    ['arecord', ['-q', '-f', 'S16_LE', '-r', String(RATE), '-c', '1', '-t', 'raw'], false],
    sox,
    ['ffmpeg', ['-loglevel', 'error', '-f', 'pulse', '-i', 'default', '-ac', '1', '-ar', String(RATE), '-f', 's16le', '-'], false]
  ];
}

/** A WAV file of 16-bit mono PCM. */
export function wavOf(pcm: Buffer, rate = RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Loudness (RMS, 0..1) of 16-bit samples. */
export function rmsOf(pcm: Buffer, from: number, count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) { const v = pcm.readInt16LE(from + i * 2) / 32768; sum += v * v; }
  return Math.sqrt(sum / Math.max(1, count));
}

interface Turn {
  opts: Required<ListenOptions>;
  chunks: Buffer[];
  carry: Buffer;
  started: number;
  heard: boolean;
  lastVoice: number;
  floor: number;
  resolve: (r: { pcm: Buffer | null; error?: string }) => void;
  timer: NodeJS.Timeout;
}

export class SpeechInput {
  private proc?: ChildProcess;
  private stderr = '';
  private lastError = '';
  private turn?: Turn;
  private _state: SpeechState = { state: 'idle', level: 0 };

  constructor(private readonly recorder: () => string | undefined, private readonly log: (s: string) => void = () => { }, private readonly platform = process.platform) { }

  get state(): SpeechState { return this._state; }

  /** Starts the recorder (kept running between turns). Rejects with what is missing when none can run. */
  private async ensureRecorder(): Promise<void> {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return;
    const tried: string[] = [];
    for (const [cmd, args, shell] of recorderCandidates(this.platform, this.recorder())) {
      const p = spawn(cmd, args, { shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const ok = await new Promise<boolean>(resolve => {
        p.once('error', () => resolve(false));
        p.once('spawn', () => resolve(true));
      });
      if (!ok) { tried.push(cmd); continue; }
      this.stderr = '';
      this.lastError = '';
      p.stdout!.on('data', (b: Buffer) => this.onAudio(b));
      p.stderr!.on('data', (b: Buffer) => { this.stderr = (this.stderr + b.toString()).slice(-2000); });
      p.on('exit', code => {
        if (this.proc !== p) return;
        this.proc = undefined;
        // PowerShell's own records (#< CLIXML, <Objs …>) are not the recorder's message.
        const said = this.stderr.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#< CLIXML') && !l.startsWith('<Objs')).join(' ').trim();
        const why = said || `The recorder stopped (exit code ${code}).`;
        this.lastError = why;
        this.log(`speech: recorder ended: ${why}`);
        if (this.turn) this.finish(false, why);
      });
      this.proc = p;
      this.log(`speech: recording with ${cmd}`);
      return;
    }
    throw new Error(this.platform === 'win32'
      ? 'The microphone recorder (PowerShell) could not start.'
      : `No recorder was found (tried ${tried.join(', ')}): install one of them, or set agentic.speech.recorder to a command that writes 16-bit mono PCM at 16 kHz to stdout.`);
  }

  /** Records one turn: resolves with its text, or '' when nothing was said (or it was thrown away). */
  async listen(o: ListenOptions, transcribe: Transcriber): Promise<{ text: string }> {
    if (this.turn) this.finish(true);
    await this.ensureRecorder();
    const opts: Required<ListenOptions> = {
      silenceMs: clamp(o.silenceMs, 300, 10000, 1400), maxTurnSeconds: clamp(o.maxTurnSeconds, 5, 600, 120),
      noSpeechSeconds: clamp(o.noSpeechSeconds, 3, 300, 30), sensitivity: clamp(o.sensitivity, 1, 10, 5),
      language: String(o.language || 'en').slice(0, 8)
    };
    const result = await new Promise<{ pcm: Buffer | null; error?: string }>(resolve => {
      const turn: Turn = {
        opts, chunks: [], carry: Buffer.alloc(0), started: Date.now(), heard: false, lastVoice: 0, floor: 0.005, resolve,
        // Limits hold even when the recorder sends nothing.
        timer: setInterval(() => this.checkTime(), 100)
      };
      this.turn = turn;
      this._state = { state: 'listening', level: 0 };
      // The recorder already gave up (no microphone): the turn fails at once.
      if (!this.proc) this.finish(false, this.lastError || 'The recorder stopped.');
    });
    if (result.error) { this._state = { state: 'idle', level: 0, error: result.error }; throw new Error(result.error); }
    if (!result.pcm || result.pcm.length < RATE / 5) { this._state = { state: 'idle', level: 0 }; return { text: '' }; }
    this._state = { state: 'transcribing', level: 0 };
    try {
      return { text: (await transcribe(wavOf(result.pcm), opts.language)).trim() };
    } finally {
      this._state = { state: 'idle', level: 0 };
    }
  }

  /** Ends the turn now: with what was heard (Send), or thrown away (Pause, End). */
  stop(discard: boolean): void {
    const t = this.turn;
    if (!t) return;
    if (!discard && t.chunks.length) t.heard = true;
    this.finish(discard);
  }

  /** Dictation mode ended or paused: the microphone is closed. */
  release(): void {
    if (this.turn) this.finish(true);
    const p = this.proc;
    this.proc = undefined;
    if (p) killTree(p);
    this._state = { state: 'idle', level: 0 };
  }

  private onAudio(b: Buffer): void {
    const t = this.turn;
    if (!t) return;
    let data = t.carry.length ? Buffer.concat([t.carry, b]) : b;
    const frameBytes = FRAME * 2;
    let at = 0;
    while (data.length - at >= frameBytes) {
      const frame = data.subarray(at, at + frameBytes);
      at += frameBytes;
      t.chunks.push(Buffer.from(frame));
      this.measure(t, rmsOf(frame, 0, FRAME));
      if (this.turn !== t) return;
    }
    t.carry = Buffer.from(data.subarray(at));
  }

  /** The same rule as the web app: the room's noise is learned while nobody speaks; louder than it by the sensitivity's factor is speech. */
  private measure(t: Turn, rms: number): void {
    const s = t.opts.sensitivity;
    const factor = 1.5 + (10 - s) * 0.35, floorMin = 0.004 + (10 - s) * 0.002;
    const threshold = Math.max(floorMin, t.floor * factor), now = Date.now();
    this._state = { state: 'listening', level: Math.max(0, Math.min(1, rms / (threshold * 2))) };
    if (rms > threshold) { t.heard = true; t.lastVoice = now; }
    else if (!t.heard) t.floor = Math.min(0.05, t.floor * 0.95 + rms * 0.05);
    this.checkTime();
  }

  private checkTime(): void {
    const t = this.turn;
    if (!t) return;
    const now = Date.now();
    if (t.heard && now - t.lastVoice > t.opts.silenceMs) this.finish(false);
    else if (!t.heard && now - t.started > t.opts.noSpeechSeconds * 1000) this.finish(false);
    else if (now - t.started > t.opts.maxTurnSeconds * 1000) this.finish(false);
  }

  private finish(discard: boolean, error?: string): void {
    const t = this.turn;
    if (!t) return;
    this.turn = undefined;
    clearInterval(t.timer);
    if (error) { t.resolve({ pcm: null, error }); return; }
    t.resolve({ pcm: !discard && t.heard ? Buffer.concat(t.chunks) : null });
  }
}

/** Stops a recorder and anything it started (a recorder command run through a shell is the shell's child). */
function killTree(p: ChildProcess): void {
  try { p.stdout?.destroy(); p.stderr?.destroy(); } catch { /* closed */ }
  if (process.platform === 'win32' && p.pid) {
    spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => { try { p.kill(); } catch { /* gone */ } });
  } else {
    try { p.kill(); } catch { /* gone */ }
  }
}

function clamp(v: unknown, min: number, max: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, n)) : fallback;
}
