import type { Doc } from './document.svelte';

export interface Pos {
  r: number;
  c: number;
}

export interface Range {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** Rows r0 to r1, in view order. */
export interface RowRun {
  r0: number;
  r1: number;
}

export interface EditState {
  r: number;
  c: number;
  initial: string;
  mode: 'replace' | 'edit';
}

export const COL_STRIDE = 1 << 20;
export const cellKey = (r: number, c: number): number => r * COL_STRIDE + c;

export const MIN_COL_WIDTH = 48;
export const MAX_COL_WIDTH = 560;
export const DEFAULT_COL_WIDTH = 140;

/** Sorts runs of rows and joins those that overlap or touch. */
function joinRuns(runs: RowRun[]): RowRun[] {
  const out: RowRun[] = [];
  for (const run of [...runs].sort((a, b) => a.r0 - b.r0)) {
    const last = out[out.length - 1];
    if (last && run.r0 <= last.r1 + 1) last.r1 = Math.max(last.r1, run.r1);
    else out.push({ r0: run.r0, r1: run.r1 });
  }
  return out;
}

/** View-level state for the grid: selection, editing, layout, and search overlays. */
export class GridState {
  anchor = $state.raw<Pos>({ r: 0, c: 0 });
  focus = $state.raw<Pos>({ r: 0, c: 0 });
  editing = $state.raw<EditState | null>(null);
  editingHeader = $state<number | null>(null);
  /** The keyboard cursor is on the column headers rather than in the cells. */
  inHeader = $state(false);
  /** Text to start a header rename with, when it was begun by typing. */
  headerDraft: string | null = null;
  widths = $state<number[]>([]);
  zoom = $state(1);
  mono = $state(false);
  /** Whole columns selected by Ctrl-clicking their headers, besides those of the range. */
  pickedCols = $state.raw<number[]>([]);
  /** Runs of whole rows selected by Ctrl-clicking their numbers, besides the range's own rows. */
  pickedRows = $state.raw<RowRun[]>([]);
  #viewRows = $state.raw<number[] | null>(null);
  /** The column the rows were last sorted by, until something reorders them again. */
  sortMark = $state.raw<{ c: number; dir: 'asc' | 'desc' } | null>(null);
  matches = $state.raw<Pos[]>([]);
  matchSet = $state.raw<Set<number>>(new Set());
  matchIndex = $state(-1);

  scrollIntoView: ((pos: Pos) => void) | null = null;
  focusGrid: (() => void) | null = null;

  constructor(readonly doc: Doc) {}

  /** The document rows a filter shows, or null when all of them show. Changing them drops picked rows. */
  get viewRows(): number[] | null {
    return this.#viewRows;
  }

  set viewRows(rows: number[] | null) {
    if (rows !== this.#viewRows && this.pickedRows.length > 0) this.pickedRows = [];
    this.#viewRows = rows;
  }

  get rowCount(): number {
    void this.doc.rev;
    return this.viewRows ? this.viewRows.length : this.doc.rows.length;
  }

  get colCount(): number {
    void this.doc.rev;
    return this.doc.colCount;
  }

  /** The document row shown at `viewRow`, or -1 when a filter leaves nothing there. */
  dataRow(viewRow: number): number {
    return this.viewRows ? (this.viewRows[viewRow] ?? -1) : viewRow;
  }

  viewRow(dataRow: number): number {
    const v = this.viewRows;
    if (!v) return dataRow;
    let lo = 0;
    let hi = v.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (v[mid] === dataRow) return mid;
      if (v[mid] < dataRow) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  get active(): Pos {
    return this.anchor;
  }

  get range(): Range {
    const a = this.anchor;
    const f = this.focus;
    return {
      r0: Math.min(a.r, f.r),
      c0: Math.min(a.c, f.c),
      r1: Math.max(a.r, f.r),
      c1: Math.max(a.c, f.c),
    };
  }

  get isSingle(): boolean {
    return !this.isSplit && this.anchor.r === this.focus.r && this.anchor.c === this.focus.c;
  }

  /** Whether the selection is columns that don't all sit side by side. */
  get splitCols(): boolean {
    return this.pickedCols.length > 0;
  }

  /** Whether the selection is rows that don't all sit side by side. */
  get splitRows(): boolean {
    return this.pickedRows.length > 0;
  }

  /** Whether the selection is more than one block. */
  get isSplit(): boolean {
    return this.splitCols || this.splitRows;
  }

  /** The selected rows as runs of neighbours, top to bottom, in view rows. */
  get rowRuns(): RowRun[] {
    const { r0, r1 } = this.range;
    return this.pickedRows.length === 0 ? [{ r0, r1 }] : joinRuns([...this.pickedRows, { r0, r1 }]);
  }

  get selectedRowCount(): number {
    return this.rowRuns.reduce((n, run) => n + run.r1 - run.r0 + 1, 0);
  }

  /** The selected rows in view rows, top to bottom. */
  get selectedViewRows(): number[] {
    const out: number[] = [];
    for (const run of this.rowRuns) for (let r = run.r0; r <= run.r1; r++) out.push(r);
    return out;
  }

  get selectedRowIndices(): number[] {
    const out: number[] = [];
    for (const r of this.selectedViewRows) {
      const d = this.dataRow(r);
      if (d >= 0) out.push(d);
    }
    return out;
  }

  get selectedColIndices(): number[] {
    const { c0, c1 } = this.range;
    const out: number[] = [];
    for (let c = c0; c <= c1; c++) out.push(c);
    if (this.pickedCols.length === 0) return out;
    return [...new Set([...out, ...this.pickedCols])].sort((a, b) => a - b);
  }

  /** The selected columns as runs of neighbours, left to right. */
  get colRuns(): { c0: number; c1: number }[] {
    const runs: { c0: number; c1: number }[] = [];
    for (const c of this.selectedColIndices) {
      const last = runs[runs.length - 1];
      if (last && last.c1 === c - 1) last.c1 = c;
      else runs.push({ c0: c, c1: c });
    }
    return runs;
  }

  clamp(p: Pos): Pos {
    const rows = Math.max(0, this.rowCount - 1);
    const cols = Math.max(0, this.colCount - 1);
    return { r: Math.min(Math.max(0, p.r), rows), c: Math.min(Math.max(0, p.c), cols) };
  }

  select(r: number, c: number, scroll = true): void {
    this.unpick();
    const p = this.clamp({ r, c });
    this.anchor = p;
    this.focus = p;
    if (scroll) this.scrollIntoView?.(p);
  }

  extendTo(r: number, c: number, scroll = true): void {
    this.unpick();
    const p = this.clamp({ r, c });
    this.focus = p;
    if (scroll) this.scrollIntoView?.(p);
  }

  /** Moves the cursor (or the focus corner when extending). `jump` goes to the sheet edge. */
  move(dr: number, dc: number, extend: boolean, jump = false): void {
    const base = extend ? this.focus : this.anchor;
    let r = base.r;
    let c = base.c;
    if (jump) {
      if (dr < 0) r = 0;
      if (dr > 0) r = this.rowCount - 1;
      if (dc < 0) c = 0;
      if (dc > 0) c = this.colCount - 1;
    } else {
      r += dr;
      c += dc;
    }
    if (extend) this.extendTo(r, c);
    else this.select(r, c);
  }

  selectAll(): void {
    this.unpick();
    this.inHeader = false;
    this.anchor = { r: 0, c: 0 };
    this.focus = this.clamp({ r: this.rowCount - 1, c: this.colCount - 1 });
  }

  selectRows(from: number, to: number): void {
    this.unpick();
    this.anchor = this.clamp({ r: from, c: 0 });
    this.focus = this.clamp({ r: to, c: this.colCount - 1 });
  }

  selectCols(from: number, to: number): void {
    this.unpick();
    this.anchor = this.clamp({ r: 0, c: from });
    this.focus = this.clamp({ r: this.rowCount - 1, c: to });
  }

  /** Stretches the range to the whole columns from its anchor to `c`, keeping any picked columns. */
  extendCols(c: number): void {
    if (this.pickedRows.length > 0) this.pickedRows = [];
    this.anchor = this.clamp({ r: 0, c: this.anchor.c });
    this.focus = this.clamp({ r: this.rowCount - 1, c });
  }

  /**
   * Adds column `c` to the selected columns, or takes it out when it is already one of several.
   * Anything but whole columns gives way to column `c` alone. Returns whether `c` is now selected.
   */
  toggleCol(c: number): boolean {
    const { r0, r1 } = this.range;
    if (r0 !== 0 || r1 < this.rowCount - 1) {
      this.selectCols(c, c);
      return true;
    }
    const cols = this.selectedColIndices;
    if (!cols.includes(c)) {
      this.selectColSet([...cols, c].sort((a, b) => a - b), c);
      return true;
    }
    const rest = cols.filter((x) => x !== c);
    if (rest.length === 0) return true;
    const keep = rest.includes(this.anchor.c) ? this.anchor.c : (rest.find((x) => x > c) ?? rest[rest.length - 1]);
    this.selectColSet(rest, keep);
    return false;
  }

  /** Folds picked columns the range has reached into it, and all of them when they end up side by side. */
  settleCols(): void {
    if (this.pickedCols.length > 0) this.selectColSet(this.selectedColIndices, this.focus.c);
  }

  /**
   * Selects the whole columns `cols`, in order. The run holding `at` becomes the range and the rest are
   * picked. The anchor stays put when it is an end of that run, and otherwise moves to `at` if it can.
   */
  private selectColSet(cols: number[], at: number): void {
    const has = new Set(cols);
    let lo = at;
    let hi = at;
    while (has.has(lo - 1)) lo--;
    while (has.has(hi + 1)) hi++;
    const a = this.anchor.c;
    const anchor = a === lo || a === hi ? a : at === hi ? hi : lo;
    const [from, to] = anchor === lo ? [lo, hi] : [hi, lo];
    this.pickedCols = cols.filter((x) => x < lo || x > hi);
    this.anchor = this.clamp({ r: 0, c: from });
    this.focus = this.clamp({ r: this.rowCount - 1, c: to });
  }

  /** Stretches the range to the whole rows from its anchor to `r`, keeping any picked rows. */
  extendRows(r: number): void {
    if (this.pickedCols.length > 0) this.pickedCols = [];
    this.anchor = this.clamp({ r: this.anchor.r, c: 0 });
    this.focus = this.clamp({ r, c: this.colCount - 1 });
  }

  /**
   * Adds row `r` to the selected rows, or takes it out when it is already one of several.
   * Anything but whole rows gives way to row `r` alone. Returns whether `r` is now selected.
   */
  toggleRow(r: number): boolean {
    const { c0, c1 } = this.range;
    if (this.pickedCols.length > 0 || c0 !== 0 || c1 < this.colCount - 1) {
      this.selectRows(r, r);
      return true;
    }
    const runs = this.rowRuns;
    const hit = runs.find((run) => r >= run.r0 && r <= run.r1);
    if (!hit) {
      this.selectRowRuns([...runs, { r0: r, r1: r }], r);
      return true;
    }
    const rest = runs.filter((run) => run !== hit);
    if (hit.r0 < r) rest.push({ r0: hit.r0, r1: r - 1 });
    if (hit.r1 > r) rest.push({ r0: r + 1, r1: hit.r1 });
    if (rest.length === 0) return true;
    const a = this.anchor.r;
    const below = hit.r1 > r ? r + 1 : runs.find((run) => run.r0 > r)?.r0;
    const keep = a !== r ? a : (below ?? Math.max(...rest.map((run) => run.r1)));
    this.selectRowRuns(rest, keep);
    return false;
  }

  /** Folds picked rows the range has reached into it, and all of them when they end up side by side. */
  settleRows(): void {
    if (this.pickedRows.length > 0) this.selectRowRuns(this.rowRuns, this.focus.r);
  }

  /** The row counterpart of `selectColSet`, taking runs of rows. */
  private selectRowRuns(runs: RowRun[], at: number): void {
    const joined = joinRuns(runs);
    const own = joined.find((run) => at >= run.r0 && at <= run.r1)!;
    const { r0: lo, r1: hi } = own;
    const a = this.anchor.r;
    const anchor = a === lo || a === hi ? a : at === hi ? hi : lo;
    const [from, to] = anchor === lo ? [lo, hi] : [hi, lo];
    this.pickedRows = joined.filter((run) => run !== own);
    this.anchor = this.clamp({ r: from, c: 0 });
    this.focus = this.clamp({ r: to, c: this.colCount - 1 });
  }

  private unpick(): void {
    if (this.pickedCols.length > 0) this.pickedCols = [];
    if (this.pickedRows.length > 0) this.pickedRows = [];
  }

  contains(r: number, c: number): boolean {
    const g = this.range;
    const inRows = (r >= g.r0 && r <= g.r1) || this.pickedRows.some((run) => r >= run.r0 && r <= run.r1);
    return inRows && ((c >= g.c0 && c <= g.c1) || this.pickedCols.includes(c));
  }

  startEdit(mode: 'replace' | 'edit', initial?: string): void {
    if (this.rowCount === 0 || this.colCount === 0) return;
    const { r, c } = this.anchor;
    this.editing = {
      r,
      c,
      mode,
      initial: initial ?? (mode === 'edit' ? this.doc.cell(this.dataRow(r), c) : ''),
    };
  }

  ensureValid(): void {
    let cut = false;
    if (this.pickedCols.length > 0) {
      const last = Math.max(0, this.rowCount - 1);
      if (this.anchor.r !== 0) this.anchor = { r: 0, c: this.anchor.c };
      if (this.focus.r !== last) this.focus = { r: last, c: this.focus.c };
      cut = this.anchor.c >= this.colCount || this.focus.c >= this.colCount || this.pickedCols.some((c) => c >= this.colCount);
      if (cut) this.pickedCols = this.pickedCols.filter((c) => c < this.colCount);
    }
    if (this.pickedRows.length > 0) {
      const last = Math.max(0, this.colCount - 1);
      if (this.anchor.c !== 0) this.anchor = { r: this.anchor.r, c: 0 };
      if (this.focus.c !== last) this.focus = { r: this.focus.r, c: last };
      if (this.pickedRows.some((run) => run.r1 >= this.rowCount)) this.pickedRows = [];
    }
    const a = this.clamp(this.anchor);
    const f = this.clamp(this.focus);
    if (a.r !== this.anchor.r || a.c !== this.anchor.c) this.anchor = a;
    if (f.r !== this.focus.r || f.c !== this.focus.c) this.focus = f;
    if (cut) this.settleCols();
    if (this.editing && (this.editing.r >= this.rowCount || this.editing.c >= this.colCount)) this.editing = null;
  }
}
