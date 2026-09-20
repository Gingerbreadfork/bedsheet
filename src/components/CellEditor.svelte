<script lang="ts">
  import { tick } from 'svelte';
  import { app } from '../lib/app.svelte';
  import type { EditState } from '../lib/grid.svelte';

  let {
    edit,
    left,
    top,
    width,
    height,
    onDone,
  }: { edit: EditState; left: number; top: number; width: number; height: number; onDone: () => void } = $props();

  const { doc, grid } = app;
  let el = $state<HTMLTextAreaElement>();
  // svelte-ignore state_referenced_locally
  let value = $state(edit.initial);
  let done = false;
  let ctx: CanvasRenderingContext2D | null = null;

  function textWidth(text: string): number {
    if (!el) return 0;
    if (!ctx) ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return 0;
    const cs = getComputedStyle(el);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let w = 0;
    for (const line of text.split('\n')) w = Math.max(w, ctx.measureText(line).width);
    return w;
  }

  let lines = $derived(value.split('\n').length);
  let boxWidth = $derived.by(() => {
    void el;
    const needed = Math.ceil(textWidth(value) + 24);
    return Math.min(720, Math.max(width, needed));
  });
  let boxHeight = $derived(Math.max(height, Math.min(8, lines) * height));

  function finish(save: boolean, move?: [number, number]): void {
    if (done) return;
    done = true;
    const { r, c } = edit;
    grid.editing = null;
    if (save) doc.setCell(grid.dataRow(r), c, value.replaceAll('\r\n', '\n'));
    if (move) grid.move(move[0], move[1], false);
    onDone();
  }
  app.commitEdit = () => finish(true);

  function onKey(e: KeyboardEvent): void {
    const replaceMode = edit.mode === 'replace';
    switch (e.key) {
      case 'Enter':
        e.stopPropagation();
        e.preventDefault();
        if (e.altKey) insertNewline();
        else if (e.ctrlKey) finish(true);
        else finish(true, [e.shiftKey ? -1 : 1, 0]);
        return;
      case 'Tab':
        e.stopPropagation();
        e.preventDefault();
        finish(true, [0, e.shiftKey ? -1 : 1]);
        return;
      case 'Escape':
        e.stopPropagation();
        e.preventDefault();
        finish(false);
        return;
      case 'ArrowUp':
      case 'ArrowDown':
        if (replaceMode || lines === 1) {
          e.stopPropagation();
          e.preventDefault();
          finish(true, [e.key === 'ArrowUp' ? -1 : 1, 0]);
        }
        return;
      case 'ArrowLeft':
      case 'ArrowRight':
        if (replaceMode) {
          e.stopPropagation();
          e.preventDefault();
          finish(true, [0, e.key === 'ArrowLeft' ? -1 : 1]);
        }
        return;
    }
  }

  function insertNewline(): void {
    const t = el;
    if (!t) return;
    const s = t.selectionStart;
    const end = t.selectionEnd;
    value = value.slice(0, s) + '\n' + value.slice(end);
    tick().then(() => t.setSelectionRange(s + 1, s + 1));
  }

  $effect(() => {
    const t = el;
    if (!t) return;
    t.focus({ preventScroll: true });
    const len = t.value.length;
    t.setSelectionRange(len, len);
  });
</script>

<div
  class="editor"
  class:multi={lines > 1}
  style:left="{left}px"
  style:top="{top}px"
  style:width="{boxWidth}px"
  style:height="{boxHeight}px"
>
  <textarea
    bind:this={el}
    bind:value
    spellcheck="false"
    autocomplete="off"
    onkeydown={onKey}
    onblur={() => finish(true)}
    onpointerdown={(e) => e.stopPropagation()}
  ></textarea>
</div>

<style>
  .editor {
    position: absolute;
    z-index: 3;
    background: var(--sheet);
    box-shadow: inset 0 0 0 2px var(--accent), 0 8px 24px -8px oklch(20% 0.02 150 / 0.4);
  }
  textarea {
    display: block;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0 10px;
    border: 0;
    resize: none;
    background: transparent;
    color: var(--ink);
    font: inherit;
    line-height: var(--row-h);
    white-space: pre;
    overflow: hidden;
    outline: none;
  }
  .editor.multi textarea {
    overflow-y: auto;
  }
</style>
