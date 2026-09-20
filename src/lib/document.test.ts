import { describe, it, expect } from 'vitest';
import { Doc } from './document.svelte';

function load(text: string): Doc {
  const d = new Doc();
  d.loadText(text, { name: 't.csv', path: '/tmp/t.csv', encoding: 'UTF-8' });
  return d;
}

const column = (d: Doc, c = 0): string[] => d.rows.map((r) => r[c]);

describe('sortBy', () => {
  it('sorts numbers and keeps stray text after them', () => {
    const values = Array.from({ length: 40 }, (_, i) => String(((i * 17) % 40) + 1));
    values.splice(3, 0, 'N/A');
    const d = load('n\n' + values.join('\n') + '\n');
    d.sortBy(0, 'asc');
    expect(column(d)).toEqual([...Array.from({ length: 40 }, (_, i) => String(i + 1)), 'N/A']);
    d.sortBy(0, 'desc');
    expect(column(d)).toEqual([...Array.from({ length: 40 }, (_, i) => String(40 - i)), 'N/A']);
  });

  it('keeps blanks last in both directions', () => {
    const d = load('n\n2\n\n1\n');
    d.insertRows(3);
    d.sortBy(0, 'asc');
    expect(column(d)).toEqual(['1', '2', '', '']);
    d.sortBy(0, 'desc');
    expect(column(d)).toEqual(['2', '1', '', '']);
  });

  it('sorts day-first dates', () => {
    const d = load('d\n25/12/2024\n13/01/2023\n31/05/2022\n');
    d.sortBy(0, 'asc');
    expect(column(d)).toEqual(['31/05/2022', '13/01/2023', '25/12/2024']);
  });

  it('sorts month-first and ISO dates', () => {
    const us = load('d\n12/25/2024\n01/13/2023\n05/31/2024\n');
    us.sortBy(0, 'asc');
    expect(column(us)).toEqual(['01/13/2023', '05/31/2024', '12/25/2024']);
    const iso = load('d\n2024-03-01 10:00\n2023-01-01\n2024-03-01 09:00\n');
    iso.sortBy(0, 'desc');
    expect(column(iso)).toEqual(['2024-03-01 10:00', '2024-03-01 09:00', '2023-01-01']);
  });

  it('undoes to the original order', () => {
    const d = load('n\n3\n1\n2\n');
    d.sortBy(0, 'asc');
    d.undo();
    expect(column(d)).toEqual(['3', '1', '2']);
  });
});

describe('dirty tracking', () => {
  it('follows undo and redo around a save', () => {
    const d = load('a\nx\n');
    d.setCell(0, 0, 'y');
    expect(d.dirty).toBe(true);
    d.markSaved('/tmp/t.csv', 't.csv');
    expect(d.dirty).toBe(false);
    d.undo();
    expect(d.dirty).toBe(true);
    d.redo();
    expect(d.dirty).toBe(false);
  });

  it('stays dirty when the undo history no longer reaches the saved state', () => {
    const d = load('a\nx\n');
    for (let i = 0; i < 501; i++) d.setCell(0, 0, `v${i}`);
    while (d.canUndo) d.undo();
    expect(d.cell(0, 0)).toBe('v0');
    expect(d.dirty).toBe(true);
  });

  it('stays dirty for edits made while a save was in flight', () => {
    const d = load('a\nx\n');
    d.setCell(0, 0, 'saved');
    const point = d.savePoint();
    d.setCell(0, 0, 'typed during save');
    d.markSaved('/tmp/t.csv', 't.csv', point);
    expect(d.dirty).toBe(true);
    d.undo();
    expect(d.dirty).toBe(false);
  });
});
