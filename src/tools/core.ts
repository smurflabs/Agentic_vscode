/** Workspace-tool helpers with no VS Code dependency (unit-tested with plain Node). */
import * as path from 'path';

export const MAX_OUTPUT = 60000;

const sameCase = process.platform === 'win32' || process.platform === 'darwin'
  ? (s: string) => s.toLowerCase()
  : (s: string) => s;

/** Whether `full` is `root` or inside it. */
export function isInside(full: string, root: string): boolean {
  const f = sameCase(path.resolve(full));
  const r = sameCase(path.resolve(root));
  if (f === r) return true;
  return f.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/** A path outside the folders the tools may use: the user is asked (allow once, allow the folder, or not). */
export class OutsideWorkspaceError extends Error {
  constructor(readonly full: string, roots: string[]) {
    super(`${full} is outside the workspace folders (${roots.join('; ')}). The user was asked whether to allow it; if they did not, work inside the workspace.`);
  }
}

/**
 * An absolute path inside one of the workspace folders (or the folders allowed too); a relative path starts in the first
 * one, an empty path is the first folder. A path outside them throws OutsideWorkspaceError, unless extra allows it.
 */
export function resolveInside(p: string | undefined, roots: string[], extra: string[] = [], anywhere = false): string {
  if (!roots.length) throw new Error('No folder is open in VS Code. Open a folder (File > Open Folder) for the workspace tools.');
  const given = (p || '').trim();
  const full = !given ? roots[0] : path.resolve(path.isAbsolute(given) ? given : path.join(roots[0], given));
  if (!anywhere && !roots.some(r => isInside(full, r)) && !extra.some(r => isInside(full, r) || path.resolve(r) === full)) throw new OutsideWorkspaceError(full, roots);
  return full;
}

/** A file shown with line numbers (6-wide, tab), from `offset` (1-based) for `limit` lines, like the desktop app. */
export function numberLines(text: string, offset = 1, limit = 2000): string {
  if (!text.length) return '(empty file)';
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const start = Math.max(1, Math.floor(offset || 1));
  const count = Math.min(5000, Math.max(1, Math.floor(limit || 2000)));
  const out: string[] = [];
  let size = 0;
  let truncated = false;
  for (let i = start - 1; i < Math.min(lines.length, start - 1 + count); i++) {
    const line = lines[i].length > 2000 ? lines[i].slice(0, 2000) + '…' : lines[i];
    const row = String(i + 1).padStart(6) + '\t' + line;
    size += row.length + 1;
    out.push(row);
    if (size > MAX_OUTPUT) { truncated = true; break; }
  }
  let result = out.join('\n');
  if (truncated) result += '\n… (truncated; use offset/limit)';
  const rest = lines.length - (start - 1 + count);
  if (!truncated && rest > 0) result += `\n… ${rest} more lines (use offset ${start + count})`;
  return result.length ? result : '(empty file)';
}

export interface EditResult { ok: boolean; text?: string; replaced?: number; error?: string; note?: string }

/** A line-number prefix copied from read_file's output ("    12\t", "12: ", "12 | "). */
const LINE_PREFIX = /^\s*\d+(\t|: |\s?[|│] )/;

/** old/new with the line numbers removed when every non-blank line of old starts with one (copied from read_file). */
function withoutLineNumbers(oldString: string, newString: string): [string, string] | null {
  const lines = oldString.split('\n').filter(l => l.trim());
  if (!lines.length || !lines.every(l => LINE_PREFIX.test(l))) return null;
  const strip = (s: string) => s.split('\n').map(l => l.replace(LINE_PREFIX, '')).join('\n');
  const newLines = newString.split('\n').filter(l => l.trim());
  return [strip(oldString), newLines.length && newLines.every(l => LINE_PREFIX.test(l)) ? strip(newString) : newString];
}

/** Where the lines of old appear in the file when trailing spaces are ignored: [start line, line count] per place. */
function looseLineMatches(source: string, oldString: string): Array<[number, number]> {
  const lines = source.split('\n');
  const want = oldString.replace(/\n$/, '').split('\n').map(l => l.trimEnd());
  if (!want.some(l => l.trim())) return [];
  const hits: Array<[number, number]> = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let j = 0;
    while (j < want.length && lines[i + j].trimEnd() === want[j]) j++;
    if (j === want.length) hits.push([i, want.length]);
  }
  return hits;
}

/** The file's lines nearest to old's first line (the one sharing most words with it), numbered, for a not-found error. */
export function closestText(source: string, oldString: string): string {
  const first = oldString.split('\n').find(l => l.trim()) || '';
  const words = new Set(first.split(/\W+/).filter(w => w.length > 1));
  if (!words.size) return '';
  const lines = source.split('\n');
  let best = -1, bestScore = 0;
  lines.forEach((l, i) => {
    const score = l.split(/\W+/).filter(w => words.has(w)).length;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  if (best < 0 || bestScore < Math.min(2, words.size)) return '';
  const span = Math.max(1, oldString.split('\n').length);
  const from = Math.max(0, best - 2), to = Math.min(lines.length, best + span + 2);
  return lines.slice(from, to).map((l, k) => `${String(from + k + 1).padStart(6)}\t${l}`).join('\n');
}

/**
 * Replaces old with new: exactly once (it must be unique) or everywhere with replaceAll. Forgiving where it is safe: LF edits
 * on CRLF files, line numbers copied from read_file, and trailing spaces; when the text is not there the error shows the
 * closest lines, so the next try can be right without reading the file again.
 */
export function applyEdit(text: string, oldString: string, newString: string, replaceAll = false): EditResult {
  if (!oldString) return { ok: false, error: 'old_string is empty: use write_file to create or replace a whole file.' };
  // Files with CRLF: the model usually writes LF, so match either way.
  const crlf = text.includes('\r\n');
  let source = crlf ? text.replace(/\r\n/g, '\n') : text;
  let from = oldString.replace(/\r\n/g, '\n'), to = newString.replace(/\r\n/g, '\n');
  const finish = (result: string, replaced: number, note?: string): EditResult =>
    ({ ok: true, text: crlf ? restoreEndings(text, result) : result, replaced, note });
  if (from === to) {
    return source.includes(from) ? { ok: true, text, replaced: 0, note: 'No change needed: the file already contains exactly this text.' }
      : { ok: false, error: 'old_string and new_string are the same, and the file does not contain that text.' };
  }
  let count = source.split(from).length - 1;
  let note: string | undefined;
  if (count === 0) {
    const stripped = withoutLineNumbers(from, to);
    if (stripped && source.split(stripped[0]).length - 1 > 0) {
      [from, to] = stripped;
      count = source.split(from).length - 1;
      note = 'The line numbers copied from read_file were left out of old_string.';
    }
  }
  if (count === 0 && !replaceAll) {
    const loose = looseLineMatches(source, from);
    if (loose.length === 1) {
      const lines = source.split('\n');
      const [start, n] = loose[0];
      lines.splice(start, n, ...to.replace(/\n$/, '').split('\n'));
      return finish(lines.join('\n'), 1, 'Matched ignoring spaces at line ends.');
    }
    if (loose.length > 1) return { ok: false, error: `old_string matches ${loose.length} places (ignoring spaces at line ends): give more surrounding text so it is unique.` };
  }
  if (count === 0) {
    const near = closestText(source, from);
    return { ok: false, error: 'old_string was not found in the file (it must match exactly, including indentation).' +
      (near ? ` The closest text in the file:\n${near}\nCopy the exact text from it (without the line numbers) and try again.` : ' Read the file again first.') };
  }
  if (count > 1 && !replaceAll) return { ok: false, error: `old_string matches ${count} places: give more surrounding text so it is unique, or set replace_all.` };
  const result = replaceAll ? source.split(from).join(to) : source.replace(from, () => to);
  return finish(result, replaceAll ? count : 1, note);
}

/**
 * Line endings for a changed file: lines the change did not touch (the same lines at the start and at the end) keep the
 * ending they had, lines replacing as many old ones keep theirs one for one, and other new lines take the file's usual
 * one. A file with mixed endings then changes only where it was edited, instead of on every line.
 */
export function restoreEndings(original: string, next: string): string {
  if (!original.includes('\r')) return next.replace(/\r\n/g, '\n');
  const oldLines: string[] = [], oldEnds: string[] = [];
  let crlf = 0, lf = 0, start = 0;
  for (let i = 0; i < original.length; i++) {
    if (original[i] !== '\n') continue;
    const isCrlf = i > start && original[i - 1] === '\r';
    oldLines.push(original.slice(start, isCrlf ? i - 1 : i));
    oldEnds.push(isCrlf ? '\r\n' : '\n');
    if (isCrlf) crlf++; else lf++;
    start = i + 1;
  }
  const usual = crlf > lf ? '\r\n' : '\n';
  const parts = next.replace(/\r\n/g, '\n').split('\n');
  const count = parts.length - 1;
  const ends: (string | undefined)[] = new Array(count);
  let p = 0;
  while (p < count && p < oldLines.length && parts[p] === oldLines[p]) { ends[p] = oldEnds[p]; p++; }
  let s = 0;
  while (s < count - p && s < oldLines.length - p && parts[count - 1 - s] === oldLines[oldLines.length - 1 - s]) { ends[count - 1 - s] = oldEnds[oldLines.length - 1 - s]; s++; }
  const sameCount = count - p - s === oldLines.length - p - s;
  let out = '';
  for (let i = 0; i < count; i++) out += parts[i] + (ends[i] ?? (sameCount ? oldEnds[i] : usual));
  return out + parts[count];
}

/** Lines matching `re` in one file's text, as "path:line: text". */
export function grepText(text: string, re: RegExp, displayPath: string, max: number): string[] {
  const hits: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < max; i++) {
    re.lastIndex = 0;
    if (re.test(lines[i])) {
      const line = lines[i].length > 300 ? lines[i].slice(0, 300) + '…' : lines[i];
      hits.push(`${displayPath}:${i + 1}: ${line.trim()}`);
    }
  }
  return hits;
}

/** True for content that looks binary (a NUL byte in the first 8 KB). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export function sizeText(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function clip(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more characters cut)` : s;
}

/** Parses tool-call arguments: a JSON string or an object; anything else is {}. */
export function parseArgs(raw: unknown): Record<string, any> {
  if (raw && typeof raw === 'object') return raw as Record<string, any>;
  if (typeof raw === 'string' && raw.trim()) {
    try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
  }
  return {};
}
