// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { toHtmlTable, parseHtmlTable, readClipboard } from './clipboard';
import { app } from './app.svelte';

const SHEETS_HTML =
  '<google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style>' +
  '<table cellspacing="0" cellpadding="0" dir="ltr" border="1"><colgroup><col width="100"/><col width="100"/></colgroup><tbody>' +
  '<tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px;font-weight:bold;">Name</td><td style="font-weight:bold;">Age</td></tr>' +
  '<tr style="height:21px;"><td style="overflow:hidden;">Alice</td><td style="text-align:right;">30</td></tr>' +
  '</tbody></table></google-sheets-html-origin>';

const DOCS_HTML =
  '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><div dir="ltr" align="left">' +
  '<table style="border:none;border-collapse:collapse;"><colgroup><col width="301" /><col width="301" /></colgroup><tbody>' +
  '<tr style="height:0pt"><td style="border-left:solid #000000 1pt;"><p dir="ltr"><span style="font-weight:700;">City</span></p></td>' +
  '<td><p dir="ltr"><span style="font-weight:700;">Notes</span></p></td></tr>\n' +
  '<tr style="height:0pt"><td><p dir="ltr"><span style="font-weight:400;">Paris</span></p></td>' +
  '<td><p dir="ltr"><span style="font-weight:400;">first line</span></p><p dir="ltr"><span style="font-weight:400;">second   line</span></p></td></tr>' +
  '</tbody></table></div></b>';
const DOCS_TEXT = 'City\nNotes\nParis\nfirst line\nsecond line\n';

describe('toHtmlTable', () => {
  it('escapes markup and keeps line breaks inside cells', () => {
    const html = toHtmlTable([['<a> & "b"', 'one\ntwo']], false);
    expect(html).toContain('&lt;a&gt; &amp; &quot;b&quot;');
    expect(html).toContain('one<br style="mso-data-placement:same-cell">two');
    expect(html).not.toContain('<th');
  });

  it('marks the header row and reads back the same cells', () => {
    const rows = [['Name', 'Notes'], ['Alice', 'x < y\nand more'], ['', 'Bob & co']];
    const html = toHtmlTable(rows, true);
    expect(html).toContain('<thead><tr><th');
    expect(parseHtmlTable(html)).toEqual({ rows, header: true });
  });
});

describe('parseHtmlTable', () => {
  it('reads a Google Sheets copy and its bold header row', () => {
    expect(parseHtmlTable(SHEETS_HTML)).toEqual({ rows: [['Name', 'Age'], ['Alice', '30']], header: true });
  });

  it('reads a Google Docs table with paragraphs in a cell', () => {
    expect(parseHtmlTable(DOCS_HTML)).toEqual({
      rows: [['City', 'Notes'], ['Paris', 'first line\nsecond line']],
      header: true,
    });
  });

  it('does not call a plain first row a header', () => {
    expect(parseHtmlTable('<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>')?.header).toBeNull();
  });

  it('takes th cells and thead as the header', () => {
    expect(parseHtmlTable('<table><tr><th>a</th></tr><tr><td>1</td></tr></table>')?.header).toBe(true);
    expect(parseHtmlTable('<table><thead><tr><td>a</td></tr></thead><tr><td>1</td></tr></table>')?.header).toBe(true);
    expect(parseHtmlTable('<table><tr><th>row</th><td>1</td></tr><tr><th>row</th><td>2</td></tr></table>')?.header).toBeNull();
  });

  it('spreads merged cells over the cells they cover', () => {
    const html =
      '<table><tr><td colspan="2">wide</td><td rowspan="2">tall</td></tr>' +
      '<tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>';
    expect(parseHtmlTable(html)?.rows).toEqual([
      ['wide', '', 'tall'],
      ['a', 'b', ''],
      ['c', '', ''],
    ]);
  });

  it('collapses markup whitespace and treats a lone non-breaking space as empty', () => {
    const html = '<table><tr><td>\n   Hello\n   <i>big</i>   world  </td><td>&nbsp;</td><td>a<br>b<br></td></tr></table>';
    expect(parseHtmlTable(html)?.rows).toEqual([['Hello big world', '', 'a\nb']]);
  });

  it('ignores HTML that is more than a table', () => {
    expect(parseHtmlTable('<p>Intro</p><table><tr><td>1</td></tr></table>')).toBeNull();
    expect(parseHtmlTable('<table><tr><td>1</td></tr></table><table><tr><td>2</td></tr></table>')).toBeNull();
    expect(parseHtmlTable('<p>no table here</p>')).toBeNull();
  });
});

describe('readClipboard', () => {
  it('uses the table when the text does not line up with it', () => {
    expect(readClipboard(DOCS_TEXT, DOCS_HTML)?.rows).toEqual([['City', 'Notes'], ['Paris', 'first line\nsecond line']]);
  });

  it('keeps the exact text when it has the same shape, with the header hint from the HTML', () => {
    const html = '<table><thead><tr><th>a</th><th>b</th></tr></thead><tr><td>x</td><td>y</td></tr></table>';
    expect(readClipboard('a\tb\n  x\ty\n', html)).toEqual({ rows: [['a', 'b'], ['  x', 'y']], header: true });
  });

  it('keeps quote marks that the text lost to CSV quoting', () => {
    const html = '<table><tr><td>"quoted" word</td><td>b</td></tr></table>';
    expect(readClipboard('"quoted" word\tb\n', html)?.rows).toEqual([['"quoted" word', 'b']]);
  });

  it('keeps tabs and quotes the text carries exactly', () => {
    const html = '<table><tr><td>t ab</td><td>say "hi"</td></tr></table>';
    expect(readClipboard('"t\tab"\t"say ""hi"""\n', html)?.rows).toEqual([['t\tab', 'say "hi"']]);
  });

  it('has nothing to paste without text or a table', () => {
    expect(readClipboard('', '<p>hi</p>')).toBeNull();
    expect(readClipboard('', null)).toBeNull();
  });
});

describe('pasting a table from a document', () => {
  it('puts its header row in the column headers of a new sheet', async () => {
    await app.newSheet();
    expect(app.pasteText(DOCS_TEXT, DOCS_HTML)).toBe(true);
    expect(app.doc.hasHeader).toBe(true);
    expect(app.doc.columns).toEqual(['City', 'Notes']);
    expect(app.doc.rows).toEqual([['Paris', 'first line\nsecond line']]);
  });

  it('leaves a row to type into when it is only a header', () => {
    app.doc.newSheet();
    app.grid.select(0, 0, false);
    app.pasteText('a\tb', '<table><thead><tr><th>a</th><th>b</th></tr></thead></table>');
    expect(app.doc.columns).toEqual(['a', 'b']);
    expect(app.doc.rows).toEqual([['', '']]);
  });
});
