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

  it('counts a delimiter change as an edit', () => {
    const d = load('a,b\n1,2\n');
    d.markSaved('/tmp/t.csv', 't.csv');
    d.setDelimiter(';');
    expect(d.dirty).toBe(true);
    expect(d.toText()).toBe('a;b\n1;2\n');
    d.undo();
    expect(d.dirty).toBe(false);
    expect(d.delimiter).toBe(',');
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

describe('setHasHeader', () => {
  it('moves the first row into the header and back', () => {
    const d = load('a,b\n1,2\n');
    d.setHasHeader(false);
    expect(d.rows).toEqual([['a', 'b'], ['1', '2']]);
    expect(d.toText()).toBe('a,b\n1,2\n');
    d.undo();
    expect(d.columns).toEqual(['a', 'b']);
    expect(d.rows).toEqual([['1', '2']]);
  });

  it('does not invent a row when undone on an empty sheet', () => {
    const d = new Doc();
    d.newSheet(0, 2);
    d.setHasHeader(true);
    d.undo();
    expect(d.rows).toEqual([]);
  });
});

describe('loadText', () => {
  it('uses the first row as the header when it reads like one', () => {
    const d = load('id,name\n1,ann\n2,bob\n');
    expect(d.hasHeader).toBe(true);
    expect(d.columns).toEqual(['id', 'name']);
  });

  it('letters the columns when the first row is data, and saves it back unchanged', () => {
    const d = load('1,ann\n2,bob\n3,cy\n');
    expect(d.hasHeader).toBe(false);
    expect(d.columns).toEqual(['A', 'B']);
    expect(d.rowCount).toBe(3);
    expect(d.toText()).toBe('1,ann\n2,bob\n3,cy\n');
  });
});

describe('moving rows and columns', () => {
  it('moves a block of rows and undoes it', () => {
    const d = load('n\na\nb\nc\nd\n');
    expect(d.shiftRows(1, 2, -1)).toBe(true);
    expect(column(d)).toEqual(['b', 'c', 'a', 'd']);
    expect(d.shiftRows(0, 2, 1)).toBe(true);
    expect(column(d)).toEqual(['a', 'b', 'c', 'd']);
    d.undo();
    d.undo();
    expect(column(d)).toEqual(['a', 'b', 'c', 'd']);
    d.redo();
    expect(column(d)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('refuses to move past either end', () => {
    const d = load('n\na\nb\n');
    expect(d.shiftRows(0, 1, -1)).toBe(false);
    expect(d.shiftRows(1, 1, 1)).toBe(false);
    expect(d.shiftColumns(0, 1, 1)).toBe(false);
    expect(d.canUndo).toBe(false);
  });

  it('moves columns with their names and data', () => {
    const d = load('a,b,c\n1,2,3\n');
    const seen: unknown[] = [];
    d.onColumnChange((change) => seen.push(change));
    d.shiftColumns(0, 1, 1);
    expect(d.columns).toEqual(['b', 'a', 'c']);
    expect(d.rows).toEqual([['2', '1', '3']]);
    expect(seen).toEqual([{ kind: 'move', from: 1, to: 0 }]);
    d.undo();
    expect(d.columns).toEqual(['a', 'b', 'c']);
    expect(d.rows).toEqual([['1', '2', '3']]);
  });
});

describe('large row operations', () => {
  const big = (): Doc => load('n\n' + Array.from({ length: 150_000 }, (_, i) => i).join('\n') + '\n');

  it('inserts and removes a very large block of rows', () => {
    const d = big();
    d.insertRows(10, 150_000);
    expect(d.rowCount).toBe(300_000);
    expect(d.cell(9, 0)).toBe('9');
    expect(d.cell(10, 0)).toBe('');
    expect(d.cell(150_010, 0)).toBe('10');
    d.undo();
    expect(d.rowCount).toBe(150_000);
    expect(d.cell(10, 0)).toBe('10');
  });

  it('restores scattered deleted rows in place, quickly', () => {
    const d = big();
    const odd = Array.from({ length: 75_000 }, (_, i) => i * 2 + 1);
    d.deleteRows(odd);
    expect(d.rowCount).toBe(75_000);
    expect(d.cell(1, 0)).toBe('2');
    const started = performance.now();
    d.undo();
    expect(performance.now() - started).toBeLessThan(1000);
    expect(d.rowCount).toBe(150_000);
    expect(d.cell(1, 0)).toBe('1');
    expect(d.cell(149_999, 0)).toBe('149999');
  });
});

describe('recovered contents', () => {
  it('load as unsaved, keeping the header choice that was in effect', () => {
    const d = new Doc();
    d.loadText('1,2\n3,4\n', { name: 't.csv', path: '/tmp/t.csv', encoding: 'UTF-8', hasHeader: true });
    expect(d.columns).toEqual(['1', '2']);
    d.markUnsaved();
    expect(d.dirty).toBe(true);
    d.setCell(0, 0, 'x');
    d.undo();
    expect(d.dirty).toBe(true);
    d.markSaved('/tmp/t.csv', 't.csv');
    expect(d.dirty).toBe(false);
  });
});
