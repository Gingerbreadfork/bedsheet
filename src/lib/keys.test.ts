import { describe, it, expect } from 'vitest';
import { parseShortcut, eventMatches, shortcutKeys } from './keys';

const press = (key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key, code: '', ctrlKey: false, shiftKey: false, altKey: false, ...mods }) as KeyboardEvent;

describe('eventMatches', () => {
  it('requires the same modifiers', () => {
    const save = parseShortcut('Ctrl+S');
    expect(eventMatches(press('s', { ctrlKey: true }), save)).toBe(true);
    expect(eventMatches(press('S', { ctrlKey: true, shiftKey: true }), save)).toBe(false);
    expect(eventMatches(press('s'), save)).toBe(false);
  });

  it('zooms in with or without Shift, on any layout', () => {
    const zoomIn = parseShortcut('Ctrl+=');
    expect(eventMatches(press('=', { ctrlKey: true, code: 'Equal' }), zoomIn)).toBe(true);
    expect(eventMatches(press('+', { ctrlKey: true, shiftKey: true, code: 'Equal' }), zoomIn)).toBe(true);
    expect(eventMatches(press('+', { ctrlKey: true, code: 'NumpadAdd' }), zoomIn)).toBe(true);
  });

  it('tells Delete from Shift+Delete', () => {
    expect(eventMatches(press('Delete', { shiftKey: true }), parseShortcut('Delete'))).toBe(false);
  });
});

describe('shortcutKeys', () => {
  it('labels keys for display', () => {
    expect(shortcutKeys('Ctrl+Shift+Z')).toEqual(['Ctrl', 'Shift', 'Z']);
    expect(shortcutKeys('Shift+F3')).toEqual(['Shift', 'F3']);
  });
});
