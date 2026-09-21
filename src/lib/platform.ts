import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readText as clipRead, writeText as clipWrite, writeHtml as clipWriteHtml } from '@tauri-apps/plugin-clipboard-manager';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Size and modification time, used to notice when a file changes behind the app's back. */
export interface FileStamp {
  size: number;
  modified: number | null;
}

export interface OpenedFile {
  name: string;
  path: string | null;
  bytes: Uint8Array;
  stamp?: FileStamp | null;
}

export interface SavedFile {
  name: string;
  path: string | null;
  stamp?: FileStamp | null;
}

/** Null when the file doesn't exist or there is no file system to ask. */
export async function fileStamp(path: string): Promise<FileStamp | null> {
  if (!isTauri) return null;
  try {
    const { size, modified } = await invoke<FileStamp>('file_info', { path });
    return { size, modified };
  } catch {
    return null;
  }
}

export function sameStamp(a: FileStamp | null, b: FileStamp | null): boolean {
  return a === b || (a !== null && b !== null && a.size === b.size && a.modified === b.modified);
}

const FILTERS = [
  { name: 'Delimited text', extensions: ['csv', 'tsv', 'txt', 'tab', 'psv', 'dat'] },
  { name: 'All files', extensions: ['*'] },
];

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export async function readPath(path: string): Promise<OpenedFile> {
  const stamp = await fileStamp(path);
  const buf = await invoke<ArrayBuffer>('read_file', { path });
  return { name: baseName(path), path, bytes: new Uint8Array(buf), stamp };
}

export async function pickFile(): Promise<OpenedFile | null> {
  if (isTauri) {
    const chosen = await openDialog({ multiple: false, directory: false, filters: FILTERS });
    if (!chosen) return null;
    return readPath(chosen);
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.tsv,.txt,.tab,.psv,.dat,text/csv';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ name: file.name, path: null, bytes: new Uint8Array(await file.arrayBuffer()) });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function writePath(path: string, bytes: Uint8Array): Promise<SavedFile> {
  const { size, modified } = await invoke<FileStamp>('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
  return { name: baseName(path), path, stamp: { size, modified } };
}

export async function pickSavePath(defaultName: string, currentPath: string | null): Promise<string | null> {
  const chosen = await saveDialog({
    defaultPath: currentPath ?? defaultName,
    filters: FILTERS,
  });
  return chosen ?? null;
}

async function browserSave(defaultName: string, bytes: Uint8Array): Promise<SavedFile | null> {
  const data = new Blob([bytes as BlobPart], { type: 'text/csv' });
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }>; name: string }>;
  };
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description: 'CSV', accept: { 'text/csv': ['.csv', '.tsv', '.txt'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      return { name: handle.name, path: null };
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      throw e;
    }
  }
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { name: defaultName, path: null };
}

/** Saves to `path` if given, otherwise prompts. Returns null when cancelled. */
export async function saveBytes(bytes: Uint8Array, defaultName: string, path: string | null, forcePrompt: boolean): Promise<SavedFile | null> {
  if (!isTauri) return browserSave(defaultName, bytes);
  let target = path;
  if (!target || forcePrompt) {
    target = await pickSavePath(defaultName, path);
    if (!target) return null;
  }
  return writePath(target, bytes);
}

export async function launchFiles(): Promise<string[]> {
  if (!isTauri) return [];
  try {
    return await invoke<string[]>('launch_files');
  } catch {
    return [];
  }
}

/** Unsaved work written aside so it can be offered back after a crash. */
export interface RecoverySnapshot {
  name: string;
  path: string | null;
  encoding: string;
  delimiter: string;
  hasHeader: boolean;
  savedAt: number;
  text: string;
}

export const recovery = {
  async save(id: string, snapshot: RecoverySnapshot): Promise<void> {
    if (!isTauri) return;
    const body = new TextEncoder().encode(JSON.stringify(snapshot));
    await invoke('recovery_save', body, { headers: { 'x-id': id } });
  },
  async clear(id: string): Promise<void> {
    if (!isTauri) return;
    await invoke('recovery_clear', { id });
  },
  /** Snapshots left behind by instances that are no longer running. */
  async pending(): Promise<{ id: string; snapshot: RecoverySnapshot }[]> {
    if (!isTauri) return [];
    const entries = await invoke<{ id: string; data: string }[]>('recovery_pending');
    const out: { id: string; snapshot: RecoverySnapshot }[] = [];
    for (const { id, data } of entries) {
      try {
        out.push({ id, snapshot: JSON.parse(data) as RecoverySnapshot });
      } catch {
        void this.clear(id);
      }
    }
    return out;
  },
};

export function onFileDrop(handler: (paths: string[]) => void, onHover: (hovering: boolean) => void): () => void {
  if (!isTauri) return () => {};
  let unlisten: (() => void) | null = null;
  getCurrentWindow()
    .onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === 'enter' || p.type === 'over') onHover(true);
      else if (p.type === 'leave') onHover(false);
      else if (p.type === 'drop') {
        onHover(false);
        handler(p.paths);
      }
    })
    .then((fn) => (unlisten = fn));
  return () => unlisten?.();
}

export const win = {
  minimize: () => getCurrentWindow().minimize(),
  toggleMaximize: () => getCurrentWindow().toggleMaximize(),
  close: () => getCurrentWindow().close(),
  destroy: () => getCurrentWindow().destroy(),
  startDragging: () => getCurrentWindow().startDragging(),
  startResize: (dir: ResizeDirection) => getCurrentWindow().startResizeDragging(dir as never),
  isMaximized: () => getCurrentWindow().isMaximized(),
  setTitle: (t: string) => getCurrentWindow().setTitle(t),
  onResized: (fn: () => void) => getCurrentWindow().onResized(fn),
  onCloseRequested: (fn: (prevent: () => void) => void) =>
    getCurrentWindow().onCloseRequested((e) => fn(() => e.preventDefault())),
};

/** Clipboard contents as plain text, plus HTML for apps that take rich text. */
export interface ClipContents {
  text: string;
  html: string | null;
}

async function browserRead(): Promise<ClipContents> {
  if (typeof navigator.clipboard.read === 'function') {
    try {
      const out: ClipContents = { text: '', html: null };
      for (const item of await navigator.clipboard.read()) {
        if (!out.text && item.types.includes('text/plain')) out.text = await (await item.getType('text/plain')).text();
        if (!out.html && item.types.includes('text/html')) out.html = await (await item.getType('text/html')).text();
      }
      return out;
    } catch {
      /* fall back to text */
    }
  }
  return { text: await navigator.clipboard.readText(), html: null };
}

export const clipboard = {
  async write({ text, html }: ClipContents): Promise<void> {
    if (isTauri) return html ? clipWriteHtml(html, text) : clipWrite(text);
    if (html && typeof ClipboardItem !== 'undefined') {
      try {
        const blob = (data: string, type: string): Blob => new Blob([data], { type });
        await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob(text, 'text/plain'), 'text/html': blob(html, 'text/html') })]);
        return;
      } catch {
        /* fall back to text */
      }
    }
    return navigator.clipboard.writeText(text);
  },
  async read(): Promise<ClipContents> {
    if (!isTauri) return browserRead();
    const [text, html] = await Promise.all([clipRead().catch(() => ''), invoke<string | null>('read_clipboard_html').catch(() => null)]);
    return { text, html };
  },
};

const RECENT_KEY = 'bedsheet.recent';
export interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}

export function loadRecent(): RecentEntry[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

export function pushRecent(path: string, name: string): RecentEntry[] {
  const list = loadRecent().filter((e) => e.path !== path);
  list.unshift({ path, name, openedAt: Date.now() });
  const trimmed = list.slice(0, 8);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage unavailable */
  }
  return trimmed;
}

export function removeRecent(path: string): RecentEntry[] {
  const list = loadRecent().filter((e) => e.path !== path);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
  return list;
}

export function loadSetting<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`bedsheet.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function saveSetting(key: string, value: unknown): void {
  try {
    localStorage.setItem(`bedsheet.${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}
