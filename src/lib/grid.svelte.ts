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
  viewRows = $state.raw<number[] | null>(null);
  /** Whole columns selected by Ctrl-clicking their headers, besides those of the range. */
  picked = $state.raw<number[]>([]);
  /** The column the rows were last sorted by, until something reorders them again. */
  sortMark = $state.raw<{ c: number; dir: 'asc' | 'desc' } | null>(null);
  matches = $state.raw<Pos[]>([]);
  matchSet = $state.raw<Set<number>>(new Set());
  matchIndex = $state(-1);

  scrollIntoView: ((pos: Pos) => void) | null = null;
  focusGrid: (() => void) | null = null;

  constructor(readonly doc: Doc) {}

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
    return this.picked.length === 0 && this.anchor.r === this.focus.r && this.anchor.c === this.focus.c;
  }

  /** Whether the selection is columns that don't all sit side by side. */
  get isSplit(): boolean {
    return this.picked.length > 0;
  }

  get selectedRowIndices(): number[] {
    const { r0, r1 } = this.range;
    const out: number[] = [];
    for (let r = r0; r <= r1; r++) {
      const d = this.dataRow(r);
      if (d >= 0) out.push(d);
    }
    return out;
  }

  get selectedColIndices(): number[] {
    const { c0, c1 } = this.range;
    const out: number[] = [];
    for (let c = c0; c <= c1; c++) out.push(c);
    if (this.picked.length === 0) return out;
    return [...new Set([...out, ...this.picked])].sort((a, b) => a - b);
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
    if (this.picked.length > 0) this.selectColSet(this.selectedColIndices, this.focus.c);
  }

  /** Selects the whole columns `cols`, in order. The run holding `at` becomes the range and the rest are picked. */
  private selectColSet(cols: number[], at: number): void {
    const has = new Set(cols);
    let lo = at;
    let hi = at;
    while (has.has(lo - 1)) lo--;
    while (has.has(hi + 1)) hi++;
    const a = this.anchor.c;
    const [from, to] = a === lo || (a !== hi && at !== lo) ? [lo, hi] : [hi, lo];
    this.picked = cols.filter((x) => x < lo || x > hi);
    this.anchor = this.clamp({ r: 0, c: from });
    this.focus = this.clamp({ r: this.rowCount - 1, c: to });
  }

  private unpick(): void {
    if (this.picked.length > 0) this.picked = [];
  }

  contains(r: number, c: number): boolean {
    const g = this.range;
    return r >= g.r0 && r <= g.r1 && ((c >= g.c0 && c <= g.c1) || this.picked.includes(c));
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
    if (this.picked.length > 0) {
      const last = Math.max(0, this.rowCount - 1);
      if (this.anchor.r !== 0) this.anchor = { r: 0, c: this.anchor.c };
      if (this.focus.r !== last) this.focus = { r: last, c: this.focus.c };
      if (this.picked.some((c) => c >= this.colCount)) this.picked = this.picked.filter((c) => c < this.colCount);
    }
    const a = this.clamp(this.anchor);
    const f = this.clamp(this.focus);
    if (a.r !== this.anchor.r || a.c !== this.anchor.c) this.anchor = a;
    if (f.r !== this.focus.r || f.c !== this.focus.c) this.focus = f;
    if (this.editing && (this.editing.r >= this.rowCount || this.editing.c >= this.colCount)) this.editing = null;
  }
}
