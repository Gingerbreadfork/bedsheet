export interface EncodingOption {
  /** Shown in the interface and stored on the document. */
  id: string;
  /** Label understood by TextDecoder. */
  decoder: string;
  kind: 'utf8' | 'utf16le' | 'utf16be' | 'single' | 'multi';
  bom?: boolean;
}

export const ENCODINGS: EncodingOption[] = [
  { id: 'UTF-8', decoder: 'utf-8', kind: 'utf8' },
  { id: 'UTF-8 with BOM', decoder: 'utf-8', kind: 'utf8', bom: true },
  { id: 'UTF-16 LE', decoder: 'utf-16le', kind: 'utf16le', bom: true },
  { id: 'UTF-16 BE', decoder: 'utf-16be', kind: 'utf16be', bom: true },
  { id: 'Windows-1252', decoder: 'windows-1252', kind: 'single' },
  { id: 'Windows-1250', decoder: 'windows-1250', kind: 'single' },
  { id: 'Windows-1251', decoder: 'windows-1251', kind: 'single' },
  { id: 'ISO-8859-2', decoder: 'iso-8859-2', kind: 'single' },
  { id: 'ISO-8859-15', decoder: 'iso-8859-15', kind: 'single' },
  { id: 'Mac Roman', decoder: 'macintosh', kind: 'single' },
  { id: 'Shift JIS', decoder: 'shift_jis', kind: 'multi' },
  { id: 'GB18030', decoder: 'gb18030', kind: 'multi' },
  { id: 'Big5', decoder: 'big5', kind: 'multi' },
  { id: 'EUC-KR', decoder: 'euc-kr', kind: 'multi' },
];

const byId = new Map(ENCODINGS.map((e) => [e.id, e]));

export interface Decoded {
  text: string;
  encoding: string;
}

function startsWith(bytes: Uint8Array, ...bom: number[]): boolean {
  return bytes.length >= bom.length && bom.every((b, i) => bytes[i] === b);
}

/** Spots BOM-less UTF-16 by where the zero bytes of its ASCII characters fall. */
function sniffUtf16(bytes: Uint8Array): 'UTF-16 LE' | 'UTF-16 BE' | null {
  const n = Math.min(bytes.length & ~1, 4096);
  if (n < 4) return null;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZeros++;
    if (bytes[i + 1] === 0) oddZeros++;
  }
  const pairs = n / 2;
  if (oddZeros > pairs * 0.4 && evenZeros < pairs * 0.05) return 'UTF-16 LE';
  if (evenZeros > pairs * 0.4 && oddZeros < pairs * 0.05) return 'UTF-16 BE';
  return null;
}

function detect(bytes: Uint8Array): string | null {
  if (startsWith(bytes, 0xef, 0xbb, 0xbf)) return 'UTF-8 with BOM';
  if (startsWith(bytes, 0xff, 0xfe)) return 'UTF-16 LE';
  if (startsWith(bytes, 0xfe, 0xff)) return 'UTF-16 BE';
  return sniffUtf16(bytes);
}

function stripBom(bytes: Uint8Array, kind: EncodingOption['kind']): Uint8Array {
  if (kind === 'utf8' && startsWith(bytes, 0xef, 0xbb, 0xbf)) return bytes.subarray(3);
  if (kind === 'utf16le' && startsWith(bytes, 0xff, 0xfe)) return bytes.subarray(2);
  if (kind === 'utf16be' && startsWith(bytes, 0xfe, 0xff)) return bytes.subarray(2);
  return bytes;
}

/** Decodes with the given encoding, or detects one: BOM, then UTF-16, then UTF-8, then Windows-1252. */
export function decodeBytes(bytes: Uint8Array, encoding?: string): Decoded {
  const id = encoding ?? detect(bytes);
  const option = id ? byId.get(id) : undefined;
  if (option) {
    return { text: new TextDecoder(option.decoder).decode(stripBom(bytes, option.kind)), encoding: option.id };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' };
  }
}

const singleByteTables = new Map<string, Map<number, number>>();

function singleByteTable(decoderLabel: string): Map<number, number> {
  let table = singleByteTables.get(decoderLabel);
  if (!table) {
    table = new Map();
    const decoder = new TextDecoder(decoderLabel);
    for (let b = 0; b < 256; b++) {
      const ch = decoder.decode(Uint8Array.of(b));
      if (ch.length === 1 && ch !== '�') table.set(ch.charCodeAt(0), b);
    }
    singleByteTables.set(decoderLabel, table);
  }
  return table;
}

function encodeUtf16(text: string, littleEndian: boolean): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0xfeff, littleEndian);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), littleEndian);
  return out;
}

/** Returns null when the encoding can't be written or can't represent every character. */
export function encodeText(text: string, encoding: string): Uint8Array | null {
  const option = byId.get(encoding);
  if (!option) return null;
  switch (option.kind) {
    case 'utf8': {
      const body = new TextEncoder().encode(text);
      if (!option.bom) return body;
      const out = new Uint8Array(body.length + 3);
      out.set([0xef, 0xbb, 0xbf]);
      out.set(body, 3);
      return out;
    }
    case 'utf16le':
      return encodeUtf16(text, true);
    case 'utf16be':
      return encodeUtf16(text, false);
    case 'single': {
      const table = singleByteTable(option.decoder);
      const out = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) {
        const b = table.get(text.charCodeAt(i));
        if (b === undefined) return null;
        out[i] = b;
      }
      return out;
    }
    case 'multi':
      return null;
  }
}
