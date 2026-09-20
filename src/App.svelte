<script lang="ts">
  import { onMount } from 'svelte';
  import './styles/app.css';
  import { app } from './lib/app.svelte';
  import { isTauri, win, onFileDrop } from './lib/platform';
  import HeaderBar from './components/HeaderBar.svelte';
  import FindBar from './components/FindBar.svelte';
  import Grid from './components/Grid.svelte';
  import EmptyState from './components/EmptyState.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import Dialog from './components/Dialog.svelte';
  import GotoRow from './components/GotoRow.svelte';
  import Shortcuts from './components/Shortcuts.svelte';
  import Toasts from './components/Toasts.svelte';

  const { doc } = app;

  $effect(() => {
    const t = app.theme;
    if (t === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  });

  $effect(() => {
    const title = doc.loaded ? `${doc.dirty ? '• ' : ''}${doc.name} — bedsheet` : 'bedsheet';
    document.title = title;
    if (isTauri) void win.setTitle(title);
  });

  onMount(() => {
    const cleanups: (() => void)[] = [];
    if (isTauri) {
      cleanups.push(
        onFileDrop(
          (paths) => void app.handleDrop(paths),
          (h) => (app.dragHover = h),
        ),
      );
      void win.isMaximized().then((m) => (app.maximized = m));
      void win.onResized(() => void win.isMaximized().then((m) => (app.maximized = m))).then((u) => cleanups.push(u));
      void win
        .onCloseRequested((prevent) => {
          if (!doc.dirty) return;
          prevent();
          void app.quit();
        })
        .then((u) => cleanups.push(u));
      document.addEventListener('contextmenu', suppressNativeMenu);
      cleanups.push(() => document.removeEventListener('contextmenu', suppressNativeMenu));
    }
    void app.init();
    return () => cleanups.forEach((fn) => fn());
  });

  function suppressNativeMenu(e: MouseEvent): void {
    const t = e.target as HTMLElement;
    if (t.closest('input, textarea')) return;
    e.preventDefault();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (app.dialog) return;
    if (e.key === 'Escape' && app.closeOverlays()) {
      e.preventDefault();
      app.grid.focusGrid?.();
      return;
    }
    if (app.menu) return;
    app.handleKeydown(e);
  }

  function onDragOver(e: DragEvent): void {
    if (isTauri) return;
    e.preventDefault();
    app.dragHover = true;
  }
  function onDragLeave(e: DragEvent): void {
    if (isTauri) return;
    if (e.relatedTarget === null) app.dragHover = false;
  }
  function onDrop(e: DragEvent): void {
    if (isTauri) return;
    e.preventDefault();
    app.dragHover = false;
    if (e.dataTransfer?.files.length) void app.handleBrowserDrop(e.dataTransfer.files);
  }

  const EDGES = [
    ['n', 'North'],
    ['s', 'South'],
    ['e', 'East'],
    ['w', 'West'],
    ['ne', 'NorthEast'],
    ['nw', 'NorthWest'],
    ['se', 'SouthEast'],
    ['sw', 'SouthWest'],
  ] as const;
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="app"
  class:tauri={isTauri}
  class:maximized={app.maximized}
  role="application"
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
>
  <HeaderBar />
  {#if app.searchOpen && doc.loaded}
    <FindBar />
  {/if}
  <main>
    {#if doc.loaded}
      <Grid />
    {:else}
      <EmptyState />
    {/if}
    {#if app.busy}
      <div class="busy">
        <div class="busy-bar"></div>
        <div class="busy-text">{app.busy}…</div>
      </div>
    {/if}
  </main>
  <StatusBar />

  {#if app.paletteOpen}
    <CommandPalette />
  {/if}
  {#if app.gotoOpen}
    <GotoRow />
  {/if}
  {#if app.shortcutsOpen}
    <Shortcuts />
  {/if}
  <ContextMenu />
  <Dialog />
  <Toasts />

  {#if isTauri && !app.maximized}
    {#each EDGES as [cls, dir] (cls)}
      <div class="edge {cls}" role="presentation" onpointerdown={() => void win.startResize(dir)}></div>
    {/each}
  {/if}
</div>

<style>
  .app {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--paper);
    overflow: hidden;
  }
  .app.tauri {
    border-radius: var(--radius-window);
    box-shadow: inset 0 0 0 1px var(--frame);
  }
  .app.tauri.maximized {
    border-radius: 0;
    box-shadow: none;
  }
  main {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .busy {
    position: absolute;
    inset: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 14px;
    background: color-mix(in oklch, var(--sheet) 70%, transparent);
    backdrop-filter: blur(2px);
  }
  .busy-bar {
    width: 160px;
    height: 3px;
    border-radius: 2px;
    background: var(--line-strong);
    overflow: hidden;
    position: relative;
  }
  .busy-bar::after {
    content: '';
    position: absolute;
    inset: 0;
    width: 40%;
    border-radius: 2px;
    background: var(--accent);
    animation: slide 1s var(--ease-out) infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(260%);
    }
  }
  .busy-text {
    color: var(--ink-2);
    font-weight: 500;
  }
  .edge {
    position: absolute;
    z-index: 90;
  }
  .edge.n,
  .edge.s {
    left: 6px;
    right: 6px;
    height: 5px;
    cursor: ns-resize;
  }
  .edge.n {
    top: 0;
  }
  .edge.s {
    bottom: 0;
  }
  .edge.e,
  .edge.w {
    top: 6px;
    bottom: 6px;
    width: 5px;
    cursor: ew-resize;
  }
  .edge.e {
    right: 0;
  }
  .edge.w {
    left: 0;
  }
  .edge.ne,
  .edge.nw,
  .edge.se,
  .edge.sw {
    width: 10px;
    height: 10px;
  }
  .edge.ne {
    top: 0;
    right: 0;
    cursor: nesw-resize;
  }
  .edge.nw {
    top: 0;
    left: 0;
    cursor: nwse-resize;
  }
  .edge.se {
    bottom: 0;
    right: 0;
    cursor: nwse-resize;
  }
  .edge.sw {
    bottom: 0;
    left: 0;
    cursor: nesw-resize;
  }
</style>
