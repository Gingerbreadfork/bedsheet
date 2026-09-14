<script lang="ts">
  import { app, type MenuItem } from '../lib/app.svelte';
  import { DELIMITERS, delimiterLabel } from '../lib/csv';
  import { inferColumnType, isNumeric, toNumber } from '../lib/infer';
  import Icon from './Icon.svelte';

  const { doc, grid } = app;
  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });

  let rowsText = $derived.by(() => {
    void doc.rev;
    const total = doc.rowCount;
    if (grid.viewRows) return `${grid.viewRows.length.toLocaleString()} of ${total.toLocaleString()} rows`;
    return `${total.toLocaleString()} ${total === 1 ? 'row' : 'rows'}`;
  });
  let colsText = $derived.by(() => {
    void doc.rev;
    return `${doc.colCount.toLocaleString()} ${doc.colCount === 1 ? 'column' : 'columns'}`;
  });

  let selection = $derived.by(() => {
    void doc.rev;
    if (grid.rowCount === 0 || grid.colCount === 0) return { text: '', type: '', stats: '' };
    const { r0, c0, r1, c1 } = grid.range;
    const a = grid.anchor;
    const type = inferColumnType(doc.rows, a.c);
    const typeLabel = type === 'empty' ? '' : type;
    if (grid.isSingle) {
      return { text: `${doc.columnLabel(a.c)}, row ${(grid.dataRow(a.r) + 1).toLocaleString()}`, type: typeLabel, stats: '' };
    }
    const rows = r1 - r0 + 1;
    const cols = c1 - c0 + 1;
    const cells = rows * cols;
    let stats = '';
    if (cells <= 200_000) {
      let sum = 0;
      let count = 0;
      for (let vr = r0; vr <= r1; vr++) {
        const row = doc.rows[grid.dataRow(vr)];
        for (let c = c0; c <= c1; c++) {
          const v = row[c];
          if (v && isNumeric(v.trim())) {
            sum += toNumber(v);
            count++;
          }
        }
      }
      if (count > 1) stats = `Sum ${nf.format(sum)}   Avg ${nf.format(sum / count)}   Count ${count.toLocaleString()}`;
    }
    return { text: `${rows.toLocaleString()} × ${cols.toLocaleString()} selected`, type: typeLabel, stats };
  });

  function delimiterMenu(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = DELIMITERS.map((d) => ({
      label: d.label,
      checked: doc.delimiter === d.char,
      run: () => app.setDelimiter(d.char),
    }));
    app.openMenu({ x: r.left, y: r.top - 4, align: 'left', items, width: 160 });
  }
</script>

<footer class="status">
  <div class="left">
    {#if doc.loaded}
      <span class="stat">{rowsText}</span>
      <span class="dot"></span>
      <span class="stat">{colsText}</span>
      {#if selection.text}
        <span class="dot"></span>
        <span class="stat sel">{selection.text}</span>
        {#if selection.type}
          <span class="type">{selection.type}</span>
        {/if}
      {/if}
      {#if selection.stats}
        <span class="dot"></span>
        <span class="stat stats">{selection.stats}</span>
      {/if}
    {/if}
  </div>
  <div class="right">
    {#if doc.loaded}
      <button class="chip" title="Delimiter" onclick={delimiterMenu}>
        {delimiterLabel(doc.delimiter)}
        <Icon name="chevronUp" size={12} />
      </button>
      <span class="chip static" title="Encoding">{doc.encoding}</span>
      <button class="chip" class:on={doc.hasHeader} title="Toggle header row" onclick={() => app.toggleHeader()}>
        <span class="check"><Icon name="check" size={12} /></span>
        Header row
      </button>
      <button class="chip" class:on={grid.mono} title="Monospace cells" onclick={() => app.toggleMono()}>Mono</button>
      {#if grid.zoom !== 1}
        <button class="chip" title="Reset zoom (Ctrl+0)" onclick={() => app.setZoom(1)}>{Math.round(grid.zoom * 100)}%</button>
      {/if}
    {/if}
    <button class="chip" onclick={() => (app.paletteOpen = true)}>
      <span class="keys"><kbd>Ctrl</kbd><kbd>K</kbd></span>
      Commands
    </button>
  </div>
</footer>

<style>
  .status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    height: 30px;
    padding: 0 8px 0 12px;
    background: var(--paper);
    border-top: 1px solid var(--line-strong);
    font-size: 12px;
    color: var(--ink-2);
    flex: none;
    min-width: 0;
  }
  .left,
  .right {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .left {
    flex: 1;
    overflow: hidden;
  }
  .stat {
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .stat.sel {
    color: var(--ink);
  }
  .stat.stats {
    white-space: pre;
    color: var(--ink-2);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .type {
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--paper-3);
    color: var(--ink-2);
    font-size: 11px;
    font-weight: 500;
  }
  .dot {
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--ink-4);
    flex: none;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 22px;
    padding: 0 8px;
    border-radius: 5px;
    color: var(--ink-2);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);
  }
  .chip:hover {
    background: var(--paper-3);
    color: var(--ink);
  }
  .chip.static {
    color: var(--ink-3);
    font-weight: 400;
  }
  .chip.static:hover {
    background: transparent;
    color: var(--ink-3);
  }
  .chip .check {
    display: inline-flex;
    width: 14px;
    height: 14px;
    align-items: center;
    justify-content: center;
    border-radius: 3px;
    border: 1px solid var(--line-strong);
    color: transparent;
    background: var(--sheet);
    transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);
  }
  .chip.on .check {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-ink);
  }
  .chip.on {
    color: var(--ink);
  }
  .chip kbd {
    height: 16px;
    min-width: 16px;
    font-size: 10px;
    padding: 0 4px;
  }
</style>
