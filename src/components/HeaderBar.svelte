<script lang="ts">
  import { app, type MenuItem } from '../lib/app.svelte';
  import { isTauri, win } from '../lib/platform';
  import Icon from './Icon.svelte';

  const { doc } = app;

  function openMenu(e: MouseEvent): void {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const items: MenuItem[] = [
      { label: 'New sheet', shortcut: 'Ctrl+N', run: () => app.newSheet() },
      { label: 'Open file…', shortcut: 'Ctrl+O', run: () => app.open() },
      ...app.recent.slice(0, 5).map((r) => ({ label: r.name, run: () => app.openPath(r.path) })),
      { label: 'Save', shortcut: 'Ctrl+S', disabled: !doc.loaded, run: () => app.save(false) },
      { label: 'Save as…', shortcut: 'Ctrl+Shift+S', disabled: !doc.loaded, run: () => app.save(true) },
      { label: 'Close file', shortcut: 'Ctrl+W', disabled: !doc.loaded, run: () => app.closeFile() },
      'sep',
      { label: 'Find', shortcut: 'Ctrl+F', disabled: !doc.loaded, run: () => app.openFind(false) },
      { label: 'Find and replace', shortcut: 'Ctrl+H', disabled: !doc.loaded, run: () => app.openFind(true) },
      'sep',
      { label: 'Theme: match system', checked: app.theme === 'system', run: () => app.setTheme('system') },
      { label: 'Theme: light', checked: app.theme === 'light', run: () => app.setTheme('light') },
      { label: 'Theme: dark', checked: app.theme === 'dark', run: () => app.setTheme('dark') },
      'sep',
      { label: 'Command palette', shortcut: 'Ctrl+K', run: () => (app.paletteOpen = true) },
      { label: 'Keyboard shortcuts', shortcut: 'Ctrl+/', run: () => (app.shortcutsOpen = true) },
    ];
    if (isTauri) items.push('sep', { label: 'Quit', shortcut: 'Ctrl+Q', run: () => app.quit() });
    app.openMenu({ x: r.right, y: r.bottom + 4, align: 'right', width: 248, items });
  }
</script>

<header class="bar" data-tauri-drag-region>
  <div class="side" data-tauri-drag-region>
    <div class="mark" title="Bedsheet">
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M3 8.5a6 6 0 0 1 12 0V16l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L3 16Z" fill="var(--sheet)" stroke="var(--ink-2)" stroke-width="1.25" stroke-linejoin="round" />
        <path d="M3 11h12M7.2 3.2v10.6M10.8 3.2v10.6" stroke="var(--line-strong)" stroke-width="1" />
        <rect x="5" y="7" width="2.6" height="2.6" fill="var(--ink)" />
        <rect x="10.4" y="7" width="2.6" height="2.6" fill="var(--ink)" />
      </svg>
    </div>
    <div class="group">
      <button class="icon-btn" title="Undo (Ctrl+Z)" disabled={!doc.canUndo} onclick={() => app.undo()}>
        <Icon name="undo" />
      </button>
      <button class="icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={!doc.canRedo} onclick={() => app.redo()}>
        <Icon name="redo" />
      </button>
    </div>
  </div>

  <div class="title" data-tauri-drag-region>
    {#if doc.loaded}
      <span class="name" title={doc.path ?? doc.name} data-tauri-drag-region>{doc.name}</span>
      {#if doc.dirty}
        <span class="dirty" title="Unsaved changes"></span>
      {/if}
    {:else}
      <span class="name quiet" data-tauri-drag-region>Bedsheet</span>
    {/if}
  </div>

  <div class="side right" data-tauri-drag-region>
    {#if doc.loaded}
      <button class="icon-btn" title="Find (Ctrl+F)" onclick={() => app.openFind(false)}>
        <Icon name="search" />
      </button>
    {/if}
    <button class="icon-btn" title="Menu" onclick={openMenu}>
      <Icon name="dots" />
    </button>
    {#if isTauri}
      <div class="wc">
        <button class="wc-btn" title="Minimize" onclick={() => win.minimize()}><Icon name="minimize" size={14} /></button>
        <button class="wc-btn" title={app.maximized ? 'Restore' : 'Maximize'} onclick={() => win.toggleMaximize()}>
          <Icon name={app.maximized ? 'restore' : 'maximize'} size={13} />
        </button>
        <button class="wc-btn close" title="Close" onclick={() => app.quit()}><Icon name="close" size={14} /></button>
      </div>
    {/if}
  </div>
</header>

<style>
  .bar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    height: 44px;
    padding: 0 10px;
    background: var(--paper);
    border-bottom: 1px solid var(--line-strong);
    flex: none;
  }
  .side {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 100%;
  }
  .side.right {
    justify-content: flex-end;
  }
  .mark {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    margin-right: 2px;
  }
  .group {
    display: flex;
    gap: 2px;
  }
  .title {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    height: 100%;
    padding: 0 12px;
  }
  .name {
    font-weight: 500;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 48vw;
  }
  .name.quiet {
    color: var(--ink-3);
    font-weight: 500;
    letter-spacing: 0.01em;
  }
  .dirty {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
    flex: none;
  }
  .wc {
    display: flex;
    gap: 2px;
    margin-left: 8px;
    padding-left: 10px;
    border-left: 1px solid var(--line-strong);
    height: 22px;
    align-items: center;
  }
  .wc-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    color: var(--ink-2);
    transition: background var(--t-fast) var(--ease-out), color var(--t-fast) var(--ease-out);
  }
  .wc-btn:hover {
    background: var(--paper-3);
    color: var(--ink);
  }
  .wc-btn.close:hover {
    background: var(--danger);
    color: #fff;
  }
</style>
