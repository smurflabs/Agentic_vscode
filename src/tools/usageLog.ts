/**
 * Token usage in Claude Code's log format, so `npx ccusage` counts Agentic answers too: one JSON line per answer in
 * <claude dir>/projects/agentic-vscode-<workspace>/<chat id>.jsonl. The claude dir is the first of CLAUDE_CONFIG_DIR when
 * set; otherwise ~/.config/claude when ~/.claude exists (ccusage reads both, and Claude Code's own /resume list stays
 * clean), else ~/.claude. AGENTIC_CCUSAGE_DIR overrides it; the setting agentic.usage.ccusageLog switches it off.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function claudeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTIC_CCUSAGE_DIR && env.AGENTIC_CCUSAGE_DIR.trim()) return env.AGENTIC_CCUSAGE_DIR.trim();
  const first = (env.CLAUDE_CONFIG_DIR || '').split(',').map(p => p.trim()).find(p => p.length > 0);
  if (first) return first;
  const home = os.homedir();
  return fs.existsSync(path.join(home, '.claude')) ? path.join(home, '.config', 'claude') : path.join(home, '.claude');
}

/** A folder name for a path, like Claude Code's: C:\Users\me\app becomes C--Users-me-app. */
export function projectKey(dir: string): string {
  const key = path.resolve(dir).replace(/[\\/]+$/, '').replace(/[^A-Za-z0-9._]/g, '-');
  return key.length > 120 ? key.slice(-120) : key;
}

export interface AnswerUsage {
  id?: string; model?: string; routedModel?: string;
  promptTokens?: number; completionTokens?: number; costMicros?: number | null;
}

/** x.y.z only: ccusage skips lines whose version is not a plain version number. */
export function plainVersion(v: string): string {
  const m = /\d+\.\d+\.\d+/.exec(v || '');
  return m ? m[0] : '0.0.0';
}

/** The log line for one answer (null when it used no tokens). */
export function usageEntry(chatId: string, cwd: string, version: string, m: AnswerUsage, cachedTokens: number, now = new Date()): Record<string, unknown> | null {
  const prompt = Math.max(0, Number(m.promptTokens) || 0), completion = Math.max(0, Number(m.completionTokens) || 0);
  if (!chatId || (prompt === 0 && completion === 0)) return null;
  const id = m.id || Math.random().toString(16).slice(2);
  const cached = Math.min(prompt, Math.max(0, Number(cachedTokens) || 0));
  const entry: Record<string, unknown> = {
    type: 'assistant', timestamp: now.toISOString(), sessionId: chatId, cwd, version: plainVersion(version),
    requestId: id, uuid: id, isSidechain: false,
    message: {
      id, type: 'message', role: 'assistant', model: m.routedModel || m.model || 'agentic',
      usage: { input_tokens: prompt - cached, output_tokens: completion, cache_creation_input_tokens: 0, cache_read_input_tokens: cached }
    }
  };
  if (typeof m.costMicros === 'number') entry.costUSD = m.costMicros / 1e6;
  return entry;
}

/** Appends one answer's usage; false when there was nothing to log or the file could not be written. */
export function recordUsage(chatId: string, cwd: string, version: string, m: AnswerUsage, cachedTokens: number, dataDir = claudeDataDir()): boolean {
  const entry = usageEntry(chatId, cwd, version, m, cachedTokens);
  if (!entry) return false;
  try {
    const dir = path.join(dataDir, 'projects', 'agentic-vscode-' + projectKey(cwd || os.homedir()));
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, chatId.replace(/[^\w-]/g, '') + '.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
    return true;
  } catch { return false; }   // usage logging never gets in the way of the answer
}
