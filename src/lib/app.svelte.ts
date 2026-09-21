import { Doc } from './document.svelte';
import { GridState, cellKey, DEFAULT_COL_WIDTH, type Pos } from './grid.svelte';
import { serializeCsv, columnLetter, blockWidth, isLettering, DELIMITERS, delimiterLabel } from './csv';
import { readClipboard, toHtmlTable, HTML_MAX_CELLS, type ClipBlock } from './clipboard';
import { looksLikeHeader, clearlyHeader } from './infer';
import { decodeBytes, encodeText, ENCODINGS } from './encoding';
import { parseShortcut, eventMatches, isEditableTarget, type Shortcut } from './keys';
import type { CellEdit } from './document.svelte';
import {
  isTauri,
  pickFile,
  readPath,
  saveBytes,
  launchFiles,
  clipboard,
  win,
  loadRecent,
  pushRecent,
  removeRecent,
  loadSetting,
  saveSetting,
  fileStamp,
  sameStamp,
  recovery,
  type ClipContents,
  type FileStamp,
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

/** A one-line input box. `submit` returns false to reject the value and keep the box open. */
export interface PromptState {
  label: string;
  placeholder?: string;
  initial?: string;
  numeric?: boolean;
  submit: (value: string) => boolean;
}

export interface SearchScope {
  c0: number;
  c1: number;
  r0: number;
  r1: number;
  rows: Set<number> | null;
  label: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}

const LARGE_FILE_BYTES = 256 * 1024 * 1024;
const RECOVERY_IDLE_MS = 5000;

function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Waits for a paint so the busy overlay shows, without hanging when the window isn't being drawn. */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => {
    const fallback = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      clearTimeout(fallback);
      setTimeout(resolve, 0);
    });
  });
let toastId = 0;
const sameText = (a: string, b: string): boolean => a.replaceAll('\r\n', '\n') === b.replaceAll('\r\n', '\n');
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const PASTE_KEY = parseShortcut('Ctrl+V');

export class AppState {
  doc = new Doc();
  grid = new GridState(this.doc);

  theme = $state<Theme>(loadSetting<Theme>('theme', 'system'));
  paletteOpen = $state(false);
  shortcutsOpen = $state(false);
  prompt = $state.raw<PromptState | null>(null);
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
  useRegex = $state(false);
  wholeCell = $state(false);
  /** Limits the search to these columns and document rows. `rows` lists them when they aren't a plain range. */
  scope = $state.raw<SearchScope | null>(null);
  queryError = $state(false);
  filterRows = $state(false);
  searchOpen = $state(false);
  replaceOpen = $state(false);

  focusSearch: ((select?: boolean) => void) | null = null;
  focusReplace: (() => void) | null = null;
  commitEdit: (() => void) | null = null;
  commitHeader: (() => void) | null = null;
  /** Fits columns to their contents. `widen` only ever grows them, and also measures those document rows. */
  autoFit: ((cols: number[] | 'all', widen?: { r0: number; r1: number }) => void) | null = null;

  readonly commands: CommandDef[];
  private bindings: { s: Shortcut; cmd: CommandDef }[] = [];
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private preserveView = false;
  private copied: { text: string; block: ClipBlock } | null = null;
  private sourceBytes: Uint8Array | null = null;
  private diskStamp: FileStamp | null = null;
  private noticedStamp: FileStamp | null = null;
  private recoveryId = Math.random().toString(36).slice(2, 12);
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;

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
      if (change.kind === 'reset') {
        this.grid.widths = [];
        return;
      }
      const widths = this.grid.widths;
      if (widths.length === 0) return;
      if (change.kind === 'move') {
        const moved = [...widths];
        moved.splice(change.to, 0, moved.splice(change.from, 1)[0]);
        this.grid.widths = moved;
        return;
      }
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
      if (kind !== 'load') this.scheduleRecovery();
      this.grid.ensureValid();
      if (kind !== 'cell') {
        this.scope = null;
        this.grid.sortMark = null;
      }
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

  /** Commits a cell or header edit that is still open. */
  commitPending(): void {
    this.commitEdit?.();
    this.commitHeader?.();
  }

  // ---------- startup ----------

  async init(): Promise<void> {
    const files = await launchFiles();
    if (files.length > 0) await this.openPath(files[0]);
    await this.offerRecovery();
  }

  // ---------- crash recovery ----------

  /** Writes unsaved work aside once editing pauses. */
  private scheduleRecovery(): void {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => void this.writeRecovery(), RECOVERY_IDLE_MS);
  }

  private async writeRecovery(): Promise<void> {
    const { doc } = this;
    try {
      if (!doc.loaded || !doc.dirty) return await recovery.clear(this.recoveryId);
      await recovery.save(this.recoveryId, {
        name: doc.name,
        path: doc.path,
        encoding: doc.encoding,
        delimiter: doc.delimiter,
        hasHeader: doc.hasHeader,
        savedAt: Date.now(),
        text: doc.toText(),
      });
    } catch {
      /* recovery is best effort */
    }
  }

  async clearRecovery(): Promise<void> {
    clearTimeout(this.recoveryTimer);
    try {
      await recovery.clear(this.recoveryId);
    } catch {
      /* nothing to clear */
    }
  }

  /** Offers back work from a previous run that ended without saving or discarding it. */
  private async offerRecovery(): Promise<void> {
    let pending: Awaited<ReturnType<typeof recovery.pending>> = [];
    try {
      pending = await recovery.pending();
    } catch {
      return;
    }
    for (const { id, snapshot } of pending) {
      if (this.doc.dirty) return;
      const when = new Date(snapshot.savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
      const recover = await this.choose(`Recover unsaved changes to ${snapshot.name}?`, `Bedsheet closed on ${when} before these edits were saved.`, [
        { label: 'Discard', value: false },
        { label: 'Recover', kind: 'primary', value: true },
      ]);
      if (!recover) {
        await recovery.clear(id).catch(() => {});
        continue;
      }
      this.resetFind();
      this.sourceBytes = null;
      this.recoveryId = id;
      const { name, path, encoding, delimiter, hasHeader, text } = snapshot;
      this.doc.loadText(text, { name, path, encoding, delimiter, hasHeader });
      this.doc.markUnsaved();
      this.diskStamp = this.noticedStamp = path ? await fileStamp(path) : null;
      this.grid.widths = [];
      this.grid.select(0, 0, false);
      this.grid.focusGrid?.();
    }
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
    if (this.prompt) {
      this.prompt = null;
      closed = true;
    }
    return closed;
  }

  /** Shows a dialog and resolves with the value of the button that was chosen. */
  private choose<T>(title: string, message: string, options: { label: string; kind?: DialogAction['kind']; value: T }[]): Promise<T> {
    return new Promise((resolve) => {
      this.dialog = {
        title,
        message,
        actions: options.map((o) => ({
          label: o.label,
          kind: o.kind,
          run: () => {
            this.dialog = null;
            resolve(o.value);
          },
        })),
      };
    });
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
    const size = (await fileStamp(path))?.size ?? 0;
    if (size > LARGE_FILE_BYTES) {
      const open = await this.choose(
        `${path.split('/').pop()} is ${formatSize(size)}`,
        'Opening a file this large can take a while and use several times its size in memory.',
        [
          { label: 'Cancel', kind: 'primary', value: false },
          { label: 'Open anyway', value: true },
        ],
      );
      if (!open) return;
    }
    try {
      const file = await readPath(path);
      await this.loadFile(file);
    } catch (e) {
      if (/os error 2\b/.test(String(e))) this.recent = removeRecent(path);
      this.toast(`Couldn’t open ${path.split('/').pop()}: ${String(e)}`, 'error', 4000);
    }
  }

  async loadFile(file: OpenedFile): Promise<void> {
    this.commitPending();
    this.busy = `Opening ${file.name}`;
    await nextFrame();
    try {
      const { text, encoding } = decodeBytes(file.bytes);
      this.resetFind();
      this.doc.loadText(text, { name: file.name, path: file.path, encoding });
      this.sourceBytes = file.bytes;
      this.diskStamp = this.noticedStamp = file.stamp ?? null;
      void this.clearRecovery();
      this.grid.widths = [];
      this.grid.editing = null;
      this.grid.select(0, 0, false);
      if (file.path) this.recent = pushRecent(file.path, file.name);
      if (!this.doc.hasHeader && this.doc.rowCount > 0) {
        this.toast('The first row looks like data, so the columns are lettered. Use “Header row” if it is a header.', 'info', 5000);
      }
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
    this.commitPending();
    this.resetFind();
    this.sourceBytes = null;
    this.diskStamp = this.noticedStamp = null;
    void this.clearRecovery();
    this.doc.newSheet();
    this.grid.widths = [];
    this.grid.editing = null;
    this.grid.select(0, 0, false);
    this.grid.focusGrid?.();
  }

  async save(forcePrompt: boolean): Promise<boolean> {
    if (!this.doc.loaded) return false;
    this.commitPending();
    const name = /\.[a-z0-9]{1,5}$/i.test(this.doc.name) ? this.doc.name : `${this.doc.name}.csv`;
    if (!forcePrompt && this.doc.path && !(await this.confirmOverwrite(this.doc.path))) return false;
    try {
      const savePoint = this.doc.savePoint();
      const text = this.doc.toText();
      const wanted = this.doc.encoding;
      const bytes = encodeText(text, wanted);
      const result = await saveBytes(bytes ?? encodeText(text, 'UTF-8')!, name, this.doc.path, forcePrompt);
      if (!result) return false;
      this.sourceBytes = null;
      this.diskStamp = this.noticedStamp = result.stamp ?? null;
      this.doc.markSaved(result.path, result.name, savePoint);
      if (this.doc.dirty) this.scheduleRecovery();
      else void this.clearRecovery();
      if (result.path) this.recent = pushRecent(result.path, result.name);
      if (bytes) {
        this.toast(`Saved ${result.name}`, 'success');
      } else {
        this.doc.encoding = 'UTF-8';
        const multi = ENCODINGS.find((e) => e.id === wanted)?.kind === 'multi';
        const why = multi ? `Bedsheet can’t write ${wanted}` : `${wanted} can’t hold every character in it`;
        this.toast(`Saved ${result.name} as UTF-8 because ${why}`, 'info', 6000);
      }
      return true;
    } catch (e) {
      this.toast(`Couldn’t save: ${String(e)}`, 'error', 4000);
      return false;
    }
  }

  private async confirmOverwrite(path: string): Promise<boolean> {
    const now = await fileStamp(path);
    if (!now || !this.diskStamp || sameStamp(now, this.diskStamp)) return true;
    return this.choose(
      `${this.doc.name} has changed on disk`,
      'Something else modified this file after you opened it. Saving will replace those changes with yours.',
      [
        { label: 'Cancel', kind: 'primary', value: false },
        { label: 'Overwrite', kind: 'danger', value: true },
      ],
    );
  }

  /** Called when the window regains focus. Offers to reload a file that another program has changed. */
  async checkDisk(): Promise<void> {
    const path = this.doc.path;
    if (!this.doc.loaded || !path || this.dialog) return;
    const now = await fileStamp(path);
    if (!now || path !== this.doc.path || sameStamp(now, this.noticedStamp)) return;
    this.noticedStamp = now;
    if (this.doc.dirty) {
      this.toast(`${this.doc.name} has changed on disk. Saving will ask before overwriting it.`, 'info', 6000);
      return;
    }
    const reload = await this.choose(`${this.doc.name} has changed on disk`, 'Reload it to see the new contents?', [
      { label: 'Keep this version', value: false },
      { label: 'Reload', kind: 'primary', value: true },
    ]);
    if (reload) await this.openPath(path, false);
  }

  async closeFile(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    this.commitPending();
    this.sourceBytes = null;
    void this.clearRecovery();
    this.doc.close();
    this.clearFind();
  }

  async quit(): Promise<void> {
    if (!(await this.confirmDiscard())) return;
    await this.clearRecovery();
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
    this.commitPending();
    const label = this.doc.undo();
    if (label) this.toast(`Undid: ${label}`);
  }

  redo(): void {
    this.commitPending();
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

  /**
   * The selection as clipboard text, and as an HTML table for documents. The block is remembered
   * so pasting it back keeps every cell intact.
   */
  selectionClip(withHeaders = false): ClipContents {
    if (!this.hasCells) return { text: '', html: null };
    const { r0, c0, r1, c1 } = this.grid.range;
    const rows: string[][] = [];
    if (withHeaders) rows.push(Array.from({ length: c1 - c0 + 1 }, (_, i) => this.doc.columnLabel(c0 + i)));
    for (let vr = r0; vr <= r1; vr++) {
      const r = this.grid.dataRow(vr);
      rows.push(this.doc.rows[r].slice(c0, c1 + 1));
    }
    const cells = rows.length * (c1 - c0 + 1);
    const text = cells === 1 ? rows[0][0] : serializeCsv(rows, '\t', '\n');
    const html = cells === 1 || cells > HTML_MAX_CELLS ? null : toHtmlTable(rows, withHeaders);
    this.copied = { text, block: { rows, header: withHeaders } };
    return { text, html };
  }

  async copy(): Promise<void> {
    if (!this.hasCells) return;
    this.commitPending();
    await clipboard.write(this.selectionClip());
    this.toastCells('Copied');
  }

  async copyWithHeaders(): Promise<void> {
    if (!this.hasCells) return;
    this.commitPending();
    await clipboard.write(this.selectionClip(true));
    this.toast('Copied with headers');
  }

  async cut(): Promise<void> {
    if (!this.hasCells) return;
    this.commitPending();
    await clipboard.write(this.selectionClip());
    this.doc.setCells(this.selectionEdits(() => ''), 'Cut');
    this.toastCells('Cut');
  }

  /** Pastes at the selection, or into a new sheet when no file is open. */
  async paste(): Promise<void> {
    const intoNew = !this.doc.loaded;
    if (intoNew && this.busy) return;
    let contents: ClipContents = { text: '', html: null };
    try {
      contents = await clipboard.read();
    } catch {
      /* empty clipboard, or something that isn't text */
    }
    if (intoNew && (this.doc.loaded || this.busy)) return;
    const pasted = intoNew ? await this.pasteAsNewSheet(contents.text, contents.html) : this.pasteText(contents.text, contents.html);
    if (!pasted) this.toast('Nothing to paste');
  }

  /** Pastes clipboard text, or the table in its HTML, at the selection. False when there is nothing to paste. */
  pasteText(text: string, html: string | null = null): boolean {
    if (!this.doc.loaded) return false;
    const clip = this.clipBlock(text, html);
    if (!clip) return false;
    this.commitPending();
    this.pasteBlock(clip);
    return true;
  }

  async pasteAsNewSheet(text: string, html: string | null = null): Promise<boolean> {
    const clip = this.clipBlock(text, html);
    if (!clip) return false;
    await this.newSheet();
    if (!this.doc.loaded) return false;
    this.pasteBlock(clip);
    return true;
  }

  private clipBlock(text: string, html: string | null): ClipBlock | null {
    const own = text && this.copied && sameText(this.copied.text, text) ? this.copied.block : null;
    if (own) return { rows: own.rows.map((row) => [...row]), header: own.header };
    return readClipboard(text, html);
  }

  private pasteBlock({ rows, header }: ClipBlock): void {
    const g = this.grid;
    const { r0, c0, r1, c1 } = g.range;
    if (g.viewRows && g.rowCount === 0) {
      this.toast('No rows are showing to paste into');
      return;
    }
    let block = rows;
    const single = block.length === 1 && block[0].length === 1;
    if (single && !g.isSingle) {
      const v = block[0][0];
      this.doc.setCells(this.selectionEdits(() => v), 'Paste');
      this.widen(c0, c1, r0, r1);
      this.toast(`Pasted into ${(r1 - r0 + 1) * (c1 - c0 + 1)} cells`);
      return;
    }
    if (!single && !g.viewRows && r0 === 0 && c0 === 0 && this.doc.isBlank()) {
      this.pasteIntoBlank(block, header);
      return;
    }
    const placed = header === true && block.length > 1 ? this.placeHeader(block, c0, !g.viewRows) : null;
    if (placed) block = block.slice(1);
    const names = placed?.names;
    const blockCols = blockWidth(block);
    const selRows = r1 - r0 + 1;
    const selCols = c1 - c0 + 1;
    const tiles = !names && (selRows > block.length || selCols > blockCols) && selRows % block.length === 0 && selCols % blockCols === 0;
    if (tiles) {
      const edits: CellEdit[] = [];
      for (let i = 0; i < selRows; i++) {
        const r = g.dataRow(r0 + i);
        for (let j = 0; j < selCols; j++) edits.push({ r, c: c0 + j, value: block[i % block.length][j % blockCols] ?? '' });
      }
      this.doc.setCells(edits, 'Paste');
      this.widen(c0, c1, r0, r1);
      this.toast(`Pasted into ${selRows} × ${selCols}`);
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
      this.doc.applyBlock(r0, c0, block, 'Paste', names);
    }
    g.anchor = { r: r0, c: c0 };
    g.extendTo(r0 + block.length - 1, c0 + blockCols - 1, false);
    this.widen(c0, c0 + blockCols - 1, r0, r0 + block.length - 1);
    const size = `${block.length} × ${blockCols}`;
    if (names) this.toast(`Pasted ${size}, with its header row as column names`, 'info', 3600);
    else if (placed) this.toast(`Pasted ${size}, leaving out its header row`, 'info', 3600);
    else if (block.length > 1 || blockCols > 1) this.toast(`Pasted ${size}`);
  }

  /**
   * Places a header row the source marked as one. It is left out when it repeats the labels of the
   * columns it lands in or is only Bedsheet's column letters, and if `mayName` it names columns that
   * are new or unused. Returns the names to give them, or null when the row should be pasted as data.
   */
  private placeHeader(block: string[][], c0: number, mayName: boolean): { names?: (string | undefined)[] } | null {
    const doc = this.doc;
    const first = block[0];
    if (isLettering(first)) return {};
    const names: (string | undefined)[] = [];
    let renamed = false;
    for (let j = 0; j < blockWidth(block); j++) {
      const c = c0 + j;
      const name = first[j] ?? '';
      if (c < doc.colCount && sameName(name, doc.columnLabel(c))) {
        names.push(undefined);
      } else if (mayName && doc.hasHeader && (c >= doc.colCount || (doc.hasGeneratedName(c) && doc.isColumnEmpty(c)))) {
        names.push(name === '' ? undefined : name);
        renamed = true;
      } else {
        return null;
      }
    }
    return renamed ? { names } : {};
  }

  /**
   * A blank sheet becomes the pasted table. Its first row becomes the header when the source marked
   * it as one, or when it plainly reads as one; Bedsheet's own column letters are dropped instead.
   */
  private pasteIntoBlank(block: string[][], header: boolean | null): void {
    const width = blockWidth(block);
    const rows = block.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? ''));
    const guessed = header === null && clearlyHeader(rows);
    const lettered = header === true && rows.length > 1 && isLettering(rows[0]);
    if (lettered) rows.shift();
    const named = (header === true && !lettered) || guessed;
    const columns = named ? rows.shift()! : Array.from({ length: width }, (_, c) => columnLetter(c));
    const headerOnly = rows.length === 0;
    if (headerOnly) rows.push(new Array<string>(width).fill(''));
    this.doc.setContents(columns, rows, named, 'Paste');
    this.grid.select(0, 0, false);
    this.grid.extendTo(rows.length - 1, width - 1, false);
    const size = `${rows.length} × ${width}`;
    if (headerOnly) this.toast(`Pasted ${width} column ${width === 1 ? 'name' : 'names'}`);
    else if (guessed) this.toast(`Pasted ${size}. The first row looks like column names, so it is the header. Use “Header row” if it is data.`, 'info', 5000);
    else if (named) this.toast(`Pasted ${size}, with its header row as column names`, 'info', 3600);
    else if (header === null && rows.length > 1 && looksLikeHeader(rows)) this.toast(`Pasted ${size}. Use “Header row” if the first row is column names.`, 'info', 5000);
    else this.toast(`Pasted ${size}`);
  }

  /** Widens the columns a paste landed in so the new values show. Takes view rows. */
  private widen(c0: number, c1: number, vr0: number, vr1: number): void {
    const g = this.grid;
    if (g.rowCount === 0) return;
    const cols = Array.from({ length: c1 - c0 + 1 }, (_, i) => c0 + i);
    this.autoFit?.(cols, { r0: g.dataRow(vr0), r1: g.dataRow(Math.min(vr1, g.rowCount - 1)) });
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

  fillRight(): void {
    const { c0, c1 } = this.grid.range;
    if (!this.hasCells || c1 === c0) return;
    this.doc.setCells(
      this.selectionEdits((r) => this.doc.cell(r, c0)).filter((e) => e.c !== c0),
      'Fill right',
    );
  }

  private toastCells(verb: string): void {
    const { r0, c0, r1, c1 } = this.grid.range;
    const n = (r1 - r0 + 1) * (c1 - c0 + 1);
    if (n > 1) this.toast(`${verb} ${n} cells`);
  }

  // ---------- rows & columns ----------

  duplicateRows(): void {
    if (!this.hasCells) return;
    this.insertRows('below', this.grid.selectedRowIndices.map((r) => this.doc.rows[r]));
  }

  /** Moves the selected rows one place up or down. Not offered while rows are hidden by a filter. */
  moveRows(delta: 1 | -1): void {
    const g = this.grid;
    if (!this.hasCells) return;
    if (g.viewRows) {
      this.toast('Show all rows before moving them');
      return;
    }
    this.commitPending();
    const { r0, r1 } = g.range;
    const { anchor, focus } = g;
    if (!this.doc.shiftRows(r0, r1 - r0 + 1, delta)) return;
    g.anchor = { r: anchor.r + delta, c: anchor.c };
    g.extendTo(focus.r + delta, focus.c);
  }

  moveColumns(delta: 1 | -1): void {
    const g = this.grid;
    if (!this.hasCells) return;
    this.commitPending();
    const { c0, c1 } = g.range;
    const { anchor, focus } = g;
    if (!this.doc.shiftColumns(c0, c1 - c0 + 1, delta)) return;
    g.anchor = { r: anchor.r, c: anchor.c + delta };
    g.extendTo(focus.r, focus.c + delta);
  }

  /** Inserts blank rows next to the selection, as many as are selected, or copies of `data` below it. */
  insertRows(where: 'above' | 'below', data?: string[][]): void {
    if (!this.doc.loaded) return;
    this.commitPending();
    const g = this.grid;
    const { r0, r1 } = g.range;
    const count = data ? data.length : r1 - r0 + 1;
    const empty = g.rowCount === 0;
    const at = empty ? this.doc.rowCount : where === 'above' ? g.dataRow(r0) : g.dataRow(r1) + 1;
    const viewAt = empty ? 0 : where === 'above' ? r0 : r1 + 1;
    this.withPreservedView(() => {
      this.doc.insertRows(at, empty ? 1 : count, empty ? undefined : data);
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
    this.commitPending();
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
    this.commitPending();
    const g = this.grid;
    const { c0, c1 } = g.range;
    const at = where === 'left' ? c0 : c1 + 1;
    this.doc.insertColumn(at);
    g.select(g.anchor.r, at);
  }

  deleteColumns(): void {
    if (!this.doc.loaded) return;
    this.commitPending();
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
    this.commitPending();
    const c = this.grid.anchor.c;
    this.doc.sortBy(c, dir);
    this.grid.sortMark = { c, dir };
    this.toast(`Sorted by ${this.doc.columnLabel(c)}, ${dir === 'asc' ? 'ascending' : 'descending'}`);
  }

  toggleHeader(): void {
    if (!this.doc.loaded) return;
    this.commitPending();
    this.doc.setHasHeader(!this.doc.hasHeader);
    this.grid.select(this.grid.anchor.r, this.grid.anchor.c);
  }

  setDelimiter(d: string): void {
    if (!this.doc.loaded || d === this.doc.delimiter) return;
    this.commitPending();
    if (this.doc.reparse(d)) {
      this.grid.widths = [];
      this.grid.select(0, 0, false);
      this.toast(`Reading with ${delimiterLabel(d).toLowerCase()} delimiter`);
    } else {
      this.doc.setDelimiter(d);
      this.toast(`Will save with ${delimiterLabel(d).toLowerCase()} delimiter`);
    }
  }

  /** True while the file can still be re-read from its original bytes instead of only re-saved. */
  get canReinterpret(): boolean {
    return this.sourceBytes !== null && !this.doc.dirty;
  }

  setEncoding(id: string): void {
    if (!this.doc.loaded || id === this.doc.encoding) return;
    this.commitPending();
    if (this.sourceBytes && !this.doc.dirty) {
      const { text } = decodeBytes(this.sourceBytes, id);
      const { name, path, delimiter } = this.doc;
      this.doc.loadText(text, { name, path, encoding: id, delimiter });
      this.grid.widths = [];
      this.grid.select(0, 0, false);
      this.toast(`Reading as ${id}`);
    } else {
      this.doc.setEncoding(id);
      this.toast(`Will save as ${id}`);
    }
  }

  promptDelimiter(): void {
    const current = this.doc.delimiter;
    this.prompt = {
      label: 'Delimiter',
      placeholder: 'One character, or \\t',
      initial: DELIMITERS.some((d) => d.char === current) ? '' : current,
      submit: (value) => {
        const d = value === '\\t' ? '\t' : value;
        if (d.length !== 1 || d === '"' || d === '\n' || d === '\r') return false;
        this.setDelimiter(d);
        return true;
      },
    };
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
    const test = this.matcher();
    this.queryError = test === null;
    const rows = this.doc.rows;
    const scope = this.scope;
    const c0 = scope ? scope.c0 : 0;
    const c1 = scope ? Math.min(scope.c1, this.doc.colCount - 1) : this.doc.colCount - 1;
    const r0 = scope ? scope.r0 : 0;
    const r1 = scope ? Math.min(scope.r1, rows.length - 1) : rows.length - 1;
    const matches: Pos[] = [];
    const set = new Set<number>();
    const rowList: number[] = [];
    for (let r = r0; test && r <= r1; r++) {
      if (scope?.rows && !scope.rows.has(r)) continue;
      const row = rows[r];
      let hit = false;
      for (let c = c0; c <= c1; c++) {
        if (test(row[c] ?? '')) {
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

  /** Builds the cell test for the current query and options, or null when the pattern is invalid. */
  private matcher(): ((value: string) => boolean) | null {
    const q = this.query;
    if (this.useRegex) {
      try {
        const re = new RegExp(this.wholeCell ? `^(?:${q})$` : q, this.matchCase ? 'u' : 'iu');
        return (v) => re.test(v);
      } catch {
        return null;
      }
    }
    const needle = this.matchCase ? q : q.toLowerCase();
    if (this.wholeCell) return this.matchCase ? (v) => v === needle : (v) => v.toLowerCase() === needle;
    return this.matchCase ? (v) => v.includes(needle) : (v) => v !== '' && v.toLowerCase().includes(needle);
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

  toggleRegex(): void {
    this.useRegex = !this.useRegex;
    this.runSearch(false);
  }

  toggleWholeCell(): void {
    this.wholeCell = !this.wholeCell;
    this.runSearch(false);
  }

  /** Limits the search to the selection, or to the whole column when only one cell is selected. */
  toggleScope(): void {
    const g = this.grid;
    if (this.scope || !this.hasCells) {
      this.scope = null;
    } else {
      const { r0, c0, r1, c1 } = g.range;
      const wholeColumns = g.isSingle || (r0 === 0 && r1 === g.rowCount - 1);
      const names = c0 === c1 ? this.doc.columnLabel(c0) : `${c1 - c0 + 1} columns`;
      if (wholeColumns) {
        this.scope = { c0, c1, r0: 0, r1: Infinity, rows: null, label: names };
      } else {
        const rows = g.viewRows ? new Set(g.selectedRowIndices) : null;
        this.scope = { c0, c1, r0: g.viewRows ? 0 : r0, r1: g.viewRows ? Infinity : r1, rows, label: 'selection' };
      }
    }
    this.grid.matchIndex = -1;
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
    this.scope = null;
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
    if (this.useRegex) {
      const pattern = this.wholeCell ? `^(?:${this.query})$` : this.query;
      return value.replace(new RegExp(pattern, this.matchCase ? 'gu' : 'giu'), this.replaceWith);
    }
    if (this.wholeCell) return this.replaceWith;
    if (this.matchCase) return value.replaceAll(this.query, () => this.replaceWith);
    const re = new RegExp(this.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return value.replace(re, () => this.replaceWith);
  }

  promptGotoRow(): void {
    const max = this.doc.rowCount;
    this.prompt = {
      label: 'Go to row',
      placeholder: `1 – ${max.toLocaleString()}`,
      numeric: true,
      submit: (value) => {
        const n = parseInt(value, 10);
        if (!Number.isFinite(n) || n < 1 || n > max) return false;
        this.gotoRow(n);
        return true;
      },
    };
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
    if (!this.doc.loaded && !this.busy && !editable && eventMatches(e, PASTE_KEY)) {
      e.preventDefault();
      void this.paste();
      return true;
    }
    for (const { s, cmd } of this.bindings) {
      if (!eventMatches(e, s)) continue;
      if (editable && !cmd.global) continue;
      if (cmd.when && !cmd.when()) continue;
      e.preventDefault();
      if (editable) this.commitPending();
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
      { id: 'edit.paste', title: () => (this.doc.loaded ? 'Paste' : 'New sheet from clipboard'), group: 'Edit', shortcut: 'Ctrl+V', nativeKey: true, run: () => this.paste() },
      { id: 'edit.clear', title: 'Clear cells', group: 'Edit', shortcut: 'Delete', altShortcuts: ['Backspace'], when: hasRows, run: () => this.clearSelection() },
      { id: 'edit.fillDown', title: 'Fill down', group: 'Edit', shortcut: 'Ctrl+D', when: hasRows, run: () => this.fillDown() },
      { id: 'edit.fillRight', title: 'Fill right', group: 'Edit', shortcut: 'Ctrl+R', when: hasRows, run: () => this.fillRight() },
      { id: 'edit.copyHeaders', title: 'Copy with headers', group: 'Edit', shortcut: 'Ctrl+Shift+C', when: hasRows, run: () => this.copyWithHeaders() },
      { id: 'edit.selectAll', title: 'Select all', group: 'Edit', shortcut: 'Ctrl+A', when: hasRows, run: () => this.grid.selectAll() },

      { id: 'rows.insertBelow', title: 'Insert row below', group: 'Rows', shortcut: 'Ctrl+Enter', when: loaded, run: () => this.insertRows('below') },
      { id: 'rows.insertAbove', title: 'Insert row above', group: 'Rows', shortcut: 'Ctrl+Shift+Enter', when: loaded, run: () => this.insertRows('above') },
      { id: 'rows.delete', title: () => (this.grid.range.r1 > this.grid.range.r0 ? 'Delete selected rows' : 'Delete row'), group: 'Rows', shortcut: 'Ctrl+Shift+K', when: hasRows, run: () => this.deleteRows() },
      { id: 'rows.duplicate', title: () => (this.grid.range.r1 > this.grid.range.r0 ? 'Duplicate selected rows' : 'Duplicate row'), group: 'Rows', shortcut: 'Ctrl+Shift+D', when: hasRows, run: () => this.duplicateRows() },
      { id: 'rows.moveUp', title: 'Move rows up', group: 'Rows', shortcut: 'Alt+ArrowUp', when: hasRows, run: () => this.moveRows(-1) },
      { id: 'rows.moveDown', title: 'Move rows down', group: 'Rows', shortcut: 'Alt+ArrowDown', when: hasRows, run: () => this.moveRows(1) },
      { id: 'rows.goto', title: 'Go to row…', group: 'Rows', shortcut: 'Ctrl+G', global: true, when: hasRows, run: () => this.promptGotoRow() },

      { id: 'cols.insertRight', title: 'Insert column to the right', group: 'Columns', when: loaded, run: () => this.insertColumn('right') },
      { id: 'cols.insertLeft', title: 'Insert column to the left', group: 'Columns', when: loaded, run: () => this.insertColumn('left') },
      { id: 'cols.delete', title: () => (this.grid.range.c1 > this.grid.range.c0 ? 'Delete selected columns' : 'Delete column'), group: 'Columns', when: loaded, run: () => this.deleteColumns() },
      { id: 'cols.moveLeft', title: 'Move columns left', group: 'Columns', shortcut: 'Alt+ArrowLeft', when: hasRows, run: () => this.moveColumns(-1) },
      { id: 'cols.moveRight', title: 'Move columns right', group: 'Columns', shortcut: 'Alt+ArrowRight', when: hasRows, run: () => this.moveColumns(1) },
      { id: 'cols.rename', title: 'Rename column', group: 'Columns', when: () => this.doc.loaded && this.doc.hasHeader, run: () => (this.grid.editingHeader = this.grid.anchor.c) },
      { id: 'cols.sortAsc', title: 'Sort ascending', group: 'Columns', when: hasRows, run: () => this.sort('asc') },
      { id: 'cols.sortDesc', title: 'Sort descending', group: 'Columns', when: hasRows, run: () => this.sort('desc') },
      { id: 'cols.fit', title: 'Fit column widths to content', group: 'Columns', when: loaded, run: () => this.autoFit?.('all') },
      { id: 'cols.header', title: () => (this.doc.hasHeader ? 'Treat header row as data' : 'Use first row as header'), group: 'Columns', when: loaded, run: () => this.toggleHeader() },

      { id: 'find.find', title: 'Find', group: 'Find', shortcut: 'Ctrl+F', global: true, when: loaded, run: () => this.openFind(false) },
      { id: 'find.replace', title: 'Find and replace', group: 'Find', shortcut: 'Ctrl+H', global: true, when: loaded, run: () => this.openFind(true) },
      { id: 'find.next', title: 'Next match', group: 'Find', shortcut: 'F3', global: true, when: () => this.grid.matches.length > 0, run: () => this.stepMatch(1) },
      { id: 'find.prev', title: 'Previous match', group: 'Find', shortcut: 'Shift+F3', global: true, when: () => this.grid.matches.length > 0, run: () => this.stepMatch(-1) },
      { id: 'find.case', title: () => (this.matchCase ? 'Find: ignore case' : 'Find: match case'), group: 'Find', shortcut: 'Alt+C', global: true, when: () => this.searchOpen, run: () => this.toggleMatchCase() },
      { id: 'find.wholeCell', title: () => (this.wholeCell ? 'Find: match anywhere in a cell' : 'Find: match whole cells only'), group: 'Find', shortcut: 'Alt+W', global: true, when: () => this.searchOpen, run: () => this.toggleWholeCell() },
      { id: 'find.regex', title: () => (this.useRegex ? 'Find: plain text' : 'Find: use a regular expression'), group: 'Find', shortcut: 'Alt+R', global: true, when: () => this.searchOpen, run: () => this.toggleRegex() },
      { id: 'find.scope', title: () => (this.scope ? 'Find: search the whole sheet' : 'Find: search only in the selection'), group: 'Find', shortcut: 'Alt+L', global: true, when: () => this.searchOpen || this.scope !== null, run: () => this.toggleScope() },
      { id: 'find.filter', title: () => (this.filterRows ? 'Show all rows' : 'Show only matching rows'), group: 'Find', when: () => this.doc.loaded && this.query.length > 0, run: () => this.toggleFilterRows() },

      ...DELIMITERS.map((d) => ({
        id: `view.delim.${d.label}`,
        title: `Delimiter: ${d.label.toLowerCase()}`,
        group: 'View' as Group,
        when: () => this.doc.loaded && this.doc.delimiter !== d.char,
        run: () => this.setDelimiter(d.char),
      })),
      { id: 'view.delim.custom', title: 'Delimiter: custom…', group: 'View', when: loaded, run: () => this.promptDelimiter() },
      ...ENCODINGS.map((enc) => ({
        id: `view.encoding.${enc.id}`,
        title: `Encoding: ${enc.id}`,
        group: 'View' as Group,
        when: () => this.doc.loaded && this.doc.encoding !== enc.id && (enc.kind !== 'multi' || this.canReinterpret),
        run: () => this.setEncoding(enc.id),
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
