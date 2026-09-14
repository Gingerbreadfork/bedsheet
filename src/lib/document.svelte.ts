import { parseCsv, serializeCsv, detectDelimiter, columnLetter, type LineEnding } from './csv';
import { inferColumnType, toNumber } from './infer';

export interface Command {
  label: string;
  redo(): void;
  undo(): void;
}

export interface CellEdit {
  r: number;
  c: number;
  value: string;
}

export interface LoadMeta {
  name: string;
  path: string | null;
  encoding: string;
  delimiter?: string;
}

const MAX_UNDO = 500;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

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

  columns: string[] = [];
  rows: string[][] = [];

  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private cleanTop: Command | null = null;
  private sourceText: string | null = null;
  private listeners = new Set<(kind: 'cell' | 'structure' | 'load') => void>();

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
    this.encoding = meta.encoding;
    this.ragged = parsed.ragged;
    this.name = meta.name;
    this.path = meta.path;
    if (parsed.rows.length > 0) {
      this.columns = parsed.rows[0];
      this.rows = parsed.rows.slice(1);
      this.hasHeader = true;
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
    return serializeCsv(all, this.delimiter, this.lineEnding);
  }

  markSaved(path: string | null, name: string): void {
    this.path = path;
    this.name = name;
    this.cleanTop = this.undoStack[this.undoStack.length - 1] ?? null;
    this.sourceText = null;
    this.dirty = false;
  }

  undo(): string | null {
    const cmd = this.undoStack.pop();
    if (!cmd) return null;
    cmd.undo();
    this.redoStack.push(cmd);
    this.touch('structure');
    return cmd.label;
  }

  redo(): string | null {
    const cmd = this.redoStack.pop();
    if (!cmd) return null;
    cmd.redo();
    this.undoStack.push(cmd);
    this.touch('structure');
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

  /** Writes a block of values at (r0, c0), growing the sheet if needed. One undo step. */
  applyBlock(r0: number, c0: number, block: string[][], label = 'Paste'): { rows: number; cols: number } {
    const blockRows = block.length;
    const blockCols = block.reduce((m, r) => Math.max(m, r.length), 0);
    const addRows = Math.max(0, r0 + blockRows - this.rows.length);
    const addCols = Math.max(0, c0 + blockCols - this.columns.length);
    const prev: CellEdit[] = [];
    for (let r = 0; r < blockRows; r++) {
      for (let c = 0; c < blockCols; c++) {
        prev.push({ r: r0 + r, c: c0 + c, value: this.cell(r0 + r, c0 + c) });
      }
    }
    const prevCols = this.columns.length;
    this.exec(
      {
        label,
        redo: () => {
          for (let k = 0; k < addCols; k++) this.growColumn();
          for (let k = 0; k < addRows; k++) this.rows.push(new Array<string>(this.columns.length).fill(''));
          for (let r = 0; r < blockRows; r++) {
            for (let c = 0; c < blockCols; c++) this.rows[r0 + r][c0 + c] = block[r][c] ?? '';
          }
        },
        undo: () => {
          for (const e of prev) if (this.rows[e.r] && e.c < prevCols) this.rows[e.r][e.c] = e.value;
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

  insertRows(at: number, count = 1): void {
    const width = this.columns.length;
    this.exec(
      {
        label: count === 1 ? 'Insert row' : `Insert ${count} rows`,
        redo: () => {
          const fresh = Array.from({ length: count }, () => new Array<string>(width).fill(''));
          this.rows.splice(at, 0, ...fresh);
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
          for (let k = 0; k < sorted.length; k++) this.rows.splice(sorted[k], 0, removed[k]);
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
        },
        undo: () => {
          this.columns.splice(at, 1);
          for (const row of this.rows) row.splice(at, 1);
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
        },
        undo: () => {
          for (let k = 0; k < sorted.length; k++) {
            this.columns.splice(sorted[k], 0, names[k]);
            for (let r = 0; r < this.rows.length; r++) this.rows[r].splice(sorted[k], 0, values[r][k]);
          }
        },
      },
      'structure',
    );
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

  sortBy(c: number, dir: 'asc' | 'desc'): void {
    const type = inferColumnType(this.rows, c);
    const sign = dir === 'asc' ? 1 : -1;
    const indexed = this.rows.map((row, i) => ({ i, v: row[c] ?? '' }));
    const compare = (a: { v: string }, b: { v: string }): number => {
      const ae = a.v.trim() === '';
      const be = b.v.trim() === '';
      if (ae || be) return ae && be ? 0 : ae ? 1 : -1;
      if (type === 'number') return (toNumber(a.v) - toNumber(b.v)) * sign;
      if (type === 'date') return (Date.parse(a.v) - Date.parse(b.v)) * sign;
      return collator.compare(a.v, b.v) * sign;
    };
    indexed.sort((a, b) => compare(a, b) || a.i - b.i);
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

  setHasHeader(value: boolean): void {
    if (value === this.hasHeader) return;
    const width = this.columns.length;
    const letters = Array.from({ length: width }, (_, i) => columnLetter(i));
    let savedNames: string[] = [];
    this.exec(
      {
        label: value ? 'Use first row as header' : 'Treat header as data',
        redo: () => {
          if (value) {
            savedNames = this.columns;
            this.columns = this.rows.length > 0 ? this.rows.shift()! : letters.slice();
            this.hasHeader = true;
          } else {
            this.rows.unshift(this.columns);
            this.columns = letters.slice();
            this.hasHeader = false;
          }
        },
        undo: () => {
          if (value) {
            this.rows.unshift(this.columns);
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
    cmd.redo();
    this.undoStack.push(cmd);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
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
