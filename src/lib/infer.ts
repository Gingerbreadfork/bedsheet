export type ColType = 'number' | 'date' | 'bool' | 'text' | 'empty';

const NUMBER = /^[-+]?[$€£¥]?\s?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?\s?%?$/;
const HAS_DIGIT = /\d/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH_DATE = /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/;
const BOOL = /^(?:true|false|yes|no)$/i;

export function isNumeric(s: string): boolean {
  return HAS_DIGIT.test(s) && NUMBER.test(s);
}

export function isDate(s: string): boolean {
  return ISO_DATE.test(s) || SLASH_DATE.test(s);
}

export function toNumber(s: string): number {
  return Number(s.replace(/[$€£¥,%\s]/g, ''));
}

export function inferColumnType(rows: readonly (readonly string[])[], col: number, sampleSize = 1000): ColType {
  const limit = Math.min(rows.length, sampleSize);
  const step = rows.length > sampleSize ? rows.length / sampleSize : 1;
  let nonEmpty = 0;
  let num = 0;
  let date = 0;
  let bool = 0;
  for (let k = 0; k < limit; k++) {
    const v = rows[Math.floor(k * step)]?.[col];
    if (v === undefined || v === '') continue;
    const s = v.trim();
    if (s === '') continue;
    nonEmpty++;
    if (isNumeric(s)) num++;
    else if (isDate(s)) date++;
    else if (BOOL.test(s)) bool++;
  }
  if (nonEmpty === 0) return 'empty';
  const threshold = nonEmpty * 0.95;
  if (num >= threshold) return 'number';
  if (date >= threshold) return 'date';
  if (bool >= threshold) return 'bool';
  return 'text';
}

export function inferAllColumnTypes(rows: readonly (readonly string[])[], colCount: number): ColType[] {
  const out: ColType[] = new Array(colCount);
  for (let c = 0; c < colCount; c++) out[c] = inferColumnType(rows, c);
  return out;
}
