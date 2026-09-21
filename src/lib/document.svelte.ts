import { parseCsv, serializeCsv, detectDelimiter, columnLetter, blockWidth, MINIMAL_QUOTING, type LineEnding, type Quoting } from './csv';
import { inferColumnType, toNumber, toTimestamp, detectDateOrder, looksLikeHeader } from './infer';

export interface Command {
  label: string;
  /** Whether it only changes cell contents or also moves rows and columns around. */
  kind?: 'cell' | 'structure';
  redo(): void;
  undo(): void;
}

export interface CellEdit {
  r: number;
  c: number;
  value: string;
}

/** Columns added or removed at these indices. `restored` marks columns brought back with their data. `reset` replaces them all. */
export type ColumnChange =
  | { kind: 'insert' | 'remove'; at: number[]; restored?: boolean }
  | { kind: 'move'; from: number; to: number }
  | { kind: 'reset' };

export interface LoadMeta {
  name: string;
  path: string | null;
  encoding: string;
  delimiter?: string;
  /** Overrides header detection. */
  hasHeader?: boolean;
}

const MAX_UNDO = 500;
const UNREACHABLE: Command = { label: '', redo() {}, undo() {} };
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** `list` with `items` inserted at `at`. Avoids spreading a long list into call arguments. */
function insertedAt<T>(list: T[], at: number, items: T[]): T[] {
  if (items.length < 10_000) {
    list.splice(at, 0, ...items);
    return list;
  }
  return [...list.slice(0, at), ...items, ...list.slice(at)];
}

export class Doc {
  rev = $state(0);
  loaded = $state(false);
  path = $state<string | null>(null);
  name = $state('Untitled');
  hasHeader = $state(true);
  delimiter = $state(',');
  encoding = $state('UTF-8');
  ragged = $state(false);
  dirty = $state(false);
  canUndo = $state(false);
  canRedo = $state(false);
  lineEnding: LineEnding = '\n';
  quoting: Quoting = MINIMAL_QUOTING;
  finalNewline = true;

  columns: string[] = [];
  rows: string[][] = [];

  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private cleanTop: Command | null = null;
  private sourceText: string | null = null;
  private listeners = new Set<(kind: 'cell' | 'structure' | 'load') => void>();

  private columnListeners = new Set<(change: ColumnChange) => void>();

  onColumnChange(fn: (change: ColumnChange) => void): () => void {
    this.columnListeners.add(fn);
    return () => this.columnListeners.delete(fn);
  }

  private emitColumns(change: ColumnChange): void {
    for (const fn of this.columnListeners) fn(change);
  }

  onChange(fn: (kind: 'cell' | 'structure' | 'load') => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get rowCount(): number {
    return this.rows.length;
  }

  get colCount(): number {
    return this.columns.length;
  }

  columnLabel(c: number): string {
    return this.hasHeader ? this.columns[c] : columnLetter(c);
  }

  cell(r: number, c: number): string {
    return this.rows[r]?.[c] ?? '';
  }

  /** Whether column `c` still has the name Bedsheet made up for it, or none. */
  hasGeneratedName(c: number): boolean {
    const name = this.columns[c] ?? '';
    return !this.hasHeader || name === '' || name === columnLetter(c) || /^Column \d+$/.test(name);
  }

  isColumnEmpty(c: number): boolean {
    return this.rows.every((row) => (row[c] ?? '') === '');
  }

  /** Nothing entered yet: no named columns and every cell empty. */
  isBlank(): boolean {
    return this.columns.every((_, c) => this.hasGeneratedName(c)) && this.rows.every((row) => row.every((v) => v === ''));
  }

  newSheet(rows = 30, cols = 6): void {
    this.reset();
    this.columns = Array.from({ length: cols }, (_, i) => columnLetter(i));
    this.rows = Array.from({ length: rows }, () => new Array<string>(cols).fill(''));
    this.hasHeader = false;
    this.name = 'Untitled';
    this.path = null;
    this.encoding = 'UTF-8';
    this.delimiter = ',';
    this.lineEnding = '\n';
    this.quoting = MINIMAL_QUOTING;
    this.finalNewline = true;
    this.loaded = true;
    this.touch('load');
  }

  loadText(text: string, meta: LoadMeta): void {
    this.reset();
    const delimiter = meta.delimiter ?? detectDelimiter(text, meta.name);
    const parsed = parseCsv(text, delimiter);
    this.sourceText = text;
    this.delimiter = delimiter;
    this.lineEnding = parsed.lineEnding;
    this.quoting = parsed.quoting;
    this.finalNewline = parsed.finalNewline;
    this.encoding = meta.encoding;
    this.ragged = parsed.ragged;
    this.name = meta.name;
    this.path = meta.path;
    if (parsed.rows.length > 0 && (meta.hasHeader ?? looksLikeHeader(parsed.rows))) {
      this.columns = parsed.rows[0];
      this.rows = parsed.rows.slice(1);
      this.hasHeader = true;
    } else if (parsed.rows.length > 0) {
      this.columns = Array.from({ length: parsed.columnCount }, (_, i) => columnLetter(i));
      this.rows = parsed.rows;
      this.hasHeader = false;
    } else {
      this.columns = ['A'];
      this.rows = [];
      this.hasHeader = false;
    }
    this.loaded = true;
    this.touch('load');
  }

  /** Re-parses the original text with another delimiter. Only allowed while clean. */
  reparse(delimiter: string): boolean {
    if (this.sourceText === null || this.dirty) return false;
    const meta: LoadMeta = { name: this.name, path: this.path, encoding: this.encoding, delimiter };
    this.loadText(this.sourceText, meta);
    return true;
  }

  close(): void {
    this.reset();
    this.loaded = false;
    this.touch('load');
  }

  toText(): string {
    const all = this.hasHeader ? [this.columns, ...this.rows] : this.rows;
    return serializeCsv(all, this.delimiter, this.lineEnding, { quoting: this.quoting, finalNewline: this.finalNewline });
  }

  /** Marks freshly loaded contents as not matching what is on disk. */
  markUnsaved(): void {
    this.cleanTop = UNREACHABLE;
    this.sourceText = null;
    this.dirty = true;
  }

  /** The current undo position, to pass to `markSaved` once a write started now has finished. */
  savePoint(): Command | null {
    return this.undoStack[this.undoStack.length - 1] ?? null;
  }

  markSaved(path: string | null, name: string, savePoint: Command | null = this.savePoint()): void {
    this.path = path;
    this.name = name;
    this.cleanTop = savePoint;
    this.sourceText = null;
    this.dirty = this.savePoint() !== savePoint;
  }

  undo(): string | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    this.touch(cmd.kind ?? 'structure');
    return cmd.label;
  }

  redo(): string | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.redo();
    this.undoStack.push(cmd);
    this.touch(cmd.kind ?? 'structure');
    return cmd.label;
  }

  setCell(r: number, c: number, value: string): void {
    const prev = this.cell(r, c);
    if (prev === value) return;
    this.exec(
      {
        label: 'Edit cell',
        redo: () => {
          this.rows[r][c] = value;
        },
        undo: () => {
          this.rows[r][c] = prev;
        },
      },
      'cell',
    );
  }

  setCells(edits: CellEdit[], label = 'Edit cells'): void {
    const changes = edits
      .map((e) => ({ ...e, prev: this.cell(e.r, e.c) }))
      .filter((e) => e.prev !== e.value);
    if (changes.length === 0) return;
    this.exec(
      {
        label,
        redo: () => {
          for (const e of changes) this.rows[e.r][e.c] = e.value;
        },
        undo: () => {
          for (const e of changes) this.rows[e.r][e.c] = e.prev;
        },
      },
      'cell',
    );
  }

  clearRange(r0: number, c0: number, r1: number, c1: number): void {
    const edits: CellEdit[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) edits.push({ r, c, value: '' });
    this.setCells(edits, 'Clear cells');
  }

  fillDown(r0: number, c0: number, r1: number, c1: number): void {
    const edits: CellEdit[] = [];
    for (let c = c0; c <= c1; c++) {
      const v = this.cell(r0, c);
      for (let r = r0 + 1; r <= r1; r++) edits.push({ r, c, value: v });
    }
    this.setCells(edits, 'Fill down');
  }

  /**
   * Writes a block of values at (r0, c0), growing the sheet if needed. `names` renames the columns
   * the block lands in, skipping undefined entries. One undo step.
   */
  applyBlock(r0: number, c0: number, block: string[][], label = 'Paste', names?: (string | undefined)[]): { rows: number; cols: number } {
    const blockRows = block.length;
    const blockCols = blockWidth(block);
    const addRows = Math.max(0, r0 + blockRows - this.rows.length);
    const addCols = Math.max(0, c0 + blockCols - this.columns.length);
    const prev: CellEdit[] = [];
    for (let r = 0; r < blockRows; r++) {
      for (let c = 0; c < blockCols; c++) {
        prev.push({ r: r0 + r, c: c0 + c, value: this.cell(r0 + r, c0 + c) });
      }
    }
    const prevCols = this.columns.length;
    const prevNames = (names ?? []).map((_, j) => this.columns[c0 + j]);
    this.exec(
      {
        label,
        redo: () => {
          for (let k = 0; k < addCols; k++) this.growColumn();
          for (let k = 0; k < addRows; k++) this.rows.push(new Array<string>(this.columns.length).fill(''));
          for (let r = 0; r < blockRows; r++) {
            for (let c = 0; c < blockCols; c++) this.rows[r0 + r][c0 + c] = block[r][c] ?? '';
          }
          names?.forEach((name, j) => {
            if (name !== undefined && c0 + j < this.columns.length) this.columns[c0 + j] = name;
          });
        },
        undo: () => {
          for (const e of prev) if (this.rows[e.r] && e.c < prevCols) this.rows[e.r][e.c] = e.value;
          prevNames.forEach((name, j) => {
            if (c0 + j < prevCols) this.columns[c0 + j] = name;
          });
          if (addRows > 0) this.rows.length -= addRows;
          if (addCols > 0) {
            this.columns.length = prevCols;
            for (const row of this.rows) row.length = prevCols;
          }
        },
      },
      'structure',
    );
    return { rows: blockRows, cols: blockCols };
  }

  /** Replaces every column and row. One undo step. */
  setContents(columns: string[], rows: string[][], hasHeader: boolean, label: string): void {
    const before = { columns: this.columns, rows: this.rows, hasHeader: this.hasHeader };
    const after = { columns, rows, hasHeader };
    const apply = (s: typeof before): void => {
      this.columns = s.columns;
      this.rows = s.rows;
      this.hasHeader = s.hasHeader;
      this.emitColumns({ kind: 'reset' });
    };
    this.exec({ label, redo: () => apply(after), undo: () => apply(before) }, 'structure');
  }

  /** Inserts `count` blank rows, or copies of `data` when given. */
  insertRows(at: number, count = 1, data?: string[][]): void {
    const width = this.columns.length;
    const noun = data ? 'Duplicate' : 'Insert';
    this.exec(
      {
        label: count === 1 ? `${noun} row` : `${noun} ${count} rows`,
        redo: () => {
          const fresh = Array.from({ length: count }, (_, i) => (data ? [...data[i]] : new Array<string>(width).fill('')));
          this.rows = insertedAt(this.rows, at, fresh);
        },
        undo: () => {
          this.rows.splice(at, count);
        },
      },
      'structure',
    );
  }

  deleteRows(indices: number[]): void {
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < this.rows.length).sort((a, b) => a - b);
    if (sorted.length === 0) return;
    let removed: string[][] = [];
    this.exec(
      {
        label: sorted.length === 1 ? 'Delete row' : `Delete ${sorted.length} rows`,
        redo: () => {
          removed = sorted.map((i) => this.rows[i]);
          const drop = new Set(sorted);
          this.rows = this.rows.filter((_, i) => !drop.has(i));
        },
        undo: () => {
          const kept = this.rows;
          const merged = new Array<string[]>(kept.length + sorted.length);
          for (let i = 0, k = 0, j = 0; i < merged.length; i++) {
            merged[i] = sorted[k] === i ? removed[k++] : kept[j++];
          }
          this.rows = merged;
        },
      },
      'structure',
    );
  }

  insertColumn(at: number, name?: string): void {
    this.exec(
      {
        label: 'Insert column',
        redo: () => {
          this.columns.splice(at, 0, name ?? this.freshColumnName(at));
          for (const row of this.rows) row.splice(at, 0, '');
          this.emitColumns({ kind: 'insert', at: [at] });
        },
        undo: () => {
          this.columns.splice(at, 1);
          for (const row of this.rows) row.splice(at, 1);
          this.emitColumns({ kind: 'remove', at: [at] });
        },
      },
      'structure',
    );
  }

  deleteColumns(indices: number[]): void {
    const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < this.columns.length).sort((a, b) => a - b);
    if (sorted.length === 0 || sorted.length >= this.columns.length) return;
    let names: string[] = [];
    let values: string[][] = [];
    this.exec(
      {
        label: sorted.length === 1 ? 'Delete column' : `Delete ${sorted.length} columns`,
        redo: () => {
          names = sorted.map((i) => this.columns[i]);
          values = this.rows.map((row) => sorted.map((i) => row[i]));
          for (let k = sorted.length - 1; k >= 0; k--) {
            this.columns.splice(sorted[k], 1);
            for (const row of this.rows) row.splice(sorted[k], 1);
          }
          this.emitColumns({ kind: 'remove', at: sorted });
        },
        undo: () => {
          for (let k = 0; k < sorted.length; k++) {
            this.columns.splice(sorted[k], 0, names[k]);
            for (let r = 0; r < this.rows.length; r++) this.rows[r].splice(sorted[k], 0, values[r][k]);
          }
          this.emitColumns({ kind: 'insert', at: sorted, restored: true });
        },
      },
      'structure',
    );
  }

  /** Moves the block of `count` rows starting at `from` one place up or down, by carrying its neighbour across it. */
  shiftRows(from: number, count: number, delta: 1 | -1): boolean {
    if (count < 1 || (delta < 0 ? from < 1 : from + count >= this.rows.length)) return false;
    const carry = (block: number, dir: 1 | -1): void => {
      if (dir < 0) this.rows.splice(block + count - 1, 0, this.rows.splice(block - 1, 1)[0]);
      else this.rows.splice(block, 0, this.rows.splice(block + count, 1)[0]);
    };
    this.exec(
      {
        label: count === 1 ? 'Move row' : `Move ${count} rows`,
        redo: () => carry(from, delta),
        undo: () => carry(from + delta, -delta as 1 | -1),
      },
      'structure',
    );
    return true;
  }

  /** The column counterpart of `shiftRows`. */
  shiftColumns(from: number, count: number, delta: 1 | -1): boolean {
    if (count < 1 || (delta < 0 ? from < 1 : from + count >= this.columns.length)) return false;
    const carry = (block: number, dir: 1 | -1): void => {
      const source = dir < 0 ? block - 1 : block + count;
      const target = dir < 0 ? block + count - 1 : block;
      this.columns.splice(target, 0, this.columns.splice(source, 1)[0]);
      for (const row of this.rows) row.splice(target, 0, row.splice(source, 1)[0]);
      this.emitColumns({ kind: 'move', from: source, to: target });
    };
    this.exec(
      {
        label: count === 1 ? 'Move column' : `Move ${count} columns`,
        redo: () => carry(from, delta),
        undo: () => carry(from + delta, -delta as 1 | -1),
      },
      'structure',
    );
    return true;
  }

  renameColumn(c: number, name: string): void {
    const prev = this.columns[c];
    if (prev === name) return;
    this.exec(
      {
        label: 'Rename column',
        redo: () => {
          this.columns[c] = name;
        },
        undo: () => {
          this.columns[c] = prev;
        },
      },
      'structure',
    );
  }

  /** Typed values first, then values that don't parse, then blanks. Only the first two follow `dir`. */
  sortBy(c: number, dir: 'asc' | 'desc'): void {
    const type = inferColumnType(this.rows, c);
    const sign = dir === 'asc' ? 1 : -1;
    const order = type === 'date' ? detectDateOrder(this.rows.map((row) => row[c] ?? '')) : 'mdy';
    const indexed = this.rows.map((row, i) => {
      const v = row[c] ?? '';
      if (v.trim() === '') return { i, v, k: 0, rank: 2 };
      const k = type === 'number' ? toNumber(v) : type === 'date' ? toTimestamp(v, order) : NaN;
      return { i, v, k, rank: Number.isNaN(k) ? 1 : 0 };
    });
    indexed.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const d = a.rank === 0 ? a.k - b.k : a.rank === 1 ? collator.compare(a.v, b.v) : 0;
      return d * sign || a.i - b.i;
    });
    const perm = indexed.map((x) => x.i);
    const inverse = new Array<number>(perm.length);
    for (let k = 0; k < perm.length; k++) inverse[perm[k]] = k;
    this.exec(
      {
        label: `Sort by ${this.columnLabel(c)}`,
        redo: () => {
          const old = this.rows;
          this.rows = perm.map((i) => old[i]);
        },
        undo: () => {
          const sorted = this.rows;
          this.rows = inverse.map((i) => sorted[i]);
        },
      },
      'structure',
    );
  }

  /** Changes the delimiter the file will be saved with. */
  setDelimiter(delimiter: string): void {
    const prev = this.delimiter;
    if (prev === delimiter) return;
    this.exec(
      {
        label: 'Change delimiter',
        redo: () => {
          this.delimiter = delimiter;
        },
        undo: () => {
          this.delimiter = prev;
        },
      },
      'cell',
    );
  }

  /** Changes the encoding the file will be saved in. */
  setEncoding(encoding: string): void {
    const prev = this.encoding;
    if (prev === encoding) return;
    this.exec(
      {
        label: 'Change encoding',
        redo: () => {
          this.encoding = encoding;
        },
        undo: () => {
          this.encoding = prev;
        },
      },
      'cell',
    );
  }

  setHasHeader(value: boolean): void {
    if (value === this.hasHeader) return;
    const width = this.columns.length;
    const letters = Array.from({ length: width }, (_, i) => columnLetter(i));
    let savedNames: string[] = [];
    const tookRow = value && this.rows.length > 0;
    this.exec(
      {
        label: value ? 'Use first row as header' : 'Treat header as data',
        redo: () => {
          if (value) {
            savedNames = this.columns;
            this.columns = tookRow ? this.rows.shift()! : letters.slice();
            this.hasHeader = true;
          } else {
            this.rows.unshift(this.columns);
            this.columns = letters.slice();
            this.hasHeader = false;
          }
        },
        undo: () => {
          if (value) {
            if (tookRow) this.rows.unshift(this.columns);
            this.columns = savedNames;
            this.hasHeader = false;
          } else {
            this.columns = this.rows.shift()!;
            this.hasHeader = true;
          }
        },
      },
      'structure',
    );
  }

  private growColumn(): void {
    this.columns.push(this.freshColumnName(this.columns.length));
    for (const row of this.rows) row.push('');
  }

  private freshColumnName(at: number): string {
    if (!this.hasHeader) return columnLetter(at);
    const taken = new Set(this.columns);
    let n = at + 1;
    let name = `Column ${n}`;
    while (taken.has(name)) name = `Column ${++n}`;
    return name;
  }

  private exec(cmd: Command, kind: 'cell' | 'structure'): void {
    cmd.kind = kind;
    cmd.redo();
    this.undoStack.push(cmd);
    if (this.undoStack.length > MAX_UNDO) {
      const dropped = this.undoStack.shift();
      if (this.cleanTop === null) this.cleanTop = UNREACHABLE;
      else if (this.cleanTop === dropped) this.cleanTop = null;
    }
    this.redoStack = [];
    this.touch(kind);
  }

  private touch(kind: 'cell' | 'structure' | 'load'): void {
    this.rev++;
    this.canUndo = this.undoStack.length > 0;
    this.canRedo = this.redoStack.length > 0;
    this.dirty = (this.undoStack[this.undoStack.length - 1] ?? null) !== this.cleanTop;
    for (const fn of this.listeners) fn(kind);
  }

  private reset(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.cleanTop = null;
    this.sourceText = null;
    this.ragged = false;
    this.dirty = false;
  }
}
