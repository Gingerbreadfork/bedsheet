import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { readText as clipRead, writeText as clipWrite } from '@tauri-apps/plugin-clipboard-manager';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface OpenedFile {
  name: string;
  path: string | null;
  bytes: Uint8Array;
}

export interface SavedFile {
  name: string;
  path: string | null;
}

const FILTERS = [
  { name: 'Delimited text', extensions: ['csv', 'tsv', 'txt', 'tab', 'psv', 'dat'] },
  { name: 'All files', extensions: ['*'] },
];

function baseName(path: string): string {
  return path.split('/').pop() ?? path;
}

export async function readPath(path: string): Promise<OpenedFile> {
  const buf = await invoke<ArrayBuffer>('read_file', { path });
  return { name: baseName(path), path, bytes: new Uint8Array(buf) };
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

export async function writePath(path: string, text: string): Promise<SavedFile> {
  const bytes = new TextEncoder().encode(text);
  await invoke('write_file', bytes, { headers: { 'x-path': encodeURIComponent(path) } });
  return { name: baseName(path), path };
}

export async function pickSavePath(defaultName: string, currentPath: string | null): Promise<string | null> {
  const chosen = await saveDialog({
    defaultPath: currentPath ?? defaultName,
    filters: FILTERS,
  });
  return chosen ?? null;
}

async function browserSave(defaultName: string, text: string): Promise<SavedFile | null> {
  const w = window as unknown as {
    showSaveFilePicker?: (o: unknown) => Promise<{ createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>; name: string }>;
  };
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: defaultName,
        types: [{ description: 'CSV', accept: { 'text/csv': ['.csv', '.tsv', '.txt'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return { name: handle.name, path: null };
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') return null;
      throw e;
    }
  }
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = defaultName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { name: defaultName, path: null };
}

/** Saves to `path` if given, otherwise prompts. Returns null when cancelled. */
export async function saveText(text: string, defaultName: string, path: string | null, forcePrompt: boolean): Promise<SavedFile | null> {
  if (!isTauri) return browserSave(defaultName, text);
  let target = path;
  if (!target || forcePrompt) {
    target = await pickSavePath(defaultName, path);
    if (!target) return null;
  }
  return writePath(target, text);
}

export async function launchFiles(): Promise<string[]> {
  if (!isTauri) return [];
  try {
    return await invoke<string[]>('launch_files');
  } catch {
    return [];
  }
}

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

export const clipboard = {
  async writeText(text: string): Promise<void> {
    if (isTauri) return clipWrite(text);
    return navigator.clipboard.writeText(text);
  },
  async readText(): Promise<string> {
    if (isTauri) return clipRead();
    return navigator.clipboard.readText();
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
