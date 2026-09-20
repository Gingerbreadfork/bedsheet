export interface Shortcut {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  plus: '+',
  minus: '-',
  space: ' ',
};

export function parseShortcut(combo: string): Shortcut {
  const parts = combo.split('+').map((p) => p.trim());
  const s: Shortcut = { key: '', ctrl: false, shift: false, alt: false };
  for (const raw of parts) {
    const p = raw.toLowerCase();
    if (p === 'ctrl' || p === 'mod') s.ctrl = true;
    else if (p === 'shift') s.shift = true;
    else if (p === 'alt') s.alt = true;
    else s.key = KEY_ALIASES[p] ?? p;
  }
  if (combo.endsWith('++')) s.key = '+';
  return s;
}

export function eventMatches(e: KeyboardEvent, s: Shortcut): boolean {
  if (e.ctrlKey !== s.ctrl || e.altKey !== s.alt) return false;
  const key = e.key.toLowerCase();
  if (s.key === '=' && (key === '+' || key === '=' || e.code === 'Equal')) return true;
  if (e.shiftKey !== s.shift) return false;
  if (key === s.key) return true;
  if (s.key === '-' && e.code === 'Minus') return true;
  return false;
}

const DISPLAY: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  escape: 'Esc',
  backspace: '⌫',
  delete: 'Del',
  ' ': 'Space',
  pageup: 'PgUp',
  pagedown: 'PgDn',
};

/** Returns keycap labels for rendering, e.g. ['Ctrl', 'Shift', 'Z']. */
export function shortcutKeys(combo: string): string[] {
  const s = parseShortcut(combo);
  const keys: string[] = [];
  if (s.ctrl) keys.push('Ctrl');
  if (s.alt) keys.push('Alt');
  if (s.shift) keys.push('Shift');
  const k = s.key;
  keys.push(DISPLAY[k] ?? (k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1)));
  return keys;
}

export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement) || 'gridProxy' in t.dataset) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
