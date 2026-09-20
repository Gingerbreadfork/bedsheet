<script lang="ts">
  import { app, type Group } from '../lib/app.svelte';
  import { shortcutKeys } from '../lib/keys';
  import Icon from './Icon.svelte';

  const ORDER: Group[] = ['File', 'Edit', 'Rows', 'Columns', 'Find', 'View', 'Help'];

  const NAV: { title: string; keys: string }[] = [
    { title: 'Move between cells', keys: 'ArrowUp' },
    { title: 'Extend selection', keys: 'Shift+ArrowDown' },
    { title: 'Jump to edge of sheet', keys: 'Ctrl+ArrowRight' },
    { title: 'Next / previous cell', keys: 'Tab' },
    { title: 'Edit cell', keys: 'Enter' },
    { title: 'Edit cell (alternative)', keys: 'F2' },
    { title: 'Start typing to replace', keys: 'A' },
    { title: 'New line inside a cell', keys: 'Alt+Enter' },
    { title: 'Cancel edit', keys: 'Escape' },
    { title: 'Select row', keys: 'Shift+Space' },
    { title: 'Select column', keys: 'Ctrl+Space' },
    { title: 'Top / bottom of sheet', keys: 'Ctrl+Home' },
    { title: 'Onto the column headers, from the first row', keys: 'ArrowUp' },
    { title: 'Rename the focused header', keys: 'Enter' },
  ];

  let groups = $derived(
    ORDER.map((g) => ({
      name: g,
      items: app.commands.filter((c) => c.group === g && c.shortcut).map((c) => ({ title: app.title(c), keys: c.shortcut! })),
    })).filter((g) => g.items.length > 0),
  );

  function close(): void {
    app.shortcutsOpen = false;
    app.grid.focusGrid?.();
  }
</script>

<div class="scrim" role="presentation" onpointerdown={close}>
  <div class="panel" role="dialog" tabindex="-1" aria-label="Keyboard shortcuts" onpointerdown={(e) => e.stopPropagation()}>
    <div class="head">
      <h2>Keyboard shortcuts</h2>
      <button class="icon-btn" onclick={close} title="Close (Esc)"><Icon name="close" /></button>
    </div>
    <div class="cols">
      <section>
        <h3>Navigating the grid</h3>
        {#each NAV as it (it.title)}
          <div class="row">
            <span>{it.title}</span>
            <span class="keys">{#each shortcutKeys(it.keys) as k, j (j)}<kbd>{k}</kbd>{/each}</span>
          </div>
        {/each}
      </section>
      {#each groups as g (g.name)}
        <section>
          <h3>{g.name}</h3>
          {#each g.items as it (it.title)}
            <div class="row">
              <span>{it.title}</span>
              <span class="keys">{#each shortcutKeys(it.keys) as k, j (j)}<kbd>{k}</kbd>{/each}</span>
            </div>
          {/each}
        </section>
      {/each}
    </div>
  </div>
</div>

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--scrim);
    animation: fade 120ms var(--ease-out);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  .panel {
    width: min(760px, calc(100vw - 40px));
    max-height: calc(100vh - 80px);
    display: flex;
    flex-direction: column;
    background: var(--popover);
    border-radius: 12px;
    box-shadow: var(--shadow-modal);
    animation: pop 180ms var(--ease-spring);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 16px 12px 22px;
    border-bottom: 1px solid var(--line);
  }
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .cols {
    columns: 2;
    column-gap: 32px;
    padding: 12px 22px 20px;
    overflow-y: auto;
  }
  section {
    break-inside: avoid;
    margin-bottom: 18px;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 12px;
    font-weight: 500;
    color: var(--ink-3);
  }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    height: 28px;
    color: var(--ink);
  }
  @media (max-width: 640px) {
    .cols {
      columns: 1;
    }
  }
</style>
