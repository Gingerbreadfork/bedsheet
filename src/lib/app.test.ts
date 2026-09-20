import { describe, it, expect, beforeEach } from 'vitest';
import { app } from './app.svelte';

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
