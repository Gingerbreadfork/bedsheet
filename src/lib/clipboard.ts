import { parseClipboardBlock, blockWidth } from './csv';

/** A block of cells from the clipboard. `header` is true when the source marked its first row as column names. */
export interface ClipBlock {
  rows: string[][];
  header: boolean | null;
}

/** Past this many cells a copy only carries text. */
export const HTML_MAX_CELLS = 20_000;

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

function cellHtml(value: string): string {
  return value.replace(/[&<>"]/g, (ch) => ESCAPES[ch]).replace(/\r\n|\n|\r/g, '<br style="mso-data-placement:same-cell">');
}

/**
 * An HTML table of `rows` for documents and other rich-text targets. It carries no styling of its
 * own, so the target's borders, colours and fonts apply; the header row is marked with `<thead>`.
 */
export function toHtmlTable(rows: readonly (readonly string[])[], header: boolean): string {
  const row = (cells: readonly string[], tag: 'th' | 'td'): string =>
    `<tr>${cells.map((v) => `<${tag}>${cellHtml(v)}</${tag}>`).join('')}</tr>`;
  const head = header && rows.length > 0 ? `<thead>${row(rows[0], 'th')}</thead>` : '';
  const body = (header ? rows.slice(1) : rows).map((r) => row(r, 'td')).join('');
  return `<meta charset="utf-8"><table>${head}<tbody>${body}</tbody></table>`;
}

const SKIPPED = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'META', 'LINK']);
const BLOCKS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE', 'FOOTER',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
  'TABLE', 'TR', 'UL',
]);
const SOFT_BREAK = '\u0001';

/**
 * A cell's text as it reads on screen: collapsed whitespace, a line per paragraph, `<br>` breaks kept,
 * `<pre>` text as written, and the cells of a table nested inside kept apart.
 */
function cellText(cell: Element): string {
  let out = '';
  const walk = (node: Node, pre: boolean): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = child.nodeValue ?? '';
        out += pre ? text.replace(/\r\n?/g, '\n').replaceAll(' ', '\u00a0') : text.replace(/[ \t\n\r\f]+/g, ' ');
      } else if (child.nodeType === 1) {
        const tag = (child as Element).tagName;
        if (SKIPPED.has(tag)) continue;
        if (tag === 'BR') {
          out += '\n';
        } else if (tag === 'TD' || tag === 'TH') {
          out += ' ';
          walk(child, pre);
          out += ' ';
        } else if (BLOCKS.has(tag)) {
          out += SOFT_BREAK;
          walk(child, pre || tag === 'PRE');
          out += SOFT_BREAK;
        } else {
          walk(child, pre);
        }
      }
    }
  };
  walk(cell, false);
  return out
    .replace(/\n(?= *(?:\u0001|$))/g, '')
    .replace(/ *\u0001[\u0001 ]*/g, '\n')
    .replace(/ +/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replaceAll('\u00a0', ' ')
    .replace(/^[\n ]+|[\n ]+$/g, '');
}

function isBoldStyle(el: Element): boolean | null {
  const weight = (el as HTMLElement).style?.fontWeight;
  if (weight) return weight === 'bold' || weight === 'bolder' || Number(weight) >= 600;
  if (el.tagName === 'B' || el.tagName === 'STRONG' || el.tagName === 'TH') return true;
  return null;
}

/** Whether every piece of text in the cell is bold, going by tags and inline font weights. */
function isBold(cell: Element): boolean {
  let any = false;
  const texts: Node[] = [];
  const collect = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 && (child.nodeValue ?? '').trim() !== '') texts.push(child);
      else if (child.nodeType === 1 && !SKIPPED.has((child as Element).tagName)) collect(child);
    }
  };
  collect(cell);
  for (const text of texts) {
    let bold = false;
    for (let el = text.parentElement; el; el = el === cell ? null : el.parentElement) {
      const b = isBoldStyle(el);
      if (b !== null) {
        bold = b;
        break;
      }
    }
    if (!bold) return false;
    any = true;
  }
  return any;
}

/** Text outside `table`, ignoring styles, scripts and whitespace. */
function hasTextOutside(node: Node, table: Element): boolean {
  for (const child of Array.from(node.childNodes)) {
    if (child === table) continue;
    if (child.nodeType === 3 && (child.nodeValue ?? '').trim() !== '') return true;
    if (child.nodeType === 1 && !SKIPPED.has((child as Element).tagName) && hasTextOutside(child, table)) return true;
  }
  return false;
}

/** A cell's colspan or rowspan, where a rowspan of 0 runs to the last row. */
function span(cell: Element, name: 'colspan' | 'rowspan', max: number): number {
  const n = Number.parseInt(cell.getAttribute(name) ?? '', 10);
  if (n === 0 && name === 'rowspan') return max;
  return Math.min(Number.isNaN(n) || n < 1 ? 1 : n, max);
}

/** The cells of the one table that makes up `html`, or null when it holds anything else. */
export function parseHtmlTable(html: string): ClipBlock | null {
  if (typeof DOMParser === 'undefined' || !/<table[\s>]/i.test(html)) return null;
  const dom = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(dom.querySelectorAll('table')).filter((t) => !t.parentElement?.closest('table'));
  if (tables.length !== 1) return null;
  const table = tables[0];
  if (hasTextOutside(dom.body, table)) return null;
  const trs = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table);
  if (trs.length === 0) return null;

  const grid: string[][] = trs.map(() => []);
  const cellsOf = (tr: Element): Element[] => Array.from(tr.children).filter((el) => el.tagName === 'TD' || el.tagName === 'TH');
  trs.forEach((tr, r) => {
    let c = 0;
    for (const cell of cellsOf(tr)) {
      while (grid[r][c] !== undefined) c++;
      const colSpan = span(cell, 'colspan', 1000);
      const rowSpan = span(cell, 'rowspan', trs.length - r);
      const text = cellText(cell);
      for (let i = 0; i < rowSpan; i++) {
        for (let j = 0; j < colSpan; j++) grid[r + i][c + j] = i === 0 && j === 0 ? text : '';
      }
      c += colSpan;
    }
  });
  const width = blockWidth(grid);
  if (width === 0) return null;
  const rows = grid.map((row) => Array.from({ length: width }, (_, c) => row[c] ?? ''));

  const first = cellsOf(trs[0]);
  const second = trs.length > 1 ? cellsOf(trs[1]) : [];
  const allHeads = (cells: Element[]): boolean => cells.length > 0 && cells.every((el) => el.tagName === 'TH');
  const boldRow = (cells: Element[]): boolean => {
    const filled = cells.filter((el) => cellText(el) !== '');
    return filled.length > 0 && filled.every(isBold);
  };
  const marked =
    trs[0].parentElement?.tagName === 'THEAD' ||
    (allHeads(first) && !allHeads(second)) ||
    (second.length > 0 && boldRow(first) && !boldRow(second));
  return { rows, header: marked ? true : null };
}

const loose = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The text's cell, unless CSV quoting in the text swallowed quote marks that the table still shows. */
function pickCell(textCell: string | undefined, tableCell: string): string {
  if (textCell === undefined) return tableCell;
  const lostQuotes = textCell !== tableCell && tableCell.includes('"') && loose(tableCell.replaceAll('"', '')) === loose(textCell.replaceAll('"', ''));
  return lostQuotes ? tableCell : textCell;
}

/**
 * Reads pasted clipboard contents into cells, or null when there is nothing to paste. A table in the
 * HTML wins when the plain text doesn't split into the same shape, as with tables copied out of
 * documents; otherwise the text's cells are used and the HTML says whether the first row is a header.
 */
export function readClipboard(text: string, html: string | null): ClipBlock | null {
  const table = html ? parseHtmlTable(html) : null;
  const plain = text ? parseClipboardBlock(text) : null;
  if (!table) return plain && { rows: plain, header: null };
  if (plain && plain.length === table.rows.length && blockWidth(plain) === blockWidth(table.rows)) {
    return { rows: table.rows.map((row, r) => row.map((cell, c) => pickCell(plain[r][c], cell))), header: table.header };
  }
  return table;
}
