import { Doc } from './document.svelte';
import { GridState, cellKey, DEFAULT_COL_WIDTH, type Pos } from './grid.svelte';
import { decodeBytes, serializeCsv, parseClipboardBlock, DELIMITERS, delimiterLabel } from './csv';
import { parseShortcut, eventMatches, isEditableTarget, type Shortcut } from './keys';
import type { CellEdit } from './document.svelte';
import {
  isTauri,
  pickFile,
  readPath,
  saveText,
  launchFiles,
  clipboard,
  win,
  loadRecent,
  pushRecent,
  removeRecent,
  loadSetting,
  saveSetting,
  type OpenedFile,
  type RecentEntry,
} from './platform';

export type Theme = 'system' | 'light' | 'dark';
export type Group = 'File' | 'Edit' | 'Rows' | 'Columns' | 'Find' | 'View' | 'Help';

export interface CommandDef {
  id: string;
  title: string | (() => string);
  group: Group;
  shortcut?: string;
  altShortcuts?: string[];
  /** Shown as a hint only; the key is handled natively (clipboard events). */
  nativeKey?: boolean;
  /** Fires even while typing in an input. */
  global?: boolean;
  when?: () => boolean;
  run: () => unknown;
}

export type MenuItem =
  | {
      label: string;
      shortcut?: string;
      danger?: boolean;
      disabled?: boolean;
      checked?: boolean;
      run: () => void;
    }
  | 'sep';

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  align?: 'left' | 'right';
  width?: number;
}

export interface DialogAction {
  label: string;
  kind?: 'primary' | 'danger' | 'ghost';
  run: () => void;
}

export interface DialogState {
  title: string;
  message: string;
  actions: DialogAction[];
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}

const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
let toastId = 0;

export class AppState {
  doc = new Doc();
  grid = new GridState(this.doc);

  theme = $state<Theme>(loadSetting<Theme>('theme', 'system'));
  paletteOpen = $state(false);
  shortcutsOpen = $state(false);
  gotoOpen = $state(false);
  menu = $state.raw<MenuState | null>(null);
  dialog = $state.raw<DialogState | null>(null);
  toasts = $state<Toast[]>([]);
  recent = $state<RecentEntry[]>(loadRecent());
  dragHover = $state(false);
  maximized = $state(false);
  busy = $state<string | null>(null);

  query = $state('');
  replaceWith = $state('');
  matchCase = $state(false);
  filterRows = $state(false);
  searchOpen = $state(false);
  replaceOpen = $state(false);

  focusSearch: ((select?: boolean) => void) | null = null;
  focusReplace: (() => void) | null = null;
  commitEdit: (() => void) | null = null;
  autoFit: ((cols: number[] | 'all') => void) | null = null;

  readonly commands: CommandDef[];
  private bindings: { s: Shortcut; cmd: CommandDef }[] = [];
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private preserveView = false;

  constructor() {
    this.grid.mono = loadSetting('mono', false);
    this.grid.zoom = loadSetting('zoom', 1);
    this.commands = this.buildCommands();
    for (const cmd of this.commands) {
      if (cmd.nativeKey) continue;
      for (const s of [cmd.shortcut, ...(cmd.altShortcuts ?? [])]) {
        if (s) this.bindings.push({ s: parseShortcut(s), cmd });
      }
    }
    this.doc.onColumnChange((change) => {
      const widths = this.grid.widths;
      if (widths.length === 0) return;
      if (change.kind === 'remove') {
        this.grid.widths = widths.filter((_, i) => !change.at.includes(i));
        return;
      }
      const next = [...widths];
      for (const i of change.at) next.splice(i, 0, DEFAULT_COL_WIDTH);
      this.grid.widths = next;
      if (change.restored) queueMicrotask(() => this.autoFit?.(change.at));
    });
    this.doc.onChange((kind) => {
      this.grid.ensureValid();
      if (kind === 'load') {
        this.grid.matchIndex = -1;
        this.runSearch(false);
      } else if (this.query || this.filterRows) {
        const keep = kind === 'cell' || this.preserveView;
        if (kind === 'cell') this.scheduleSearch(keep, 180);
        else this.runSearch(keep);
      }
    });
  }

  // ---------- startup ----------

  async init(): Promise<void> {
    const files = await launchFiles();
    if (files.length > 0) await this.openPath(files[0]);
  }

  // ---------- toasts, dialogs, menus ----------

  toast(text: string, kind: Toast['kind'] = 'info', ms = 2200): void {
    const id = ++toastId;
    this.toasts.push({ id, text, kind });
    while (this.toasts.length > 3) this.toasts.shift();
    setTimeout(() => {
      const i = this.toasts.findIndex((t) => t.id === id);
      if (i >= 0) this.toasts.splice(i, 1);
    }, ms);
  }

  openMenu(state: MenuState): void {
    this.menu = state;
  }

  closeMenu(): void {
    this.menu = null;
  }

  closeOverlays(): boolean {
    let closed = false;
    if (this.menu) {
      this.menu = null;
      closed = true;
    }
    if (this.paletteOpen) {
      this.paletteOpen = false;
      closed = true;
    }
    if (this.shortcutsOpen) {
      this.shortcutsOpen = false;
      closed = true;
    }
    if (this.gotoOpen) {
      this.gotoOpen = false;
      closed = true;
    }
    return closed;
  }

  confirmDiscard(): Promise<boolean> {
    if (!this.doc.dirty) return Promise.resolve(true);
    return new Promise((resolve) => {
      const close = (v: boolean) => {
        this.dialog = null;
        resolve(v);
      };
      this.dialog = {
        title: `Save changes to ${this.doc.name}?`,
        message: 'Your edits will be lost if you don’t save them.',
        actions: [
          { label: 'Don’t save', kind: 'ghost', run: () => close(true) },
          { label: 'Cancel', run: () => close(false) },
          {
            label: 'Save',
            kind: 'primary',
            run: async () => {
              const ok = await this.save(false);
              close(ok);
            },
          },
        ],
      };
    });
  }

  // ---------- files ----------

  async open(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    const file = await pickFile();
    if (file) await this.loadFile(file);
  }

  async openPath(path: string, confirm = true): Promise<void> {
    if (confirm && !(await this.confirmDiscard())) return;
    try {
      const file = await readPath(path);
      await this.loadFile(file);
    } catch (e) {
      this.recent = removeRecent(path);
      this.toast(`Couldn’t open ${path.split('/').pop()}: ${String(e)}`, 'error', 4000);
    }
  }

  async loadFile(file: OpenedFile): Promise<void> {
    this.commitEdit?.();
    this.busy = `Opening ${file.name}`;
    await nextFrame();
    try {
      const { text, encoding } = decodeBytes(file.bytes);
      this.resetFind();
      this.doc.loadText(text, { name: file.name, path: file.path, encoding });
      this.grid.widths = [];
      this.grid.editing = null;
      this.grid.select(0, 0, false);
      if (file.path) this.recent = pushRecent(file.path, file.name);
      if (this.doc.ragged) this.toast('Some rows were shorter than others. They were padded with empty cells.', 'info', 3600);
    } catch (e) {
      this.toast(`Couldn’t read ${file.name}: ${String(e)}`, 'error', 4000);
    } finally {
      this.busy = null;
    }
    this.grid.focusGrid?.();
  }

  async newSheet(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.commitEdit?.();
    this.resetFind();
    this.doc.newSheet();
    this.grid.widths = [];
    this.grid.editing = null;
    this.grid.select(0, 0, false);
    this.grid.focusGrid?.();
  }

  async save(forcePrompt: boolean): Promise<boolean> {
    if (!this.doc.loaded) return false;
    this.commitEdit?.();
    const name = /\.[a-z0-9]{1,5}$/i.test(this.doc.name) ? this.doc.name : `${this.doc.name}.csv`;
    try {
      const savePoint = this.doc.savePoint();
      const result = await saveText(this.doc.toText(), name, this.doc.path, forcePrompt);
      if (!result) return false;
      this.doc.markSaved(result.path, result.name, savePoint);
      if (result.path) this.recent = pushRecent(result.path, result.name);
      this.toast(`Saved ${result.name}`, 'success');
      return true;
    } catch (e) {
      this.toast(`Couldn’t save: ${String(e)}`, 'error', 4000);
      return false;
    }
  }

  async closeFile(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.commitEdit?.();
    this.doc.close();
    this.clearFind();
  }

  async quit(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    if (isTauri) await win.destroy();
  }

  async handleDrop(paths: string[]): Promise<void> {
    const path = paths.find((p) => /\.(csv|tsv|txt|tab|psv|dat)$/i.test(p)) ?? paths[0];
    if (path) await this.openPath(path);
  }

  async handleBrowserDrop(files: FileList): Promise<void> {
    const f = files[0];
    if (!f) return;
    if (!(await this.confirmDiscard())) return;
    await this.loadFile({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) });
  }

  // ---------- editing ----------

  undo(): void {
    this.commitEdit?.();
    const label = this.doc.undo();
    if (label) this.toast(`Undid: ${label}`);
  }

  redo(): void {
    this.commitEdit?.();
    const label = this.doc.redo();
    if (label) this.toast(`Redid: ${label}`);
  }

  /** False when there is nothing to select: no file, no rows, or a filter that matches none. */
  get hasCells(): boolean {
    return this.doc.loaded && this.grid.rowCount > 0 && this.grid.colCount > 0;
  }

  /** Iterates the selection in data coordinates. */
  private selectionEdits(value: (r: number, c: number) => string): CellEdit[] {
    const edits: CellEdit[] = [];
    if (!this.hasCells) return edits;
    const { r0, c0, r1, c1 } = this.grid.range;
    for (let vr = r0; vr <= r1; vr++) {
      const r = this.grid.dataRow(vr);
      for (let c = c0; c <= c1; c++) edits.push({ r, c, value: value(r, c) });
    }
    return edits;
  }

  selectionText(): string {
    if (!this.hasCells) return '';
    const { r0, c0, r1, c1 } = this.grid.range;
    const rows: string[][] = [];
    for (let vr = r0; vr <= r1; vr++) {
      const r = this.grid.dataRow(vr);
      rows.push(this.doc.rows[r].slice(c0, c1 + 1));
    }
    if (rows.length === 1 && rows[0].length === 1) return rows[0][0];
    return serializeCsv(rows, '\t', '\n');
  }

  async copy(): Promise<void> {
    if (!this.hasCells) return;
    this.commitEdit?.();
    await clipboard.writeText(this.selectionText());
    this.toastCells('Copied');
  }

  async cut(): Promise<void> {
    if (!this.hasCells) return;
    this.commitEdit?.();
    await clipboard.writeText(this.selectionText());
    this.doc.setCells(this.selectionEdits(() => ''), 'Cut');
    this.toastCells('Cut');
  }

  async paste(): Promise<void> {
    if (!this.doc.loaded) return;
    const text = await clipboard.readText();
    this.pasteText(text);
  }

  pasteText(text: string): void {
    if (!this.doc.loaded || !text) return;
    this.commitEdit?.();
    const block = parseClipboardBlock(text);
    const g = this.grid;
    const { r0, c0, r1, c1 } = g.range;
    const single = block.length === 1 && block[0].length === 1;
    if (single && !g.isSingle) {
      const v = block[0][0];
      this.doc.setCells(this.selectionEdits(() => v), 'Paste');
      this.toast(`Pasted into ${(r1 - r0 + 1) * (c1 - c0 + 1)} cells`);
      return;
    }
    if (g.viewRows) {
      const edits: CellEdit[] = [];
      for (let i = 0; i < block.length && r0 + i < g.rowCount; i++) {
        const r = g.dataRow(r0 + i);
        for (let j = 0; j < block[i].length && c0 + j < this.doc.colCount; j++) {
          edits.push({ r, c: c0 + j, value: block[i][j] });
        }
      }
      this.doc.setCells(edits, 'Paste');
    } else {
      this.doc.applyBlock(r0, c0, block, 'Paste');
    }
    const cols = block.reduce((m, r) => Math.max(m, r.length), 0);
    g.anchor = { r: r0, c: c0 };
    g.extendTo(r0 + block.length - 1, c0 + cols - 1, false);
    if (block.length > 1 || cols > 1) this.toast(`Pasted ${block.length} × ${cols}`);
  }

  clearSelection(): void {
    if (!this.doc.loaded) return;
    this.doc.setCells(this.selectionEdits(() => ''), 'Clear cells');
  }

  fillDown(): void {
    const { r0, c0, r1, c1 } = this.grid.range;
    if (!this.hasCells || r1 === r0) return;
    const top: Record<number, string> = {};
    for (let c = c0; c <= c1; c++) top[c] = this.doc.cell(this.grid.dataRow(r0), c);
    this.doc.setCells(
      this.selectionEdits((_, c) => top[c]).filter((e) => e.r !== this.grid.dataRow(r0)),
      'Fill down',
    );
  }

  private toastCells(verb: string): void {
    const { r0, c0, r1, c1 } = this.grid.range;
    const n = (r1 - r0 + 1) * (c1 - c0 + 1);
    if (n > 1) this.toast(`${verb} ${n} cells`);
  }

  // ---------- rows & columns ----------

  insertRows(where: 'above' | 'below'): void {
    if (!this.doc.loaded) return;
    this.commitEdit?.();
    const g = this.grid;
    const { r0, r1 } = g.range;
    const count = r1 - r0 + 1;
    const empty = g.rowCount === 0;
    const at = empty ? this.doc.rowCount : where === 'above' ? g.dataRow(r0) : g.dataRow(r1) + 1;
    const viewAt = empty ? 0 : where === 'above' ? r0 : r1 + 1;
    this.withPreservedView(() => {
      this.doc.insertRows(at, empty ? 1 : count);
      if (g.viewRows) {
        const n = empty ? 1 : count;
        const shifted = g.viewRows.map((d) => (d >= at ? d + n : d));
        const fresh = Array.from({ length: n }, (_, i) => at + i);
        shifted.splice(viewAt, 0, ...fresh);
        g.viewRows = shifted;
      }
    });
    g.select(viewAt, g.anchor.c);
  }

  deleteRows(): void {
    if (!this.hasCells) return;
    this.commitEdit?.();
    const g = this.grid;
    const indices = g.selectedRowIndices;
    const { r0 } = g.range;
    const col = g.anchor.c;
    this.withPreservedView(() => {
      this.doc.deleteRows(indices);
      if (g.viewRows) {
        const gone = new Set(indices);
        const sorted = [...indices].sort((a, b) => a - b);
        g.viewRows = g.viewRows
          .filter((d) => !gone.has(d))
          .map((d) => {
            let lo = 0;
            let hi = sorted.length;
            while (lo < hi) {
              const mid = (lo + hi) >> 1;
              if (sorted[mid] < d) lo = mid + 1;
              else hi = mid;
            }
            return d - lo;
          });
      }
    });
    g.select(r0, col);
    this.toast(indices.length === 1 ? 'Deleted row' : `Deleted ${indices.length} rows`);
  }

  insertColumn(where: 'left' | 'right'): void {
    if (!this.doc.loaded) return;
    this.commitEdit?.();
    const g = this.grid;
    const { c0, c1 } = g.range;
    const at = where === 'left' ? c0 : c1 + 1;
    this.doc.insertColumn(at);
    g.select(g.anchor.r, at);
  }

  deleteColumns(): void {
    if (!this.doc.loaded) return;
    this.commitEdit?.();
    const g = this.grid;
    const cols = g.selectedColIndices;
    if (cols.length >= this.doc.colCount) {
      this.toast('A sheet needs at least one column', 'error');
      return;
    }
    const { c0 } = g.range;
    this.doc.deleteColumns(cols);
    g.select(g.anchor.r, c0);
    this.toast(cols.length === 1 ? 'Deleted column' : `Deleted ${cols.length} columns`);
  }

  sort(dir: 'asc' | 'desc'): void {
    if (!this.doc.loaded || this.doc.rowCount < 2) return;
    this.commitEdit?.();
    const c = this.grid.anchor.c;
    this.doc.sortBy(c, dir);
    this.toast(`Sorted by ${this.doc.columnLabel(c)}, ${dir === 'asc' ? 'ascending' : 'descending'}`);
  }

  toggleHeader(): void {
    if (!this.doc.loaded) return;
    this.commitEdit?.();
    this.doc.setHasHeader(!this.doc.hasHeader);
    this.grid.select(this.grid.anchor.r, this.grid.anchor.c);
  }

  setDelimiter(d: string): void {
    if (!this.doc.loaded || d === this.doc.delimiter) return;
    this.commitEdit?.();
    if (this.doc.reparse(d)) {
      this.grid.widths = [];
      this.grid.select(0, 0, false);
      this.toast(`Reading with ${delimiterLabel(d).toLowerCase()} delimiter`);
    } else {
      this.doc.delimiter = d;
      this.toast(`Will save with ${delimiterLabel(d).toLowerCase()} delimiter`);
    }
  }

  private withPreservedView(fn: () => void): void {
    this.preserveView = true;
    try {
      fn();
    } finally {
      this.preserveView = false;
    }
  }

  // ---------- search ----------

  scheduleSearch(keepView: boolean, ms: number): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.runSearch(keepView), ms);
  }

  runSearch(keepView: boolean): void {
    clearTimeout(this.searchTimer);
    this.searchTimer = undefined;
    const g = this.grid;
    const q = this.query;
    if (!q) {
      g.matches = [];
      g.matchSet = new Set();
      g.matchIndex = -1;
      g.viewRows = null;
      g.ensureValid();
      return;
    }
    const needle = this.matchCase ? q : q.toLowerCase();
    const rows = this.doc.rows;
    const cols = this.doc.colCount;
    const matches: Pos[] = [];
    const set = new Set<number>();
    const rowList: number[] = [];
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      let hit = false;
      for (let c = 0; c < cols; c++) {
        const v = row[c];
        if (!v) continue;
        const s = this.matchCase ? v : v.toLowerCase();
        if (s.includes(needle)) {
          matches.push({ r, c });
          set.add(cellKey(r, c));
          hit = true;
        }
      }
      if (hit) rowList.push(r);
    }
    g.matches = matches;
    g.matchSet = set;
    if (this.filterRows) {
      if (!keepView || !g.viewRows) g.viewRows = rowList;
    } else {
      g.viewRows = null;
    }
    if (g.matchIndex >= matches.length) g.matchIndex = matches.length > 0 ? 0 : -1;
    g.ensureValid();
  }

  setQuery(q: string): void {
    this.query = q;
    this.grid.matchIndex = -1;
    this.scheduleSearch(false, 120);
  }

  toggleFilterRows(): void {
    this.filterRows = !this.filterRows;
    this.runSearch(false);
    if (this.filterRows && this.grid.viewRows) this.grid.select(0, this.grid.anchor.c);
  }

  toggleMatchCase(): void {
    this.matchCase = !this.matchCase;
    this.runSearch(false);
  }

  openFind(replace = false): void {
    if (!this.doc.loaded) return;
    this.searchOpen = true;
    if (replace) this.replaceOpen = true;
    if (this.grid.isSingle && !this.query) {
      const v = this.doc.cell(this.grid.dataRow(this.grid.anchor.r), this.grid.anchor.c);
      if (v && v.length < 80 && !v.includes('\n')) this.setQuery(v);
    }
    if (replace && this.query) this.focusReplace?.();
    else this.focusSearch?.(true);
  }

  closeFind(): void {
    this.searchOpen = false;
    this.replaceOpen = false;
    this.grid.focusGrid?.();
  }

  clearFind(): void {
    this.resetFind();
    this.runSearch(false);
  }

  /** Drops the query and filter; the search itself reruns when the next document loads. */
  private resetFind(): void {
    this.query = '';
    this.filterRows = false;
    this.grid.matchIndex = -1;
  }

  stepMatch(dir: 1 | -1): void {
    const g = this.grid;
    if (this.searchTimer !== undefined) this.runSearch(false);
    const n = g.matches.length;
    if (n === 0) return;
    let i = g.matchIndex;
    if (i < 0) {
      i = this.nearestMatch(dir);
    } else {
      i = (i + dir + n) % n;
    }
    this.goToMatch(i);
  }

  private nearestMatch(dir: 1 | -1): number {
    const g = this.grid;
    const a = { r: g.dataRow(g.anchor.r), c: g.anchor.c };
    const m = g.matches;
    for (let i = 0; i < m.length; i++) {
      const p = m[i];
      if (p.r > a.r || (p.r === a.r && p.c >= a.c)) return dir === 1 ? i : (i - 1 + m.length) % m.length;
    }
    return dir === 1 ? 0 : m.length - 1;
  }

  goToMatch(i: number): void {
    const g = this.grid;
    const p = g.matches[i];
    if (!p) return;
    g.matchIndex = i;
    const vr = g.viewRow(p.r);
    if (vr >= 0) g.select(vr, p.c);
  }

  replaceCurrent(): void {
    const g = this.grid;
    if (g.matches.length === 0) return;
    let i = g.matchIndex;
    if (i < 0) {
      this.goToMatch(this.nearestMatch(1));
      return;
    }
    const p = g.matches[i];
    const v = this.doc.cell(p.r, p.c);
    this.doc.setCell(p.r, p.c, this.replaceIn(v));
    this.runSearch(true);
    if (g.matches.length === 0) return;
    const same = g.matches[i];
    if (same && same.r === p.r && same.c === p.c) i++;
    this.goToMatch(i % g.matches.length);
  }

  replaceAll(): void {
    const g = this.grid;
    if (g.matches.length === 0) return;
    const edits = g.matches.map((p) => ({ r: p.r, c: p.c, value: this.replaceIn(this.doc.cell(p.r, p.c)) }));
    const n = edits.length;
    this.doc.setCells(edits, 'Replace all');
    this.runSearch(true);
    this.toast(`Replaced ${n} ${n === 1 ? 'cell' : 'cells'}`, 'success');
  }

  private replaceIn(value: string): string {
    if (this.matchCase) return value.replaceAll(this.query, () => this.replaceWith);
    const re = new RegExp(this.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return value.replace(re, () => this.replaceWith);
  }

  gotoRow(n: number): void {
    const g = this.grid;
    const vr = g.viewRows ? g.viewRow(n - 1) : n - 1;
    if (vr < 0) {
      this.toast(`Row ${n} is hidden by the filter`);
      return;
    }
    g.select(vr, g.anchor.c);
  }

  // ---------- view ----------

  setTheme(t: Theme): void {
    this.theme = t;
    saveSetting('theme', t);
  }

  toggleMono(): void {
    this.grid.mono = !this.grid.mono;
    saveSetting('mono', this.grid.mono);
    this.grid.widths = [];
  }

  setZoom(z: number): void {
    this.grid.zoom = Math.round(Math.min(1.6, Math.max(0.7, z)) * 100) / 100;
    saveSetting('zoom', this.grid.zoom);
  }

  // ---------- keyboard ----------

  handleKeydown(e: KeyboardEvent): boolean {
    const editable = isEditableTarget(e.target);
    for (const { s, cmd } of this.bindings) {
      if (!eventMatches(e, s)) continue;
      if (editable && !cmd.global) continue;
      if (cmd.when && !cmd.when()) continue;
      e.preventDefault();
      void cmd.run();
      return true;
    }
    return false;
  }

  title(cmd: CommandDef): string {
    return typeof cmd.title === 'function' ? cmd.title() : cmd.title;
  }

  private buildCommands(): CommandDef[] {
    const loaded = () => this.doc.loaded;
    const hasRows = () => this.hasCells;
    return [
      { id: 'file.new', title: 'New sheet', group: 'File', shortcut: 'Ctrl+N', global: true, run: () => this.newSheet() },
      { id: 'file.open', title: 'Open file…', group: 'File', shortcut: 'Ctrl+O', global: true, run: () => this.open() },
      { id: 'file.save', title: 'Save', group: 'File', shortcut: 'Ctrl+S', global: true, when: loaded, run: () => this.save(false) },
      { id: 'file.saveAs', title: 'Save as…', group: 'File', shortcut: 'Ctrl+Shift+S', global: true, when: loaded, run: () => this.save(true) },
      { id: 'file.close', title: 'Close file', group: 'File', shortcut: 'Ctrl+W', global: true, when: loaded, run: () => this.closeFile() },
      ...(isTauri ? [{ id: 'file.quit', title: 'Quit', group: 'File' as Group, shortcut: 'Ctrl+Q', global: true, run: () => this.quit() }] : []),

      { id: 'edit.undo', title: 'Undo', group: 'Edit', shortcut: 'Ctrl+Z', when: () => this.doc.canUndo, run: () => this.undo() },
      { id: 'edit.redo', title: 'Redo', group: 'Edit', shortcut: 'Ctrl+Shift+Z', altShortcuts: ['Ctrl+Y'], when: () => this.doc.canRedo, run: () => this.redo() },
      { id: 'edit.cut', title: 'Cut', group: 'Edit', shortcut: 'Ctrl+X', nativeKey: true, when: hasRows, run: () => this.cut() },
      { id: 'edit.copy', title: 'Copy', group: 'Edit', shortcut: 'Ctrl+C', nativeKey: true, when: hasRows, run: () => this.copy() },
      { id: 'edit.paste', title: 'Paste', group: 'Edit', shortcut: 'Ctrl+V', nativeKey: true, when: loaded, run: () => this.paste() },
      { id: 'edit.clear', title: 'Clear cells', group: 'Edit', shortcut: 'Delete', altShortcuts: ['Backspace'], when: hasRows, run: () => this.clearSelection() },
      { id: 'edit.fillDown', title: 'Fill down', group: 'Edit', shortcut: 'Ctrl+D', when: hasRows, run: () => this.fillDown() },
      { id: 'edit.selectAll', title: 'Select all', group: 'Edit', shortcut: 'Ctrl+A', when: hasRows, run: () => this.grid.selectAll() },

      { id: 'rows.insertBelow', title: 'Insert row below', group: 'Rows', shortcut: 'Ctrl+Enter', when: loaded, run: () => this.insertRows('below') },
      { id: 'rows.insertAbove', title: 'Insert row above', group: 'Rows', shortcut: 'Ctrl+Shift+Enter', when: loaded, run: () => this.insertRows('above') },
      { id: 'rows.delete', title: () => (this.grid.range.r1 > this.grid.range.r0 ? 'Delete selected rows' : 'Delete row'), group: 'Rows', shortcut: 'Ctrl+Shift+K', when: hasRows, run: () => this.deleteRows() },
      { id: 'rows.goto', title: 'Go to row…', group: 'Rows', shortcut: 'Ctrl+G', global: true, when: hasRows, run: () => (this.gotoOpen = true) },

      { id: 'cols.insertRight', title: 'Insert column to the right', group: 'Columns', when: loaded, run: () => this.insertColumn('right') },
      { id: 'cols.insertLeft', title: 'Insert column to the left', group: 'Columns', when: loaded, run: () => this.insertColumn('left') },
      { id: 'cols.delete', title: () => (this.grid.range.c1 > this.grid.range.c0 ? 'Delete selected columns' : 'Delete column'), group: 'Columns', when: loaded, run: () => this.deleteColumns() },
      { id: 'cols.rename', title: 'Rename column', group: 'Columns', when: () => this.doc.loaded && this.doc.hasHeader, run: () => (this.grid.editingHeader = this.grid.anchor.c) },
      { id: 'cols.sortAsc', title: 'Sort ascending', group: 'Columns', when: hasRows, run: () => this.sort('asc') },
      { id: 'cols.sortDesc', title: 'Sort descending', group: 'Columns', when: hasRows, run: () => this.sort('desc') },
      { id: 'cols.fit', title: 'Fit column widths to content', group: 'Columns', when: loaded, run: () => this.autoFit?.('all') },
      { id: 'cols.header', title: () => (this.doc.hasHeader ? 'Treat header row as data' : 'Use first row as header'), group: 'Columns', when: loaded, run: () => this.toggleHeader() },

      { id: 'find.find', title: 'Find', group: 'Find', shortcut: 'Ctrl+F', global: true, when: loaded, run: () => this.openFind(false) },
      { id: 'find.replace', title: 'Find and replace', group: 'Find', shortcut: 'Ctrl+H', global: true, when: loaded, run: () => this.openFind(true) },
      { id: 'find.next', title: 'Next match', group: 'Find', shortcut: 'F3', global: true, when: () => this.grid.matches.length > 0, run: () => this.stepMatch(1) },
      { id: 'find.prev', title: 'Previous match', group: 'Find', shortcut: 'Shift+F3', global: true, when: () => this.grid.matches.length > 0, run: () => this.stepMatch(-1) },
      { id: 'find.filter', title: () => (this.filterRows ? 'Show all rows' : 'Show only matching rows'), group: 'Find', when: () => this.doc.loaded && this.query.length > 0, run: () => this.toggleFilterRows() },

      ...DELIMITERS.map((d) => ({
        id: `view.delim.${d.label}`,
        title: `Delimiter: ${d.label.toLowerCase()}`,
        group: 'View' as Group,
        when: () => this.doc.loaded && this.doc.delimiter !== d.char,
        run: () => this.setDelimiter(d.char),
      })),
      { id: 'view.mono', title: () => (this.grid.mono ? 'Use proportional cell font' : 'Use monospace cell font'), group: 'View', run: () => this.toggleMono() },
      { id: 'view.zoomIn', title: 'Zoom in', group: 'View', shortcut: 'Ctrl+=', global: true, run: () => this.setZoom(this.grid.zoom + 0.1) },
      { id: 'view.zoomOut', title: 'Zoom out', group: 'View', shortcut: 'Ctrl+-', global: true, run: () => this.setZoom(this.grid.zoom - 0.1) },
      { id: 'view.zoomReset', title: 'Reset zoom', group: 'View', shortcut: 'Ctrl+0', global: true, when: () => this.grid.zoom !== 1, run: () => this.setZoom(1) },
      { id: 'view.themeSystem', title: 'Theme: match system', group: 'View', when: () => this.theme !== 'system', run: () => this.setTheme('system') },
      { id: 'view.themeLight', title: 'Theme: light', group: 'View', when: () => this.theme !== 'light', run: () => this.setTheme('light') },
      { id: 'view.themeDark', title: 'Theme: dark', group: 'View', when: () => this.theme !== 'dark', run: () => this.setTheme('dark') },

      { id: 'help.palette', title: 'Command palette', group: 'Help', shortcut: 'Ctrl+K', altShortcuts: ['Ctrl+Shift+P'], global: true, run: () => (this.paletteOpen = !this.paletteOpen) },
      { id: 'help.shortcuts', title: 'Keyboard shortcuts', group: 'Help', shortcut: 'Ctrl+/', global: true, run: () => (this.shortcutsOpen = true) },
    ];
  }
}

export const app = new AppState();
