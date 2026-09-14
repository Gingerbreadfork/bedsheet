<script lang="ts">
  import { tick } from 'svelte';
  import { app, type CommandDef, type Group } from '../lib/app.svelte';
  import { shortcutKeys } from '../lib/keys';
  import Icon from './Icon.svelte';

  const GROUP_ORDER: Group[] = ['File', 'Edit', 'Rows', 'Columns', 'Find', 'View', 'Help'];

  let query = $state('');
  let index = $state(0);
  let input = $state<HTMLInputElement>();
  let list = $state<HTMLUListElement>();

  interface Item {
    cmd: CommandDef;
    title: string;
    score: number;
    hits: number[];
  }

  function fuzzy(q: string, text: string): { score: number; hits: number[] } | null {
    const t = text.toLowerCase();
    const hits: number[] = [];
    let ti = 0;
    let score = 0;
    let streak = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      if (ch === ' ') continue;
      const found = t.indexOf(ch, ti);
      if (found < 0) return null;
      const wordStart = found === 0 || t[found - 1] === ' ' || t[found - 1] === ':';
      streak = found === ti ? streak + 1 : 0;
      score += 1 + (wordStart ? 3 : 0) + streak * 2 - (found - ti) * 0.1;
      hits.push(found);
      ti = found + 1;
    }
    if (t.startsWith(q)) score += 6;
    return { score, hits };
  }

  let items = $derived.by(() => {
    void app.doc.rev;
    const q = query.trim().toLowerCase();
    const out: Item[] = [];
    for (const cmd of app.commands) {
      if (cmd.when && !cmd.when()) continue;
      const title = app.title(cmd);
      if (!q) {
        out.push({ cmd, title, score: 0, hits: [] });
        continue;
      }
      const m = fuzzy(q, `${title} ${cmd.group}`);
      if (m) out.push({ cmd, title, score: m.score, hits: m.hits.filter((h) => h < title.length) });
    }
    if (q) out.sort((a, b) => b.score - a.score);
    else out.sort((a, b) => GROUP_ORDER.indexOf(a.cmd.group) - GROUP_ORDER.indexOf(b.cmd.group));
    return out;
  });

  $effect(() => {
    void items;
    index = 0;
  });

  $effect(() => {
    input?.focus();
  });

  function run(cmd: CommandDef): void {
    app.paletteOpen = false;
    app.grid.focusGrid?.();
    void cmd.run();
  }

  async function moveIndex(d: number): Promise<void> {
    if (items.length === 0) return;
    index = (index + d + items.length) % items.length;
    await tick();
    list?.querySelector<HTMLElement>('.item.active')?.scrollIntoView({ block: 'nearest' });
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      void moveIndex(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      void moveIndex(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[index];
      if (it) run(it.cmd);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      app.paletteOpen = false;
      app.grid.focusGrid?.();
    }
  }

  function segments(title: string, hits: number[]): { text: string; hit: boolean }[] {
    if (hits.length === 0) return [{ text: title, hit: false }];
    const set = new Set(hits);
    const out: { text: string; hit: boolean }[] = [];
    for (let i = 0; i < title.length; i++) {
      const hit = set.has(i);
      const last = out[out.length - 1];
      if (last && last.hit === hit) last.text += title[i];
      else out.push({ text: title[i], hit });
    }
    return out;
  }
</script>

<div
  class="scrim"
  role="presentation"
  onpointerdown={() => {
    app.paletteOpen = false;
    app.grid.focusGrid?.();
  }}
>
  <div class="panel" role="dialog" tabindex="-1" aria-label="Command palette" onpointerdown={(e) => e.stopPropagation()}>
    <div class="input-row">
      <span class="ico"><Icon name="palette" size={16} /></span>
      <input bind:this={input} bind:value={query} placeholder="What do you want to do?" spellcheck="false" autocomplete="off" onkeydown={onKey} />
      <kbd>Esc</kbd>
    </div>
    <ul class="list" bind:this={list}>
      {#each items as it, i (it.cmd.id)}
        {#if !query && (i === 0 || items[i - 1].cmd.group !== it.cmd.group)}
          <li class="group">{it.cmd.group}</li>
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <li
          class="item"
          class:active={i === index}
          role="option"
          aria-selected={i === index}
          onpointermove={() => (index = i)}
          onclick={() => run(it.cmd)}
        >
          <span class="label">
            {#each segments(it.title, it.hits) as seg, k (k)}
              {#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}
            {/each}
          </span>
          {#if query}
            <span class="grp">{it.cmd.group}</span>
          {/if}
          {#if it.cmd.shortcut}
            <span class="keys">
              {#each shortcutKeys(it.cmd.shortcut) as k, j (j)}<kbd>{k}</kbd>{/each}
            </span>
          {/if}
        </li>
      {/each}
      {#if items.length === 0}
        <li class="empty">No commands match “{query}”</li>
      {/if}
    </ul>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    background: var(--scrim);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    animation: fade 120ms var(--ease-out);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .panel {
    width: min(560px, calc(100vw - 32px));
    max-height: 70vh;
    display: flex;
    flex-direction: column;
    background: var(--popover);
    border-radius: 10px;
    box-shadow: var(--shadow-modal);
    overflow: hidden;
    animation: pop 160ms var(--ease-spring);
    transform-origin: top center;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.97) translateY(-8px);
    }
  }
  .input-row {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 48px;
    padding: 0 14px;
    border-bottom: 1px solid var(--line);
  }
  .ico {
    display: flex;
    color: var(--ink-3);
  }
  input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    font-size: 15px;
    outline: none;
  }
  input::placeholder {
    color: var(--ink-3);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
  }
  .group {
    padding: 10px 10px 4px;
    font-size: 11px;
    font-weight: 500;
    color: var(--ink-3);
  }
  .group:first-child {
    padding-top: 4px;
  }
  .item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 34px;
    padding: 0 10px;
    border-radius: 6px;
    color: var(--ink);
  }
  .item.active {
    background: var(--accent-soft);
  }
  .label {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .label mark {
    background: transparent;
    color: var(--accent);
    font-weight: 600;
  }
  .grp {
    font-size: 11px;
    color: var(--ink-3);
  }
  .empty {
    padding: 22px 10px;
    text-align: center;
    color: var(--ink-3);
  }
</style>
