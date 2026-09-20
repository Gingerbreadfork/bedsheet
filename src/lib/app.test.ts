import { describe, it, expect, beforeEach, vi } from 'vitest';
import { app } from './app.svelte';

vi.stubGlobal('requestAnimationFrame', (fn: () => void) => setTimeout(fn, 0));

function load(text: string): void {
  app.doc.loadText(text, { name: 't.csv', path: '/tmp/t.csv', encoding: 'UTF-8' });
  app.grid.select(0, 0, false);
}

const column = (c = 0): string[] => app.doc.rows.map((r) => r[c]);

function find(query: string): void {
  app.query = query;
  app.runSearch(false);
}

beforeEach(() => {
  app.matchCase = false;
  app.filterRows = false;
  app.replaceWith = '';
  find('');
});

describe('replace', () => {
  it('inserts $ sequences literally with and without match case', () => {
    for (const matchCase of [true, false]) {
      load('price\nUSD 5\n');
      app.matchCase = matchCase;
      app.replaceWith = '$$ $& ';
      find('USD ');
      app.replaceAll();
      expect(column()).toEqual(['$$ $& 5']);
    }
  });

  it('moves on when the replacement still contains the query', () => {
    load('h\na\nb a\nca\n');
    app.replaceWith = 'aa';
    find('a');
    app.stepMatch(1);
    app.replaceCurrent();
    app.replaceCurrent();
    app.replaceCurrent();
    expect(column()).toEqual(['aa', 'b aa', 'caa']);
  });
});

describe('stepping through matches', () => {
  it('does not rebuild a filtered view that is being kept', async () => {
    load('h\nfoo1\nfoo2\nbar\n');
    app.setQuery('foo');
    await new Promise((r) => setTimeout(r, 200));
    app.toggleFilterRows();
    app.doc.setCell(0, 0, 'changed');
    await new Promise((r) => setTimeout(r, 300));
    expect(app.grid.viewRows).toEqual([0, 1]);
    app.stepMatch(1);
    expect(app.grid.viewRows).toEqual([0, 1]);
  });
});

describe('a filter that matches nothing', () => {
  function filterToNothing(): void {
    load('h\nalpha\nbeta\n');
    find('alpha');
    app.toggleFilterRows();
    find('zzz');
  }

  it('leaves hidden rows alone', () => {
    filterToNothing();
    expect(app.grid.rowCount).toBe(0);
    app.clearSelection();
    app.deleteRows();
    app.fillDown();
    expect(app.selectionText()).toBe('');
    expect(column()).toEqual(['alpha', 'beta']);
  });

  it('adds new rows at the end and shows them', () => {
    filterToNothing();
    app.insertRows('below');
    expect(column()).toEqual(['alpha', 'beta', '']);
    expect(app.grid.viewRows).toEqual([2]);
  });
});

describe('opening something else', () => {
  it('starts a new sheet unfiltered', async () => {
    load('h\nalpha\nbeta\n');
    find('alpha');
    app.toggleFilterRows();
    app.doc.markSaved('/tmp/t.csv', 't.csv');
    await app.newSheet();
    expect(app.query).toBe('');
    expect(app.grid.rowCount).toBe(30);
  });
});

describe('column widths', () => {
  it('stay with their columns through insert, delete, undo and redo', () => {
    load('a,b,c,d\n1,2,3,4\n');
    app.grid.widths = [50, 100, 200, 300];
    app.grid.select(0, 1, false);
    app.insertColumn('left');
    expect(app.grid.widths).toEqual([50, 140, 100, 200, 300]);
    app.undo();
    expect(app.grid.widths).toEqual([50, 100, 200, 300]);
    app.redo();
    expect(app.grid.widths).toEqual([50, 140, 100, 200, 300]);
    app.undo();
    app.grid.select(0, 1, false);
    app.deleteColumns();
    expect(app.grid.widths).toEqual([50, 200, 300]);
    app.undo();
    expect(app.grid.widths).toEqual([50, 140, 200, 300]);
  });
});

describe('clipboard', () => {
  it('pastes a copied multi-line cell back as one cell', () => {
    load('h\n"line1\nline2"\nplain\n');
    app.grid.select(0, 0, false);
    const text = app.selectionText();
    expect(text).toBe('line1\nline2');
    app.grid.select(1, 0, false);
    app.pasteText(text);
    expect(column()).toEqual(['line1\nline2', 'line1\nline2']);
  });

  it('still splits lines that came from somewhere else', () => {
    load('h\na\nb\n');
    app.grid.select(0, 0, false);
    app.pasteText('x\ny');
    expect(column()).toEqual(['x', 'y']);
  });

  it('round-trips a block with tabs, quotes and line breaks', () => {
    load('a,b\n"t\tab","say ""hi"""\n"two\nlines",plain\n');
    app.grid.selectAll();
    const text = app.selectionText();
    app.doc.clearRange(0, 0, 1, 1);
    app.grid.select(0, 0, false);
    app.pasteText(text);
    expect(app.doc.rows).toEqual([['t\tab', 'say "hi"'], ['two\nlines', 'plain']]);
  });
});

describe('encoding', () => {
  const latin = Uint8Array.from([0x6e, 0x0a, 0x63, 0x61, 0x66, 0xe9, 0x0a]);

  it('re-reads an untouched file with another encoding', async () => {
    await app.loadFile({ name: 'l.csv', path: null, bytes: latin });
    expect(app.doc.encoding).toBe('Windows-1252');
    expect(column()).toEqual(['café']);
    app.setEncoding('Windows-1251');
    expect(column()).toEqual(['cafй']);
    expect(app.doc.dirty).toBe(false);
  });

  it('only changes how an edited file is saved', async () => {
    await app.loadFile({ name: 'l.csv', path: null, bytes: latin });
    app.doc.setCell(0, 0, 'thé');
    app.setEncoding('UTF-8');
    expect(column()).toEqual(['thé']);
    expect(app.doc.encoding).toBe('UTF-8');
    app.undo();
    expect(app.doc.encoding).toBe('Windows-1252');
  });
});

describe('custom delimiter', () => {
  it('re-reads the file with any single character', () => {
    load('a:b\n1:2\n');
    expect(app.doc.colCount).toBe(1);
    app.promptDelimiter();
    expect(app.prompt!.submit('::')).toBe(false);
    expect(app.prompt!.submit('"')).toBe(false);
    expect(app.prompt!.submit(':')).toBe(true);
    expect(app.doc.columns).toEqual(['a', 'b']);
    expect(app.doc.toText()).toBe('a:b\n1:2\n');
  });

  it('accepts \\t for a tab', () => {
    load('a\tb\n1\t2\n');
    app.setDelimiter(',');
    app.promptDelimiter();
    expect(app.prompt!.submit('\\t')).toBe(true);
    expect(app.doc.delimiter).toBe('\t');
  });
});

describe('find options', () => {
  beforeEach(() => {
    app.useRegex = false;
    app.wholeCell = false;
  });

  it('matches whole cells only', () => {
    load('h\nann\nanna\nAnn\n');
    app.wholeCell = true;
    find('ann');
    expect(app.grid.matches.map((m) => m.r)).toEqual([0, 2]);
    app.matchCase = true;
    find('ann');
    expect(app.grid.matches.map((m) => m.r)).toEqual([0]);
  });

  it('searches with a regular expression and replaces with groups', () => {
    load('name\n"Smith, Ann"\n"Jones, Bob"\nplain\n');
    app.useRegex = true;
    find('^(\\w+), (\\w+)$');
    expect(app.grid.matches.length).toBe(2);
    app.replaceWith = '$2 $1';
    app.replaceAll();
    expect(column()).toEqual(['Ann Smith', 'Bob Jones', 'plain']);
  });

  it('finds blank cells with a whole-cell pattern', () => {
    load('a,b\n1,\n,2\n3,4\n');
    app.useRegex = true;
    app.wholeCell = true;
    find('');
    expect(app.grid.matches).toEqual([]);
    find('\\s*');
    expect(app.grid.matches).toEqual([{ r: 0, c: 1 }, { r: 1, c: 0 }]);
  });

  it('reports a broken pattern instead of throwing', () => {
    load('h\nx\n');
    app.useRegex = true;
    find('(');
    expect(app.queryError).toBe(true);
    expect(app.grid.matches).toEqual([]);
    app.useRegex = false;
    find('(');
    expect(app.queryError).toBe(false);
  });

  it('limits the search to the selected column and keeps that scope through edits', () => {
    load('a,b\nx,x\ny,x\nx,y\n');
    app.grid.select(0, 1, false);
    app.toggleScope();
    find('x');
    expect(app.grid.matches).toEqual([{ r: 0, c: 1 }, { r: 1, c: 1 }]);
    app.replaceWith = 'z';
    app.replaceAll();
    expect(app.doc.rows).toEqual([['x', 'z'], ['y', 'z'], ['x', 'y']]);
    app.undo();
    expect(app.scope).not.toBeNull();
    app.toggleScope();
    find('x');
    expect(app.grid.matches.length).toBe(4);
  });

  it('limits the search to a block and drops the scope when rows move', () => {
    load('a,b\nx,x\nx,x\nx,x\n');
    app.grid.select(0, 0, false);
    app.grid.extendTo(1, 0, false);
    app.toggleScope();
    find('x');
    expect(app.grid.matches).toEqual([{ r: 0, c: 0 }, { r: 1, c: 0 }]);
    app.grid.select(0, 0, false);
    app.insertRows('above');
    expect(app.scope).toBeNull();
  });
});
