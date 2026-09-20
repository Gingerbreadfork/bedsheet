<script lang="ts">
  import { tick } from 'svelte';
  import { app, type MenuItem } from '../lib/app.svelte';
  import { cellKey, MIN_COL_WIDTH, MAX_COL_WIDTH, DEFAULT_COL_WIDTH, type Pos } from '../lib/grid.svelte';
  import { inferAllColumnTypes } from '../lib/infer';
  import { columnLetter } from '../lib/csv';
  import CellEditor from './CellEditor.svelte';
  import Icon from './Icon.svelte';

  const { doc, grid } = app;

  const ROW_H = 28;
  const HEAD_H = 32;
  const OVERSCAN = 5;

  let viewport = $state<HTMLDivElement>();
  let scrollTop = $state(0);
  let scrollLeft = $state(0);
  let viewW = $state(0);
  let viewH = $state(0);
  let hoverRow = $state(-1);
  let headerInput = $state<HTMLInputElement>();

  let rowH = $derived(Math.round(ROW_H * grid.zoom));
  let headH = $derived(Math.round(HEAD_H * grid.zoom));
  let fontSize = $derived(Math.round(13 * grid.zoom * 10) / 10);
  let rowCount = $derived(grid.rowCount);
  let colCount = $derived(grid.colCount);
  let digits = $derived(String(Math.max(rowCount, 1)).length);
  let gutterW = $derived(Math.max(44, Math.round((18 + digits * 7.6) * grid.zoom)));

  let colLefts = $derived.by(() => {
    const out = new Array<number>(colCount + 1);
    let x = 0;
    for (let c = 0; c < colCount; c++) {
      out[c] = x;
      x += grid.widths[c] ?? DEFAULT_COL_WIDTH;
    }
    out[colCount] = x;
    return out;
  });
  let totalW = $derived(colLefts[colCount] ?? 0);
  let totalH = $derived(rowCount * rowH);
  let sizerW = $derived(gutterW + totalW + Math.round(40 * grid.zoom));
  let sizerH = $derived(headH + totalH + rowH);

  let firstRow = $derived(Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN));
  let lastRow = $derived(Math.min(rowCount - 1, Math.ceil((scrollTop + viewH - headH) / rowH) + OVERSCAN));

  function colAt(x: number): number {
    let lo = 0;
    let hi = colCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (colLefts[mid] <= x) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  let firstCol = $derived(colCount === 0 ? 0 : Math.max(0, colAt(scrollLeft) - 1));
  let lastCol = $derived(colCount === 0 ? -1 : Math.min(colCount - 1, colAt(scrollLeft + viewW - gutterW) + 1));

  let visibleCols = $derived.by(() => {
    const out: number[] = [];
    for (let c = firstCol; c <= lastCol; c++) out.push(c);
    return out;
  });

  let visibleRows = $derived.by(() => {
    void doc.rev;
    const out: { vr: number; dr: number; cells: string[] }[] = [];
    for (let vr = firstRow; vr <= lastRow; vr++) {
      const dr = grid.dataRow(vr);
      out.push({ vr, dr, cells: doc.rows[dr] ?? [] });
    }
    return out;
  });

  let colTypes = $derived.by(() => {
    void doc.rev;
    return inferAllColumnTypes(doc.rows, colCount);
  });

  let headers = $derived.by(() => {
    void doc.rev;
    return Array.from({ length: colCount }, (_, c) => doc.columnLabel(c));
  });

  let range = $derived(grid.range);
  let active = $derived(grid.anchor);
  let matchIndex = $derived(grid.matchIndex);
  let currentMatch = $derived(matchIndex >= 0 ? grid.matches[matchIndex] : null);
  let fullRows = $derived(range.c0 === 0 && range.c1 === colCount - 1 && colCount > 0);
  let fullCols = $derived(range.r0 === 0 && range.r1 === rowCount - 1 && rowCount > 0);

  let selRect = $derived.by(() => {
    if (rowCount === 0 || colCount === 0) return null;
    return {
      left: gutterW + colLefts[range.c0],
      top: headH + range.r0 * rowH,
      width: colLefts[range.c1 + 1] - colLefts[range.c0],
      height: (range.r1 - range.r0 + 1) * rowH,
    };
  });
  let activeRect = $derived.by(() => {
    if (rowCount === 0 || colCount === 0) return null;
    return {
      left: gutterW + colLefts[active.c],
      top: headH + active.r * rowH,
      width: colLefts[active.c + 1] - colLefts[active.c],
      height: rowH,
    };
  });

  // ---------- layout helpers ----------

  let measureCtx: CanvasRenderingContext2D | null = null;
  function cellFont(weight = 400): string {
    const family = grid.mono ? "'IBM Plex Mono', monospace" : "'IBM Plex Sans Variable', 'IBM Plex Sans', sans-serif";
    return `${weight} ${fontSize}px ${family}`;
  }
  function measure(text: string): number {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    return measureCtx ? measureCtx.measureText(text).width : text.length * 7;
  }
  function fitColumn(c: number): number {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx) return DEFAULT_COL_WIDTH;
    measureCtx.font = cellFont(500);
    let w = measure(headers[c] ?? '') + 8;
    measureCtx.font = cellFont(400);
    const rows = doc.rows;
    const n = rows.length;
    const dense = Math.min(n, 200);
    for (let r = 0; r < dense; r++) {
      const v = rows[r][c];
      if (v) w = Math.max(w, measure(v.length > 120 ? v.slice(0, 120) : v));
    }
    if (n > dense) {
      const step = Math.max(1, Math.floor((n - dense) / 300));
      for (let r = dense; r < n; r += step) {
        const v = rows[r][c];
        if (v) w = Math.max(w, measure(v.length > 120 ? v.slice(0, 120) : v));
      }
    }
    return Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, Math.ceil(w + 22 * grid.zoom)));
  }
  function fitAll(): void {
    grid.widths = Array.from({ length: colCount }, (_, c) => fitColumn(c));
  }

  $effect(() => {
    if (colCount > 0 && grid.widths.length !== colCount) {
      if (grid.widths.length === 0) fitAll();
      else {
        const next = grid.widths.slice(0, colCount);
        while (next.length < colCount) next.push(fitColumn(next.length));
        grid.widths = next;
      }
    }
  });

  app.autoFit = (cols) => {
    if (cols === 'all') fitAll();
    else for (const c of cols) grid.widths[c] = fitColumn(c);
  };

  function scrollIntoView(p: Pos): void {
    const vp = viewport;
    if (!vp || rowCount === 0 || colCount === 0) return;
    const top = headH + p.r * rowH;
    const bottom = top + rowH;
    const left = gutterW + colLefts[p.c];
    const right = left + (colLefts[p.c + 1] - colLefts[p.c]);
    let st = vp.scrollTop;
    let sl = vp.scrollLeft;
    if (top - headH < st) st = top - headH;
    else if (bottom > st + vp.clientHeight) st = bottom - vp.clientHeight;
    if (left - gutterW < sl) sl = left - gutterW;
    else if (right > sl + vp.clientWidth) sl = Math.min(right - vp.clientWidth, left - gutterW);
    if (st !== vp.scrollTop || sl !== vp.scrollLeft) {
      vp.scrollTo({ top: st, left: sl, behavior: 'auto' });
      scrollTop = vp.scrollTop;
      scrollLeft = vp.scrollLeft;
    }
  }
  grid.scrollIntoView = scrollIntoView;
  grid.focusGrid = () => viewport?.focus({ preventScroll: true });

  $effect(() =>
    doc.onChange((kind) => {
      if (kind !== 'load' || !viewport) return;
      viewport.scrollTo(0, 0);
      scrollTop = 0;
      scrollLeft = 0;
    }),
  );

  function onScroll(): void {
    if (!viewport) return;
    scrollTop = viewport.scrollTop;
    scrollLeft = viewport.scrollLeft;
  }

  // ---------- hit testing ----------

  type Hit =
    | { kind: 'corner' }
    | { kind: 'header'; c: number }
    | { kind: 'gutter'; r: number }
    | { kind: 'cell'; r: number; c: number }
    | { kind: 'addRow' }
    | { kind: 'addCol' }
    | { kind: 'none' };

  function hitTest(e: PointerEvent | MouseEvent): Hit {
    const vp = viewport;
    if (!vp) return { kind: 'none' };
    const rect = vp.getBoundingClientRect();
    const vx = e.clientX - rect.left;
    const vy = e.clientY - rect.top;
    if (vx >= vp.clientWidth || vy >= vp.clientHeight) return { kind: 'none' };
    const cx = vx + vp.scrollLeft - gutterW;
    const cy = vy + vp.scrollTop - headH;
    const inGutter = vx < gutterW;
    const inHead = vy < headH;
    if (inGutter && inHead) return { kind: 'corner' };
    if (inHead) {
      if (cx >= totalW) return { kind: 'addCol' };
      return colCount === 0 ? { kind: 'none' } : { kind: 'header', c: colAt(cx) };
    }
    const r = Math.floor(cy / rowH);
    if (r >= rowCount) return r === rowCount ? { kind: 'addRow' } : { kind: 'none' };
    if (inGutter) return { kind: 'gutter', r };
    if (cx >= totalW || colCount === 0) return { kind: 'none' };
    return { kind: 'cell', r, c: colAt(cx) };
  }

  function cellUnderPointer(e: PointerEvent): Pos {
    const vp = viewport!;
    const rect = vp.getBoundingClientRect();
    const vx = Math.min(Math.max(e.clientX - rect.left, gutterW), vp.clientWidth - 1);
    const vy = Math.min(Math.max(e.clientY - rect.top, headH), vp.clientHeight - 1);
    const cx = vx + vp.scrollLeft - gutterW;
    const cy = vy + vp.scrollTop - headH;
    return grid.clamp({ r: Math.floor(cy / rowH), c: colAt(cx) });
  }

  // ---------- pointer ----------

  type Drag =
    | { kind: 'cells' }
    | { kind: 'rows' }
    | { kind: 'cols' }
    | { kind: 'resize'; c: number; startX: number; startW: number };
  let drag: Drag | null = null;
  let autoScrollRaf = 0;
  let lastPointer: PointerEvent | null = null;

  function onPointerDown(e: PointerEvent): void {
    if (!viewport) return;
    const target = e.target as HTMLElement;
    if (target.closest('.resize')) {
      const c = Number(target.closest<HTMLElement>('.hcell')!.dataset.c);
      drag = { kind: 'resize', c, startX: e.clientX, startW: grid.widths[c] ?? DEFAULT_COL_WIDTH };
      viewport.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (e.button === 2) return;
    if (e.button !== 0) return;
    if (target.closest('.editor')) return;
    if (app.menu) app.closeMenu();
    const hit = hitTest(e);
    if (hit.kind === 'none') {
      viewport.focus({ preventScroll: true });
      return;
    }
    if (grid.editingHeader !== null && hit.kind !== 'header') commitHeader();
    app.commitEdit?.();
    switch (hit.kind) {
      case 'corner':
        grid.selectAll();
        break;
      case 'header':
        if (grid.editingHeader === hit.c) return;
        commitHeader();
        if (e.shiftKey) grid.selectCols(grid.anchor.c, hit.c);
        else grid.selectCols(hit.c, hit.c);
        drag = { kind: 'cols' };
        break;
      case 'gutter':
        if (e.shiftKey) grid.selectRows(grid.anchor.r, hit.r);
        else grid.selectRows(hit.r, hit.r);
        drag = { kind: 'rows' };
        break;
      case 'cell':
        if (e.shiftKey) grid.extendTo(hit.r, hit.c, false);
        else grid.select(hit.r, hit.c, false);
        drag = { kind: 'cells' };
        break;
      case 'addRow':
        addRowAtEnd();
        break;
      case 'addCol':
        grid.select(grid.anchor.r, colCount - 1, false);
        app.insertColumn('right');
        break;
    }
    if (drag) viewport.setPointerCapture(e.pointerId);
    viewport.focus({ preventScroll: true });
    e.preventDefault();
  }

  function addRowAtEnd(): void {
    if (rowCount > 0) grid.select(rowCount - 1, grid.anchor.c, false);
    app.insertRows('below');
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag) {
      if (e.buttons === 0) {
        const hit = hitTest(e);
        hoverRow = hit.kind === 'cell' || hit.kind === 'gutter' ? hit.r : -1;
      }
      return;
    }
    lastPointer = e;
    if (drag.kind === 'resize') {
      const w = Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, drag.startW + (e.clientX - drag.startX)));
      grid.widths[drag.c] = Math.round(w);
      return;
    }
    extendDrag(e);
    scheduleAutoScroll();
  }

  function extendDrag(e: PointerEvent): void {
    if (!drag) return;
    const p = cellUnderPointer(e);
    if (drag.kind === 'cells') grid.extendTo(p.r, p.c, false);
    else if (drag.kind === 'rows') grid.extendTo(p.r, colCount - 1, false);
    else if (drag.kind === 'cols') grid.extendTo(rowCount - 1, p.c, false);
  }

  function scheduleAutoScroll(): void {
    if (autoScrollRaf) return;
    const step = () => {
      autoScrollRaf = 0;
      const vp = viewport;
      const e = lastPointer;
      if (!vp || !e || !drag || drag.kind === 'resize') return;
      const rect = vp.getBoundingClientRect();
      let dx = 0;
      let dy = 0;
      const edge = 24;
      if (e.clientY > rect.top + vp.clientHeight - edge) dy = Math.min(40, (e.clientY - (rect.top + vp.clientHeight - edge)) * 0.6 + 4);
      else if (e.clientY < rect.top + headH + edge && drag.kind !== 'cols') dy = -Math.min(40, (rect.top + headH + edge - e.clientY) * 0.6 + 4);
      if (e.clientX > rect.left + vp.clientWidth - edge) dx = Math.min(40, (e.clientX - (rect.left + vp.clientWidth - edge)) * 0.6 + 4);
      else if (e.clientX < rect.left + gutterW + edge && drag.kind !== 'rows') dx = -Math.min(40, (rect.left + gutterW + edge - e.clientX) * 0.6 + 4);
      if (dx === 0 && dy === 0) return;
      vp.scrollBy(dx, dy);
      onScroll();
      extendDrag(e);
      autoScrollRaf = requestAnimationFrame(step);
    };
    autoScrollRaf = requestAnimationFrame(step);
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag) return;
    if (viewport?.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId);
    drag = null;
    lastPointer = null;
    if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf);
    autoScrollRaf = 0;
  }

  function onDblClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (target.closest('.resize')) {
      const c = Number(target.closest<HTMLElement>('.hcell')!.dataset.c);
      grid.widths[c] = fitColumn(c);
      return;
    }
    if (target.closest('.editor, .hinput')) return;
    const hit = hitTest(e);
    if (hit.kind === 'cell') {
      grid.select(hit.r, hit.c, false);
      grid.startEdit('edit');
    } else if (hit.kind === 'header' && doc.hasHeader) {
      grid.editingHeader = hit.c;
    }
  }

  function onContextMenu(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('.editor, .hinput')) return;
    e.preventDefault();
    const hit = hitTest(e);
    app.commitEdit?.();
    let items: MenuItem[] = [];
    if (hit.kind === 'cell') {
      if (!grid.contains(hit.r, hit.c)) grid.select(hit.r, hit.c, false);
      items = cellMenu();
    } else if (hit.kind === 'header') {
      if (!(fullCols && hit.c >= range.c0 && hit.c <= range.c1)) grid.selectCols(hit.c, hit.c);
      items = columnMenu();
    } else if (hit.kind === 'gutter') {
      if (!(fullRows && hit.r >= range.r0 && hit.r <= range.r1)) grid.selectRows(hit.r, hit.r);
      items = rowMenu();
    } else if (hit.kind === 'corner') {
      grid.selectAll();
      items = cellMenu();
    } else return;
    viewport?.focus({ preventScroll: true });
    app.openMenu({ x: e.clientX, y: e.clientY, items });
  }

  function rowWord(): string {
    return range.r1 > range.r0 ? `${range.r1 - range.r0 + 1} rows` : 'row';
  }
  function colWord(): string {
    return range.c1 > range.c0 ? `${range.c1 - range.c0 + 1} columns` : 'column';
  }

  function cellMenu(): MenuItem[] {
    return [
      { label: 'Cut', shortcut: 'Ctrl+X', run: () => app.cut() },
      { label: 'Copy', shortcut: 'Ctrl+C', run: () => app.copy() },
      { label: 'Paste', shortcut: 'Ctrl+V', run: () => app.paste() },
      { label: 'Clear', shortcut: 'Delete', run: () => app.clearSelection() },
      'sep',
      { label: 'Insert row above', shortcut: 'Ctrl+Shift+Enter', run: () => app.insertRows('above') },
      { label: 'Insert row below', shortcut: 'Ctrl+Enter', run: () => app.insertRows('below') },
      { label: `Delete ${rowWord()}`, shortcut: 'Ctrl+Shift+K', danger: true, run: () => app.deleteRows() },
      'sep',
      { label: 'Insert column left', run: () => app.insertColumn('left') },
      { label: 'Insert column right', run: () => app.insertColumn('right') },
      { label: `Delete ${colWord()}`, danger: true, run: () => app.deleteColumns() },
    ];
  }

  function rowMenu(): MenuItem[] {
    return [
      { label: 'Copy', shortcut: 'Ctrl+C', run: () => app.copy() },
      { label: 'Clear', shortcut: 'Delete', run: () => app.clearSelection() },
      'sep',
      { label: 'Insert row above', shortcut: 'Ctrl+Shift+Enter', run: () => app.insertRows('above') },
      { label: 'Insert row below', shortcut: 'Ctrl+Enter', run: () => app.insertRows('below') },
      'sep',
      { label: `Delete ${rowWord()}`, shortcut: 'Ctrl+Shift+K', danger: true, run: () => app.deleteRows() },
    ];
  }

  function columnMenu(): MenuItem[] {
    const c = range.c0;
    return [
      { label: 'Sort ascending', run: () => app.sort('asc') },
      { label: 'Sort descending', run: () => app.sort('desc') },
      'sep',
      doc.hasHeader
        ? { label: 'Rename column', run: () => (grid.editingHeader = c) }
        : { label: 'Use first row as header', run: () => app.toggleHeader() },
      { label: 'Fit width to content', run: () => app.autoFit?.(grid.selectedColIndices) },
      { label: 'Copy', shortcut: 'Ctrl+C', run: () => app.copy() },
      'sep',
      { label: 'Insert column left', run: () => app.insertColumn('left') },
      { label: 'Insert column right', run: () => app.insertColumn('right') },
      'sep',
      { label: `Delete ${colWord()}`, danger: true, run: () => app.deleteColumns() },
    ];
  }

  // ---------- keyboard ----------

  function onKeyDown(e: KeyboardEvent): void {
    if (app.menu || grid.editing || grid.editingHeader !== null) return;
    if (rowCount === 0 || colCount === 0) return;
    const ctrl = e.ctrlKey;
    const shift = e.shiftKey;
    const pageRows = Math.max(1, Math.floor((viewH - headH) / rowH) - 1);
    let handled = true;
    switch (e.key) {
      case 'ArrowUp':
        grid.move(-1, 0, shift, ctrl);
        break;
      case 'ArrowDown':
        grid.move(1, 0, shift, ctrl);
        break;
      case 'ArrowLeft':
        grid.move(0, -1, shift, ctrl);
        break;
      case 'ArrowRight':
        grid.move(0, 1, shift, ctrl);
        break;
      case 'Home':
        if (ctrl) grid.select(0, 0);
        else grid.move(0, -1, shift, true);
        break;
      case 'End':
        if (ctrl) grid.select(rowCount - 1, colCount - 1);
        else grid.move(0, 1, shift, true);
        break;
      case 'PageUp':
        grid.move(-pageRows, 0, shift);
        break;
      case 'PageDown':
        grid.move(pageRows, 0, shift);
        break;
      case 'Tab':
        grid.move(0, shift ? -1 : 1, false);
        break;
      case 'Enter':
        if (ctrl) return;
        grid.startEdit('edit');
        break;
      case 'F2':
        grid.startEdit('edit');
        break;
      case ' ':
        if (shift) grid.selectRows(range.r0, range.r1);
        else if (ctrl) grid.selectCols(range.c0, range.c1);
        else grid.startEdit('replace', ' ');
        break;
      case 'Escape':
        if (app.closeOverlays()) break;
        if (app.searchOpen) app.closeFind();
        else grid.select(grid.anchor.r, grid.anchor.c, false);
        break;
      default:
        if (!ctrl && !e.altKey && !e.metaKey && e.key.length === 1) {
          grid.startEdit('replace', e.key);
        } else handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  function onCopy(e: ClipboardEvent): void {
    if (grid.editing || grid.editingHeader !== null || rowCount === 0) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', app.selectionText());
    const n = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
    if (n > 1) app.toast(`Copied ${n} cells`);
  }

  function onCut(e: ClipboardEvent): void {
    if (grid.editing || grid.editingHeader !== null || rowCount === 0) return;
    e.preventDefault();
    e.clipboardData?.setData('text/plain', app.selectionText());
    app.clearSelection();
    const n = (range.r1 - range.r0 + 1) * (range.c1 - range.c0 + 1);
    app.toast(n > 1 ? `Cut ${n} cells` : 'Cut');
  }

  function onPaste(e: ClipboardEvent): void {
    if (grid.editing || grid.editingHeader !== null) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    e.preventDefault();
    app.pasteText(text);
  }

  // ---------- header rename ----------

  function commitHeader(): void {
    const c = grid.editingHeader;
    if (c === null) return;
    const value = headerInput?.value ?? doc.columns[c];
    grid.editingHeader = null;
    if (value.trim() !== '' && value !== doc.columns[c]) doc.renameColumn(c, value);
    viewport?.focus({ preventScroll: true });
  }
  app.commitHeader = commitHeader;
  function cancelHeader(): void {
    grid.editingHeader = null;
    viewport?.focus({ preventScroll: true });
  }
  function onHeaderKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commitHeader();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelHeader();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const c = grid.editingHeader ?? 0;
      commitHeader();
      const next = Math.min(colCount - 1, Math.max(0, c + (e.shiftKey ? -1 : 1)));
      grid.selectCols(next, next);
      grid.editingHeader = next;
    }
  }

  $effect(() => {
    if (grid.editingHeader !== null) {
      scrollIntoView({ r: Math.max(0, Math.floor(scrollTop / rowH)), c: grid.editingHeader });
      tick().then(() => {
        headerInput?.focus();
        headerInput?.select();
      });
    }
  });

  function display(v: string): string {
    return v.includes('\n') ? v.replaceAll('\r', '').replaceAll('\n', ' ↵ ') : v;
  }
</script>

<div
  class="viewport"
  class:mono={grid.mono}
  class:resizing={false}
  tabindex="0"
  role="grid"
  aria-rowcount={rowCount}
  aria-colcount={colCount}
  bind:this={viewport}
  bind:clientWidth={viewW}
  bind:clientHeight={viewH}
  style:--row-h="{rowH}px"
  style:--head-h="{headH}px"
  style:--gutter-w="{gutterW}px"
  style:--cell-font-size="{fontSize}px"
  onscroll={onScroll}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onpointerleave={() => (hoverRow = -1)}
  ondblclick={onDblClick}
  oncontextmenu={onContextMenu}
  onkeydown={onKeyDown}
  oncopy={onCopy}
  oncut={onCut}
  onpaste={onPaste}
>
  <div class="sizer" style:width="{sizerW}px" style:height="{sizerH}px">
    <div class="head" style:width="{gutterW + totalW}px">
      <div class="corner" class:all={fullRows && fullCols}></div>
      {#each visibleCols as c (c)}
        {@const w = colLefts[c + 1] - colLefts[c]}
        {@const inSel = c >= range.c0 && c <= range.c1}
        <div
          class="hcell"
          class:sel={inSel}
          class:full={inSel && fullCols}
          class:num={colTypes[c] === 'number'}
          class:editing={grid.editingHeader === c}
          data-c={c}
          style:left="{gutterW + colLefts[c]}px"
          style:width="{w}px"
        >
          {#if grid.editingHeader === c}
            <input
              class="hinput"
              bind:this={headerInput}
              value={doc.columns[c]}
              spellcheck="false"
              onkeydown={onHeaderKey}
              onblur={commitHeader}
            />
          {:else}
            <span class="hlabel" class:placeholder={!doc.hasHeader}>{headers[c]}</span>
          {/if}
          <div class="resize"></div>
        </div>
      {/each}
      <button
        class="addcol"
        style:left="{gutterW + totalW}px"
        title="Add column"
        tabindex="-1"
        onpointerdown={(e) => e.stopPropagation()}
        onclick={() => {
          grid.select(grid.anchor.r, Math.max(0, colCount - 1), false);
          app.insertColumn('right');
        }}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>

    {#each visibleRows as row (row.vr)}
      {@const rowSel = row.vr >= range.r0 && row.vr <= range.r1}
      <div
        class="row"
        class:hover={hoverRow === row.vr}
        style:top="{headH + row.vr * rowH}px"
        style:width="{gutterW + totalW}px"
      >
        <div class="gutter" class:sel={rowSel} class:full={rowSel && fullRows}>{row.dr + 1}</div>
        {#each visibleCols as c (c)}
          {@const v = row.cells[c] ?? ''}
          {@const key = cellKey(row.dr, c)}
          <div
            class="cell"
            class:num={colTypes[c] === 'number'}
            class:match={grid.matchSet.has(key)}
            class:cur={currentMatch !== null && currentMatch.r === row.dr && currentMatch.c === c}
            class:multi={v.includes('\n')}
            style:left="{gutterW + colLefts[c]}px"
            style:width="{colLefts[c + 1] - colLefts[c]}px"
          >{display(v)}</div>
        {/each}
      </div>
    {/each}

    <button
      class="addrow"
      style:top="{headH + totalH}px"
      style:width="{gutterW + totalW}px"
      tabindex="-1"
      onpointerdown={(e) => e.stopPropagation()}
      onclick={addRowAtEnd}
    >
      <span class="addrow-gutter"><Icon name="plus" size={14} /></span>
      <span class="addrow-label">Add row</span>
    </button>

    {#if selRect && !grid.isSingle}
      <div
        class="sel-rect"
        style:left="{selRect.left}px"
        style:top="{selRect.top}px"
        style:width="{selRect.width}px"
        style:height="{selRect.height}px"
      ></div>
    {/if}
    {#if activeRect}
      <div
        class="cursor"
        class:editing={grid.editing !== null}
        style:transform="translate({activeRect.left}px, {activeRect.top}px)"
        style:width="{activeRect.width}px"
        style:height="{activeRect.height}px"
      ></div>
    {/if}

    {#if grid.editing && activeRect}
      <CellEditor
        edit={grid.editing}
        left={activeRect.left}
        top={activeRect.top}
        width={activeRect.width}
        height={activeRect.height}
        onDone={() => viewport?.focus({ preventScroll: true })}
      />
    {/if}
  </div>
</div>

<style>
  .viewport {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: auto;
    background: var(--paper);
    font-size: var(--cell-font-size);
    outline: none;
    contain: strict;
    overscroll-behavior: contain;
  }
  .viewport.mono .cell,
  .viewport.mono .hinput {
    font-family: var(--font-mono);
  }
  .sizer {
    position: relative;
  }

  .head {
    position: sticky;
    top: 0;
    z-index: 3;
    height: var(--head-h);
    background: var(--paper);
    box-shadow: inset 0 -1px 0 var(--line-strong);
  }
  .corner {
    position: sticky;
    left: 0;
    z-index: 4;
    display: block;
    width: var(--gutter-w);
    height: var(--head-h);
    background: var(--paper);
    box-shadow: inset -1px -1px 0 var(--line-strong);
  }
  .corner.all {
    background: var(--paper-3);
  }
  .hcell {
    position: absolute;
    top: 0;
    height: var(--head-h);
    display: flex;
    align-items: center;
    padding: 0 10px;
    font-weight: 500;
    color: var(--ink-2);
    background: var(--paper);
    box-shadow: inset -1px 0 0 var(--line), inset 0 -1px 0 var(--line-strong);
    white-space: nowrap;
    overflow: hidden;
    transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);
  }
  .hcell.num {
    justify-content: flex-end;
  }
  .hcell.sel {
    color: var(--ink);
    background: var(--paper-2);
  }
  .hcell.full {
    background: var(--accent-soft-2);
    box-shadow: inset -1px 0 0 var(--line), inset 0 -2px 0 var(--accent);
  }
  .hlabel {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hlabel.placeholder {
    color: var(--ink-3);
    font-family: var(--font-mono);
    font-weight: 400;
    letter-spacing: 0.02em;
  }
  .hinput {
    width: 100%;
    height: calc(var(--head-h) - 8px);
    padding: 0 6px;
    margin: 0 -6px;
    border: 0;
    border-radius: 4px;
    background: var(--sheet);
    box-shadow: 0 0 0 2px var(--accent);
    font-weight: 500;
    color: var(--ink);
  }
  .resize {
    position: absolute;
    top: 0;
    right: -4px;
    width: 9px;
    height: 100%;
    cursor: col-resize;
    z-index: 1;
  }
  .resize::after {
    content: '';
    position: absolute;
    top: 25%;
    bottom: 25%;
    left: 3px;
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease-out);
  }
  .resize:hover::after {
    opacity: 1;
  }
  .addcol {
    position: absolute;
    top: 0;
    height: var(--head-h);
    width: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--ink-4);
    transition: color var(--t-fast) var(--ease-out), background var(--t-fast) var(--ease-out);
  }
  .addcol:hover {
    color: var(--accent);
    background: var(--accent-soft);
  }

  .row {
    position: absolute;
    left: 0;
    height: var(--row-h);
  }
  .row.hover .cell {
    background-color: var(--sheet-hover);
  }
  .gutter {
    position: sticky;
    left: 0;
    z-index: 2;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    width: var(--gutter-w);
    height: var(--row-h);
    padding-right: 9px;
    font-family: var(--font-mono);
    font-size: calc(var(--cell-font-size) - 1.5px);
    color: var(--ink-3);
    background: var(--paper);
    box-shadow: inset -1px 0 0 var(--line-strong), inset 0 -1px 0 var(--line);
    transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);
  }
  .row.hover .gutter {
    color: var(--ink-2);
  }
  .gutter.sel {
    color: var(--ink);
    background: var(--paper-2);
  }
  .gutter.full {
    background: var(--accent-soft-2);
    box-shadow: inset -2px 0 0 var(--accent), inset 0 -1px 0 var(--line);
  }
  .cell {
    position: absolute;
    top: 0;
    height: var(--row-h);
    padding: 0 10px;
    line-height: var(--row-h);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--ink);
    background-color: var(--sheet);
    box-shadow: inset -1px 0 0 var(--line), inset 0 -1px 0 var(--line);
  }
  .cell.num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .cell.multi {
    color: var(--ink);
  }
  .cell.match {
    background-color: var(--mark);
    color: var(--mark-ink);
  }
  .cell.cur {
    background-color: var(--mark-strong);
    color: var(--mark-ink);
  }
  :global(:root[data-theme='dark']) .cell.match,
  :global(:root[data-theme='dark']) .cell.cur {
    color: var(--ink);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme='light'])) .cell.match {
      color: var(--ink);
    }
    :global(:root:not([data-theme='light'])) .cell.cur {
      color: var(--mark-ink);
    }
  }

  .addrow {
    position: absolute;
    left: 0;
    height: var(--row-h);
    display: flex;
    align-items: center;
    color: var(--ink-4);
    transition: color var(--t-fast) var(--ease-out);
  }
  .addrow-gutter {
    position: sticky;
    left: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--gutter-w);
    height: var(--row-h);
    background: var(--paper);
    box-shadow: inset -1px 0 0 var(--line-strong);
  }
  .addrow-label {
    position: sticky;
    left: var(--gutter-w);
    padding: 0 10px;
    font-size: 12px;
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease-out);
  }
  .addrow:hover {
    color: var(--accent);
  }
  .addrow:hover .addrow-gutter {
    background: var(--accent-soft);
  }
  .addrow:hover .addrow-label {
    opacity: 1;
  }

  .sel-rect {
    position: absolute;
    z-index: 1;
    pointer-events: none;
    background: var(--select-fill);
    box-shadow: inset 0 0 0 1px var(--select-line);
  }
  .cursor {
    position: absolute;
    left: 0;
    top: 0;
    z-index: 1;
    pointer-events: none;
    box-shadow: inset 0 0 0 2px var(--cursor);
    transition: transform 70ms var(--ease-out), width 70ms var(--ease-out), height 70ms var(--ease-out);
    will-change: transform;
  }
  .cursor.editing {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .viewport:not(:focus-within) .cursor {
    box-shadow: inset 0 0 0 2px color-mix(in oklch, var(--cursor) 45%, transparent);
  }
</style>
