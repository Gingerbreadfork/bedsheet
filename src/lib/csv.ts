export type LineEnding = '\n' | '\r\n' | '\r';

/** Which fields are quoted beyond the ones that have to be. `empty` covers blank fields. */
export interface Quoting {
  style: 'minimal' | 'all' | 'nonnumeric';
  empty: boolean;
}

export const MINIMAL_QUOTING: Quoting = { style: 'minimal', empty: false };

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
  return DELIMITERS.find((d) => d.char === char)?.label ?? `“${char}”`;
}

export interface ParseResult {
  rows: string[][];
  columnCount: number;
  lineEnding: LineEnding;
  ragged: boolean;
  /** Whether the text ended with a line break. */
  finalNewline: boolean;
  quoting: Quoting;
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
const QUOTING_SAMPLE_ROWS = 200;
const PLAIN_NUMBER = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;

/** Works out the quoting convention from which of the sampled fields were quoted without needing it. */
function detectQuoting(rows: string[][], quoted: boolean[][], delimiter: string): Quoting {
  let text = 0;
  let textQuoted = 0;
  let numbers = 0;
  let numbersQuoted = 0;
  let empty = 0;
  let emptyQuoted = 0;
  for (let r = 0; r < quoted.length; r++) {
    for (let c = 0; c < quoted[r].length; c++) {
      const v = rows[r][c];
      const q = quoted[r][c] ? 1 : 0;
      if (v === '') {
        empty++;
        emptyQuoted += q;
      } else if (needsQuote(v, delimiter)) {
        continue;
      } else if (PLAIN_NUMBER.test(v)) {
        numbers++;
        numbersQuoted += q;
      } else {
        text++;
        textQuoted += q;
      }
    }
  }
  const mostly = (part: number, whole: number): boolean => whole > 0 && part >= whole * 0.95;
  let style: Quoting['style'] = 'minimal';
  if (textQuoted + numbersQuoted > 0 && mostly(textQuoted + numbersQuoted, text + numbers)) style = 'all';
  else if (mostly(textQuoted, text) && numbersQuoted === 0) style = 'nonnumeric';
  if (style === 'minimal') return MINIMAL_QUOTING;
  return { style, empty: empty === 0 || mostly(emptyQuoted, empty) };
}

/** RFC 4180 parser. Tolerates unterminated quotes, mixed line endings, and ragged rows. */
export function parseCsv(text: string, delimiter: string): ParseResult {
  const rows: string[][] = [];
  const d = delimiter.charCodeAt(0);
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let row: string[] = [];
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  const quoted: boolean[][] = [];
  let quotedRow: boolean[] = [];

  if (i >= n) {
    return { rows, columnCount: 0, lineEnding: '\n', ragged: false, finalNewline: true, quoting: MINIMAL_QUOTING };
  }

  for (;;) {
    let field: string;
    const sampling = rows.length < QUOTING_SAMPLE_ROWS;
    if (sampling) quotedRow.push(text.charCodeAt(i) === QUOTE);
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
      if (sampling) quoted.push(quotedRow);
      rows.push(row);
      break;
    }
    const c = text.charCodeAt(i);
    if (c === d) {
      i++;
      if (i >= n) {
        if (sampling) quoted.push([...quotedRow, false]);
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
        cr++;
      }
    } else {
      i++;
      lf++;
    }
    if (sampling) quoted.push(quotedRow);
    quotedRow = [];
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

  const lineEnding: LineEnding = crlf > lf && crlf >= cr ? '\r\n' : cr > lf ? '\r' : '\n';
  const last = text.charCodeAt(n - 1);
  return {
    rows,
    columnCount,
    lineEnding,
    ragged,
    finalNewline: last === LF || last === CR,
    quoting: detectQuoting(rows, quoted.slice(0, rows.length), delimiter),
  };
}

function needsQuote(s: string, delimiter: string): boolean {
  if (s.length === 0) return false;
  if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || s.includes('\r')) return true;
  const first = s.charCodeAt(0);
  const last = s.charCodeAt(s.length - 1);
  return first === 32 || last === 32;
}

function wantsQuote(v: string, quoting: Quoting): boolean {
  if (quoting.style === 'minimal') return false;
  if (v === '') return quoting.empty;
  return quoting.style === 'all' || !PLAIN_NUMBER.test(v);
}

export function serializeRow(row: readonly string[], delimiter: string, quoting: Quoting = MINIMAL_QUOTING): string {
  let out = '';
  for (let c = 0; c < row.length; c++) {
    const v = row[c] ?? '';
    if (c > 0) out += delimiter;
    out += needsQuote(v, delimiter) || wantsQuote(v, quoting) ? '"' + v.replaceAll('"', '""') + '"' : v;
  }
  return out;
}

export interface SerializeOptions {
  quoting?: Quoting;
  finalNewline?: boolean;
}

export function serializeCsv(
  rows: Iterable<readonly string[]>,
  delimiter: string,
  lineEnding: LineEnding = '\n',
  { quoting = MINIMAL_QUOTING, finalNewline = true }: SerializeOptions = {},
): string {
  const lines: string[] = [];
  for (const r of rows) lines.push(serializeRow(r, delimiter, quoting));
  if (lines.length === 0) return '';
  return lines.join(lineEnding) + (finalNewline ? lineEnding : '');
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

/** The widest row's length. */
export function blockWidth(rows: readonly (readonly string[])[]): number {
  return rows.reduce((m, r) => Math.max(m, r.length), 0);
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
