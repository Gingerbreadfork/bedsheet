export type LineEnding = '\n' | '\r\n';

export interface DelimiterOption {
  char: string;
  label: string;
}

export const DELIMITERS: DelimiterOption[] = [
  { char: ',', label: 'Comma' },
  { char: '\t', label: 'Tab' },
  { char: ';', label: 'Semicolon' },
  { char: '|', label: 'Pipe' },
];

export function delimiterLabel(char: string): string {
  return DELIMITERS.find((d) => d.char === char)?.label ?? JSON.stringify(char);
}

export interface ParseResult {
  rows: string[][];
  columnCount: number;
  lineEnding: LineEnding;
  ragged: boolean;
}

function countOutsideQuotes(line: string, ch: string): number {
  let count = 0;
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === ch) count++;
  }
  return count;
}

/** Picks the delimiter whose per-line count is most consistent across the first lines. */
export function detectDelimiter(text: string, fileName?: string): string {
  if (fileName && /\.tsv$/i.test(fileName)) return '\t';
  const lines = text
    .slice(0, 65536)
    .split(/\r\n|\n|\r/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 40);
  if (lines.length === 0) return ',';
  let best = ',';
  let bestScore = -1;
  for (const { char } of DELIMITERS) {
    const freq = new Map<number, number>();
    for (const line of lines) {
      const n = countOutsideQuotes(line, char);
      freq.set(n, (freq.get(n) ?? 0) + 1);
    }
    let mode = 0;
    let modeFreq = 0;
    for (const [n, f] of freq) {
      if (f > modeFreq || (f === modeFreq && n > mode)) {
        mode = n;
        modeFreq = f;
      }
    }
    if (mode === 0) continue;
    const score = modeFreq / lines.length + Math.min(mode, 50) * 0.002;
    if (score > bestScore) {
      bestScore = score;
      best = char;
    }
  }
  return best;
}

const QUOTE = 34;
const CR = 13;
const LF = 10;

/** RFC 4180 parser. Tolerates unterminated quotes, mixed line endings, and ragged rows. */
export function parseCsv(text: string, delimiter: string): ParseResult {
  const rows: string[][] = [];
  const d = delimiter.charCodeAt(0);
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row: string[] = [];
  let crlf = 0;
  let lf = 0;

  if (i >= n) return { rows, columnCount: 0, lineEnding: '\n', ragged: false };

  for (;;) {
    let field: string;
    if (text.charCodeAt(i) === QUOTE) {
      i++;
      let start = i;
      const parts: string[] = [];
      for (;;) {
        const j = text.indexOf('"', i);
        if (j < 0) {
          parts.push(text.slice(start));
          i = n;
          break;
        }
        if (text.charCodeAt(j + 1) === QUOTE) {
          parts.push(text.slice(start, j + 1));
          i = j + 2;
          start = i;
        } else {
          parts.push(text.slice(start, j));
          i = j + 1;
          break;
        }
      }
      field = parts.length === 1 ? parts[0] : parts.join('');
      if (i < n) {
        const tail = i;
        while (i < n) {
          const c = text.charCodeAt(i);
          if (c === d || c === LF || c === CR) break;
          i++;
        }
        if (i > tail) field += text.slice(tail, i);
      }
    } else {
      const start = i;
      while (i < n) {
        const c = text.charCodeAt(i);
        if (c === d || c === LF || c === CR) break;
        i++;
      }
      field = text.slice(start, i);
    }
    row.push(field);

    if (i >= n) {
      rows.push(row);
      break;
    }
    const c = text.charCodeAt(i);
    if (c === d) {
      i++;
      if (i >= n) {
        row.push('');
        rows.push(row);
        break;
      }
      continue;
    }
    if (c === CR) {
      if (text.charCodeAt(i + 1) === LF) {
        i += 2;
        crlf++;
      } else {
        i++;
        lf++;
      }
    } else {
      i++;
      lf++;
    }
    rows.push(row);
    row = [];
    if (i >= n) break;
  }

  while (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === '') rows.pop();
    else break;
  }

  let columnCount = 0;
  for (const r of rows) if (r.length > columnCount) columnCount = r.length;
  let ragged = false;
  for (const r of rows) {
    if (r.length !== columnCount) {
      ragged = true;
      while (r.length < columnCount) r.push('');
    }
  }

  return { rows, columnCount, lineEnding: crlf > lf ? '\r\n' : '\n', ragged };
}

function needsQuote(s: string, delimiter: string): boolean {
  if (s.length === 0) return false;
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) return true;
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(s.length - 1);
  return first === 32 || last === 32;
}

export function serializeRow(row: readonly string[], delimiter: string): string {
  let out = '';
  for (let c = 0; c < row.length; c++) {
    const v = row[c] ?? '';
    if (c > 0) out += delimiter;
    out += needsQuote(v, delimiter) ? '"' + v.replaceAll('"', '""') + '"' : v;
  }
  return out;
}

export function serializeCsv(
  rows: Iterable<readonly string[]>,
  delimiter: string,
  lineEnding: LineEnding = '\n',
): string {
  const lines: string[] = [];
  for (const r of rows) lines.push(serializeRow(r, delimiter));
  if (lines.length === 0) return '';
  return lines.join(lineEnding) + lineEnding;
}

/** Parses tab-separated clipboard text into a block; falls back to lines, then a single value. */
export function parseClipboardBlock(text: string): string[][] {
  const trimmed = text.replace(/(\r\n|\n|\r)$/, '');
  if (trimmed.length === 0) return [['']];
  if (trimmed.includes('\t') || trimmed.includes('"')) {
    const parsed = parseCsv(trimmed, '\t');
    if (parsed.rows.length > 0) return parsed.rows;
  }
  if (/\r\n|\n|\r/.test(trimmed)) return trimmed.split(/\r\n|\n|\r/).map((l) => [l]);
  return [[trimmed]];
}

export function columnLetter(index: number): string {
  let s = '';
  let n = index;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}
