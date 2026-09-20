import { describe, it, expect } from 'vitest';
import { parseCsv, serializeCsv, detectDelimiter, parseClipboardBlock, columnLetter } from './csv';

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3\n', ',').rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });
  it('handles quotes, escaped quotes and embedded newlines', () => {
    const r = parseCsv('"he said ""hi""","line1\nline2",x\n', ',');
    expect(r.rows).toEqual([['he said "hi"', 'line1\nline2', 'x']]);
  });
  it('handles CRLF and reports it', () => {
    const r = parseCsv('a,b\r\n1,2\r\n', ',');
    expect(r.rows).toEqual([['a', 'b'], ['1', '2']]);
    expect(r.lineEnding).toBe('\r\n');
  });
  it('keeps trailing empty field and pads ragged rows', () => {
    const r = parseCsv('a,b,\n1\n', ',');
    expect(r.rows).toEqual([['a', 'b', ''], ['1', '', '']]);
    expect(r.ragged).toBe(true);
  });
  it('drops trailing blank lines but keeps interior ones', () => {
    const r = parseCsv('a\n\nb\n\n\n', ',');
    expect(r.rows).toEqual([['a'], [''], ['b']]);
  });
  it('strips BOM', () => {
    expect(parseCsv('﻿a,b', ',').rows).toEqual([['a', 'b']]);
  });
  it('tolerates unterminated quotes', () => {
    expect(parseCsv('"abc', ',').rows).toEqual([['abc']]);
  });
  it('handles empty input', () => {
    expect(parseCsv('', ',').rows).toEqual([]);
  });
  it('handles text after a closing quote leniently', () => {
    expect(parseCsv('"a"b,c', ',').rows).toEqual([['ab', 'c']]);
  });
});

describe('serializeCsv', () => {
  it('round-trips with quoting', () => {
    const rows = [['a,b', 'say "x"', 'multi\nline', ' pad ', 'plain']];
    const text = serializeCsv(rows, ',');
    expect(text).toBe('"a,b","say ""x""","multi\nline"," pad ",plain\n');
    expect(parseCsv(text, ',').rows).toEqual(rows);
  });
  it('writes CRLF when asked', () => {
    expect(serializeCsv([['a'], ['b']], ',', '\r\n')).toBe('a\r\nb\r\n');
  });
});

describe('detectDelimiter', () => {
  it('detects commas, tabs, semicolons and pipes', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a|b|c\n1|2|3')).toBe('|');
  });
  it('ignores delimiters inside quotes', () => {
    expect(detectDelimiter('"a;b";c\n"1;2";3')).toBe(';');
    expect(detectDelimiter('"x, y"\tb\n"1, 2"\t3')).toBe('\t');
  });
  it('prefers tab for .tsv files', () => {
    expect(detectDelimiter('a,b', 'x.tsv')).toBe('\t');
  });
});

describe('parseClipboardBlock', () => {
  it('parses TSV blocks', () => {
    expect(parseClipboardBlock('a\tb\n1\t2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('treats commas as part of a single value', () => {
    expect(parseClipboardBlock('1,000')).toEqual([['1,000']]);
  });
  it('splits plain lines into one column', () => {
    expect(parseClipboardBlock('x\ny')).toEqual([['x'], ['y']]);
  });
});

describe('columnLetter', () => {
  it('generates spreadsheet letters', () => {
    expect([0, 1, 25, 26, 27, 701, 702].map(columnLetter)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });
});
