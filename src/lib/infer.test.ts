import { describe, it, expect } from 'vitest';
import { inferColumnType, isNumeric, toNumber, toTimestamp, detectDateOrder, looksLikeHeader, clearlyHeader } from './infer';

describe('numbers', () => {
  it('recognises the usual shapes', () => {
    for (const s of ['0', '-12', '+3.5', '1,234,567.89', '$40', '€ 12', '12%', '1e6', '.5']) expect(isNumeric(s), s).toBe(true);
    for (const s of ['', 'abc', '1,23', '12a', '$', '1.2.3', 'N/A']) expect(isNumeric(s), s).toBe(false);
  });

  it('converts them', () => {
    expect(toNumber('$1,234.50')).toBe(1234.5);
    expect(toNumber('12 %')).toBe(12);
    expect(toNumber('N/A')).toBeNaN();
    expect(toNumber('')).toBeNaN();
  });
});

describe('dates', () => {
  it('reads the order from the column', () => {
    expect(detectDateOrder(['01/02/2024', '25/02/2024'])).toBe('dmy');
    expect(detectDateOrder(['01/02/2024', '02/25/2024'])).toBe('mdy');
    expect(detectDateOrder(['01/02/2024'])).toBe('mdy');
  });

  it('parses slash, dot, dash and ISO dates', () => {
    expect(toTimestamp('25/12/2024', 'dmy')).toBe(Date.UTC(2024, 11, 25));
    expect(toTimestamp('12.25.24', 'mdy')).toBe(Date.UTC(2024, 11, 25));
    expect(toTimestamp('1-2-99', 'dmy')).toBe(Date.UTC(1999, 1, 1));
    expect(toTimestamp('2024-12-25')).toBe(Date.UTC(2024, 11, 25));
    expect(toTimestamp('31/31/2024', 'dmy')).toBeNaN();
    expect(toTimestamp('soon')).toBeNaN();
  });
});

describe('inferColumnType', () => {
  it('tolerates a few stray values', () => {
    const rows = Array.from({ length: 100 }, (_, i) => [i === 7 ? 'N/A' : String(i)]);
    expect(inferColumnType(rows, 0)).toBe('number');
    expect(inferColumnType([['a'], ['1'], ['b']], 0)).toBe('text');
    expect(inferColumnType([[''], ['  ']], 0)).toBe('empty');
  });
});

describe('looksLikeHeader', () => {
  it('accepts names above typed columns', () => {
    expect(looksLikeHeader([['id', 'name', 'joined'], ['1', 'ann', '2024-01-05'], ['2', 'bob', '2024-02-01']])).toBe(true);
  });

  it('rejects a first row that is just more data', () => {
    expect(looksLikeHeader([['1', 'ann', '2024-01-05'], ['2', 'bob', '2024-02-01'], ['3', 'cy', '2024-03-01']])).toBe(false);
    expect(looksLikeHeader([['10', '20'], ['30', '40']])).toBe(false);
  });

  it('assumes a header when every column is text or there is nothing to compare', () => {
    expect(looksLikeHeader([['name', 'city'], ['ann', 'oslo']])).toBe(true);
    expect(looksLikeHeader([['1', '2']])).toBe(true);
  });

  it('keeps year labels over numeric columns', () => {
    expect(looksLikeHeader([['region', '2023', '2024'], ['north', '5', '6'], ['south', '7', '8']])).toBe(true);
  });

  it('is not fooled by a year column in headerless data', () => {
    expect(looksLikeHeader([['2023', 'north', '5'], ['2024', 'south', '7']])).toBe(false);
  });

  it('takes one name above a typed column as enough', () => {
    expect(looksLikeHeader([['2023', 'total'], ['5', '6'], ['7', '8']])).toBe(true);
  });
});

describe('clearlyHeader', () => {
  it('needs a typed column under the names', () => {
    expect(clearlyHeader([['Name', 'Age'], ['Alice', '30']])).toBe(true);
    expect(clearlyHeader([['Name', '2020'], ['Bob', '5']])).toBe(true);
    expect(clearlyHeader([['Name', 'City'], ['Alice', 'Paris']])).toBe(false);
    expect(clearlyHeader([['Alice'], ['Bob']])).toBe(false);
    expect(clearlyHeader([['1', '2'], ['3', '4']])).toBe(false);
    expect(clearlyHeader([['Name', 'Age']])).toBe(false);
  });
});
