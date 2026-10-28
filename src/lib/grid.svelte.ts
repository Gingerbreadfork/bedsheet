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
  /** The view row and column the edit was started on. */
  r: number;
  c: number;
  /** The document row the value belongs to, fixed when the edit starts. */
  dr: number;
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

const inRange = (b: Range, r: number, c: number): boolean => r >= b.r0 && r <= b.r1 && c >= b.c0 && c <= b.c1;

const overlaps = (a: Range, b: Range): boolean => a.r0 <= b.r1 && b.r0 <= a.r1 && a.c0 <= b.c1 && b.c0 <= a.c1;

/** The parts of block `b` that lie outside `cut`: the strips above and below it, then those left and right. */
function subtract(b: Range, cut: Range): Range[] {
  if (!overlaps(b, cut)) return [b];
  const out: Range[] = [];
  if (b.r0 < cut.r0) out.push({ r0: b.r0, c0: b.c0, r1: cut.r0 - 1, c1: b.c1 });
  if (b.r1 > cut.r1) out.push({ r0: cut.r1 + 1, c0: b.c0, r1: b.r1, c1: b.c1 });
  const r0 = Math.max(b.r0, cut.r0);
  const r1 = Math.min(b.r1, cut.r1);
  if (b.c0 < cut.c0) out.push({ r0, c0: b.c0, r1, c1: cut.c0 - 1 });
  if (b.c1 > cut.c1) out.push({ r0, c0: cut.c1 + 1, r1, c1: b.c1 });
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
  /** Blocks of cells selected by Ctrl-clicking or Ctrl-dragging, besides the range, newest first. */
  pickedBlocks = $state.raw<Range[]>([]);
  #viewRows = $state.raw<number[] | null>(null);
  /** The column the rows were last sorted by, until something reorders them again. */
  sortMark = $state.raw<{ c: number; dir: 'asc' | 'desc' } | null>(null);
  matches = $state.raw<Pos[]>([]);
  matchSet = $state.raw<Set<number>>(new Set());
  matchIndex = $state(-1);

  scrollIntoView: ((pos: Pos) => void) | null = null;
  focusGrid: (() => void) | null = null;

  constructor(readonly doc: Doc) {}

  /** The document rows a filter shows, or null when all of them show. Changing them drops picked rows and blocks. */
  get viewRows(): number[] | null {
    return this.#viewRows;
  }

  set viewRows(rows: number[] | null) {
    if (rows !== this.#viewRows) {
      if (this.pickedRows.length > 0) this.pickedRows = [];
      if (this.pickedBlocks.length > 0) this.pickedBlocks = [];
    }
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

  /** Whether the selection is cells or blocks that don't all sit side by side. */
  get splitCells(): boolean {
    return this.pickedBlocks.length > 0;
  }

  /** Whether the selection is more than one block. */
  get isSplit(): boolean {
    return this.splitCols || this.splitRows || this.splitCells;
  }

  /**
   * The selection as blocks that don't overlap, in view coordinates. Picked rows and columns cross
   * into one block per pair of runs; picked blocks come after the range, trimmed to what it misses.
   */
  get blocks(): Range[] {
    const range = this.range;
    if (this.pickedBlocks.length === 0) {
      if (this.pickedRows.length === 0 && this.pickedCols.length === 0) return [range];
      const cols = this.colRuns;
      return this.rowRuns.flatMap((rows) => cols.map((c) => ({ r0: rows.r0, c0: c.c0, r1: rows.r1, c1: c.c1 })));
    }
    const out: Range[] = [range];
    for (const b of this.pickedBlocks) {
      let pieces = [b];
      for (const prior of [...out]) pieces = pieces.flatMap((p) => subtract(p, prior));
      out.push(...pieces);
    }
    return out;
  }

  /** The selected rows as runs of neighbours, top to bottom, in view rows. */
  get rowRuns(): RowRun[] {
    const { r0, r1 } = this.range;
    if (this.pickedBlocks.length > 0) return joinRuns([{ r0, r1 }, ...this.pickedBlocks.map((b) => ({ r0: b.r0, r1: b.r1 }))]);
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
    if (this.pickedCols.length === 0 && this.pickedBlocks.length === 0) return out;
    const all = new Set(out);
    for (const c of this.pickedCols) all.add(c);
    for (const b of this.pickedBlocks) for (let c = b.c0; c <= b.c1; c++) all.add(c);
    return [...all].sort((a, b) => a - b);
  }

  /** How many cells are selected. */
  get selectedCellCount(): number {
    return this.blocks.reduce((n, b) => n + (b.r1 - b.r0 + 1) * (b.c1 - b.c0 + 1), 0);
  }

  /** The selected cells row by row, top to bottom, each row's columns left to right, in view coordinates. */
  get selectedCellRows(): { r: number; cols: number[] }[] {
    if (this.pickedBlocks.length === 0) {
      const cols = this.selectedColIndices;
      return this.selectedViewRows.map((r) => ({ r, cols }));
    }
    const blocks = this.blocks;
    return this.selectedViewRows.map((r) => {
      const cols = new Set<number>();
      for (const b of blocks) if (r >= b.r0 && r <= b.r1) for (let c = b.c0; c <= b.c1; c++) cols.add(c);
      return { r, cols: [...cols].sort((a, b) => a - b) };
    });
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

  /** Moves the focus corner of the range. Picked blocks stay; picked rows and columns give way. */
  extendTo(r: number, c: number, scroll = true): void {
    if (this.pickedCols.length > 0) this.pickedCols = [];
    if (this.pickedRows.length > 0) this.pickedRows = [];
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
    if (this.pickedBlocks.length > 0) return this.toggleBlock({ r0: 0, c0: c, r1: Math.max(0, this.rowCount - 1), c1: c });
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
    if (this.pickedBlocks.length > 0) return this.toggleBlock({ r0: r, c0: 0, r1: r, c1: Math.max(0, this.colCount - 1) });
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

  /**
   * Adds cell (r, c) to the selection as a block of its own, or takes it out when it is already selected,
   * splitting the block it was part of. Returns whether the cell is now selected.
   */
  toggleCell(r: number, c: number): boolean {
    return this.toggleBlock({ r0: r, c0: c, r1: r, c1: c });
  }

  /**
   * Adds `block` as the range, with the anchor at its top-left corner, moving what was selected into the
   * picked blocks. When every cell of it is selected already, it is cut out of the selection instead,
   * unless nothing would be left. Returns whether its cells are selected afterwards.
   */
  private toggleBlock(block: Range): boolean {
    const held = this.blocks;
    if (this.pickedCols.length > 0) this.pickedCols = [];
    if (this.pickedRows.length > 0) this.pickedRows = [];
    if (!this.isCovered(held, block)) {
      this.pickedBlocks = held;
      this.anchor = { r: block.r0, c: block.c0 };
      this.focus = { r: block.r1, c: block.c1 };
      this.settleCells();
      return true;
    }
    const rest = held.flatMap((b) => subtract(b, block));
    if (rest.length === 0) {
      this.pickedBlocks = held.slice(1);
      return true;
    }
    const a = this.anchor;
    const own = rest.find((b) => inRange(b, a.r, a.c)) ?? rest[0];
    const atCorner = inRange(own, a.r, a.c) && (a.r === own.r0 || a.r === own.r1) && (a.c === own.c0 || a.c === own.c1);
    const from = atCorner ? a : { r: own.r0, c: own.c0 };
    this.pickedBlocks = rest.filter((b) => b !== own);
    this.anchor = from;
    this.focus = { r: from.r === own.r0 ? own.r1 : own.r0, c: from.c === own.c0 ? own.c1 : own.c0 };
    return false;
  }

  /** Whether `blocks` cover every cell of `block`. */
  private isCovered(blocks: Range[], block: Range): boolean {
    let left = [block];
    for (const b of blocks) {
      left = left.flatMap((p) => subtract(p, b));
      if (left.length === 0) return true;
    }
    return false;
  }

  /** Stretches the selection to the whole rows it touches; rows that are apart stay apart. */
  widenToRows(): void {
    const runs = this.rowRuns;
    const at = this.anchor.r;
    this.unpick();
    if (runs.length === 1) this.selectRows(runs[0].r0, runs[0].r1);
    else this.selectRowRuns(runs, at);
  }

  /** Stretches the selection to the whole columns it touches; columns that are apart stay apart. */
  widenToCols(): void {
    const cols = this.selectedColIndices;
    const runs = this.colRuns.length;
    const at = this.anchor.c;
    this.unpick();
    if (runs === 1) this.selectCols(cols[0], cols[cols.length - 1]);
    else this.selectColSet(cols, at);
  }

  /** Trims the picked blocks to the cells the range doesn't cover, so none is selected twice. */
  settleCells(): void {
    if (this.pickedBlocks.length === 0) return;
    const range = this.range;
    const trimmed = this.pickedBlocks.flatMap((b) => subtract(b, range));
    const same = trimmed.length === this.pickedBlocks.length && trimmed.every((b, i) => b === this.pickedBlocks[i]);
    if (!same) this.pickedBlocks = trimmed;
  }

  private unpick(): void {
    if (this.pickedCols.length > 0) this.pickedCols = [];
    if (this.pickedRows.length > 0) this.pickedRows = [];
    if (this.pickedBlocks.length > 0) this.pickedBlocks = [];
  }

  contains(r: number, c: number): boolean {
    const g = this.range;
    if (this.pickedBlocks.some((b) => inRange(b, r, c))) return true;
    const inRows = (r >= g.r0 && r <= g.r1) || this.pickedRows.some((run) => r >= run.r0 && r <= run.r1);
    return inRows && ((c >= g.c0 && c <= g.c1) || this.pickedCols.includes(c));
  }

  startEdit(mode: 'replace' | 'edit', initial?: string): void {
    if (this.rowCount === 0 || this.colCount === 0) return;
    const { r, c } = this.anchor;
    const dr = this.dataRow(r);
    this.editing = {
      r,
      c,
      dr,
      mode,
      initial: initial ?? (mode === 'edit' ? this.doc.cell(dr, c) : ''),
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
    if (this.pickedBlocks.some((b) => b.r1 >= this.rowCount || b.c1 >= this.colCount)) this.pickedBlocks = [];
    const a = this.clamp(this.anchor);
    const f = this.clamp(this.focus);
    if (a.r !== this.anchor.r || a.c !== this.anchor.c) this.anchor = a;
    if (f.r !== this.focus.r || f.c !== this.focus.c) this.focus = f;
    if (cut) this.settleCols();
    const e = this.editing;
    if (e && (e.r >= this.rowCount || e.c >= this.colCount || e.dr >= this.doc.rowCount)) this.editing = null;
  }
}
