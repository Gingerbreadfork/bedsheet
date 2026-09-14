<script lang="ts">
  import { app } from '../lib/app.svelte';
  import Icon from './Icon.svelte';

  const { grid } = app;
  let input = $state<HTMLInputElement>();
  let replaceInput = $state<HTMLInputElement>();

  let n = $derived(grid.matches.length);
  let countText = $derived.by(() => {
    if (!app.query) return '';
    if (n === 0) return 'No matches';
    if (grid.matchIndex >= 0) return `${grid.matchIndex + 1} of ${n.toLocaleString()}`;
    return `${n.toLocaleString()} ${n === 1 ? 'match' : 'matches'}`;
  });

  $effect(() => {
    app.focusSearch = (select) => {
      input?.focus();
      if (select) input?.select();
    };
    app.focusReplace = () => {
      replaceInput?.focus();
      replaceInput?.select();
    };
    input?.focus();
    input?.select();
    return () => {
      app.focusSearch = null;
      app.focusReplace = null;
    };
  });

  $effect(() => {
    if (app.replaceOpen) replaceInput?.focus();
  });

  function onFindKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      app.stepMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      app.closeFind();
    }
  }

  function onReplaceKey(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.ctrlKey) app.replaceAll();
      else app.replaceCurrent();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      app.closeFind();
    }
  }
</script>

<div class="findbar">
  <div class="field">
    <span class="ico"><Icon name="search" size={15} /></span>
    <input
      bind:this={input}
      type="text"
      placeholder="Find in sheet"
      spellcheck="false"
      autocomplete="off"
      value={app.query}
      oninput={(e) => app.setQuery(e.currentTarget.value)}
      onkeydown={onFindKey}
    />
    <span class="count" class:none={app.query && n === 0}>{countText}</span>
    <button class="tog" class:on={app.matchCase} title="Match case" onclick={() => app.toggleMatchCase()}>
      <Icon name="caseSensitive" size={15} />
    </button>
  </div>
  <div class="nav">
    <button class="icon-btn" title="Previous match (Shift+Enter)" disabled={n === 0} onclick={() => app.stepMatch(-1)}>
      <Icon name="chevronUp" />
    </button>
    <button class="icon-btn" title="Next match (Enter)" disabled={n === 0} onclick={() => app.stepMatch(1)}>
      <Icon name="chevronDown" />
    </button>
  </div>
  <button class="chip" class:on={app.filterRows} disabled={!app.query} onclick={() => app.toggleFilterRows()}>
    <Icon name="filter" size={14} />
    Only matching rows
  </button>
  <button class="chip" class:on={app.replaceOpen} onclick={() => (app.replaceOpen = !app.replaceOpen)}>
    <Icon name="replace" size={14} />
    Replace
  </button>
  {#if app.replaceOpen}
    <div class="field replace">
      <input
        bind:this={replaceInput}
        type="text"
        placeholder="Replace with"
        spellcheck="false"
        autocomplete="off"
        bind:value={app.replaceWith}
        onkeydown={onReplaceKey}
      />
    </div>
    <button class="btn small" disabled={n === 0} onclick={() => app.replaceCurrent()}>Replace</button>
    <button class="btn small" disabled={n === 0} title="Replace all (Ctrl+Enter)" onclick={() => app.replaceAll()}>All</button>
  {/if}
  <span class="spacer"></span>
  <button class="icon-btn" title="Close (Esc)" onclick={() => app.closeFind()}>
    <Icon name="close" />
  </button>
</div>

<style>
  .findbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    min-height: 42px;
    padding: 5px 10px;
    background: var(--paper);
    border-bottom: 1px solid var(--line-strong);
    flex: none;
    animation: drop 140ms var(--ease-out);
  }
  @keyframes drop {
    from {
      opacity: 0;
      transform: translateY(-6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  .field {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 30px;
    flex: 1 1 220px;
    max-width: 320px;
    min-width: 180px;
    padding: 0 6px 0 8px;
    border-radius: 6px;
    background: var(--sheet);
    border: 1px solid var(--line-strong);
    transition: border-color var(--t-fast) var(--ease-out), box-shadow var(--t-fast) var(--ease-out);
  }
  .field:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .field.replace {
    flex-basis: 160px;
    max-width: 240px;
    min-width: 140px;
    padding-left: 10px;
  }
  .ico {
    display: flex;
    color: var(--ink-3);
  }
  .field input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    outline: none;
    padding: 0;
  }
  .field input::placeholder {
    color: var(--ink-3);
  }
  .count {
    font-size: 12px;
    color: var(--ink-3);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .count.none {
    color: var(--danger);
  }
  .tog {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: 4px;
    color: var(--ink-3);
  }
  .tog:hover {
    background: var(--paper-2);
    color: var(--ink);
  }
  .tog.on {
    background: var(--accent-soft-2);
    color: var(--accent);
  }
  .nav {
    display: flex;
    gap: 0;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 10px;
    border-radius: 6px;
    color: var(--ink-2);
    font-weight: 500;
    white-space: nowrap;
    transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);
  }
  .chip:hover {
    background: var(--paper-3);
    color: var(--ink);
  }
  .chip:disabled {
    opacity: 0.4;
    pointer-events: none;
  }
  .chip.on {
    background: var(--accent-soft-2);
    color: var(--accent);
  }
  .btn.small {
    height: 28px;
    padding: 0 10px;
  }
  .btn:disabled {
    opacity: 0.45;
    pointer-events: none;
  }
  .spacer {
    flex: 1;
  }
</style>
