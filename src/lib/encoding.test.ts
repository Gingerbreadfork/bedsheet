import { describe, it, expect } from 'vitest';
import { decodeBytes, encodeText, ENCODINGS } from './encoding';

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

describe('decodeBytes', () => {
  it('decodes UTF-8 with and without a BOM', () => {
    expect(decodeBytes(bytes(0xef, 0xbb, 0xbf, 0x61))).toEqual({ text: 'a', encoding: 'UTF-8 with BOM' });
    expect(decodeBytes(bytes(0xc3, 0xa9))).toEqual({ text: 'é', encoding: 'UTF-8' });
  });

  it('falls back to Windows-1252 for invalid UTF-8', () => {
    expect(decodeBytes(bytes(0x63, 0x61, 0x66, 0xe9))).toEqual({ text: 'café', encoding: 'Windows-1252' });
  });

  it('detects UTF-16 by BOM', () => {
    expect(decodeBytes(bytes(0xff, 0xfe, 0x61, 0x00))).toEqual({ text: 'a', encoding: 'UTF-16 LE' });
    expect(decodeBytes(bytes(0xfe, 0xff, 0x00, 0x61))).toEqual({ text: 'a', encoding: 'UTF-16 BE' });
  });

  it('detects UTF-16 without a BOM', () => {
    const le = encodeText('id,name\n1,Zoë\n', 'UTF-16 LE')!.subarray(2);
    expect(decodeBytes(le)).toEqual({ text: 'id,name\n1,Zoë\n', encoding: 'UTF-16 LE' });
    const be = encodeText('id,name\n1,Zoë\n', 'UTF-16 BE')!.subarray(2);
    expect(decodeBytes(be).encoding).toBe('UTF-16 BE');
  });

  it('does not mistake sparse NUL bytes for UTF-16', () => {
    expect(decodeBytes(bytes(0x61, 0x2c, 0x62, 0x00, 0x63, 0x2c, 0x64, 0x0a)).encoding).toBe('UTF-8');
  });

  it('decodes with an encoding chosen by hand', () => {
    expect(decodeBytes(bytes(0xa4), 'ISO-8859-15').text).toBe('€');
    expect(decodeBytes(bytes(0xa4), 'Windows-1252').text).toBe('¤');
  });
});

describe('encodeText', () => {
  it('round-trips every writable encoding', () => {
    for (const { id, kind } of ENCODINGS) {
      if (kind === 'multi') continue;
      const out = encodeText('id;name\r\n1;"abc"\r\n', id);
      expect(out, id).not.toBeNull();
      expect(decodeBytes(out!, id).text, id).toBe('id;name\r\n1;"abc"\r\n');
    }
  });

  it('keeps the BOM a file came with', () => {
    expect(Array.from(encodeText('a', 'UTF-8 with BOM')!)).toEqual([0xef, 0xbb, 0xbf, 0x61]);
    expect(Array.from(encodeText('a', 'UTF-8')!)).toEqual([0x61]);
    expect(Array.from(encodeText('a', 'UTF-16 LE')!)).toEqual([0xff, 0xfe, 0x61, 0x00]);
  });

  it('writes legacy single-byte text', () => {
    expect(Array.from(encodeText('café €', 'Windows-1252')!)).toEqual([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]);
  });

  it('refuses text the encoding cannot hold, and encodings it cannot write', () => {
    expect(encodeText('日本', 'Windows-1252')).toBeNull();
    expect(encodeText('日本', 'Shift JIS')).toBeNull();
  });

  it('handles characters outside the basic plane in UTF-16', () => {
    const out = encodeText('😀', 'UTF-16 BE')!;
    expect(decodeBytes(out).text).toBe('😀');
  });
});
