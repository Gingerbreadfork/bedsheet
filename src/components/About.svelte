<script lang="ts">
  import { app } from '../lib/app.svelte';
  import Icon from './Icon.svelte';

  const version = __APP_VERSION__;

  let checking = $state(false);

  function close(e?: Event): void {
    e?.preventDefault();
    app.aboutOpen = false;
    app.grid.focusGrid?.();
  }

  async function check(): Promise<void> {
    checking = true;
    try {
      await app.checkForUpdates();
    } finally {
      checking = false;
    }
  }

  /** Keeps Tab among the box's own controls. */
  function onKey(e: KeyboardEvent & { currentTarget: HTMLElement }): void {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input'));
    if (controls.length === 0) return;
    const i = controls.indexOf(document.activeElement as HTMLElement);
    const next = i < 0 && e.shiftKey ? controls.length - 1 : i + (e.shiftKey ? -1 : 1);
    controls[(next + controls.length) % controls.length].focus();
  }
</script>

<div class="scrim" role="presentation" onpointerdown={close}>
  <div
    class="panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="about-title"
    tabindex="-1"
    onpointerdown={(e) => e.stopPropagation()}
    onkeydown={onKey}
    {@attach (box) => box.focus()}
  >
    <button class="icon-btn close" onclick={close} title="Close (Esc)"><Icon name="close" /></button>

    <div class="head">
      <img src="/app-icon.svg" alt="" width="64" height="64" />
      <div>
        <h2 id="about-title">Bedsheet</h2>
        <p>A fast, focused editor and reader for CSV and other delimited text files.</p>
      </div>
    </div>

    <div class="facts">
      <div class="fact">
        <span class="label">Version</span>
        <span class="value mono">{version}</span>
        {#if app.updateProgress !== null}
          <span class="note" role="status">Downloading update {Math.round(app.updateProgress * 100)}%</span>
        {:else if app.newRelease}
          <button class="btn primary" onclick={() => app.getUpdate()}>{app.updateLabel}</button>
        {:else if app.updatable}
          <button class="btn" disabled={checking} onclick={check}>{checking ? 'Checking…' : 'Check for updates'}</button>
        {:else if app.flatpak}
          <span class="note">Kept up to date by Flatpak</span>
        {/if}
      </div>
      <button class="fact" onclick={() => app.openPage()}>
        <span class="label">Source</span>
        <span class="value mono">github.com/Gingerbreadfork/bedsheet</span>
        <span class="out"><Icon name="external" size={14} /></span>
      </button>
      <button class="fact" onclick={() => app.openPage('releases')}>
        <span class="label">Releases</span>
        <span class="value">Earlier versions and what changed</span>
        <span class="out"><Icon name="external" size={14} /></span>
      </button>
      <button class="fact" onclick={() => app.openPage('issues')}>
        <span class="label">Problems</span>
        <span class="value">Report one, or see what is known</span>
        <span class="out"><Icon name="external" size={14} /></span>
      </button>
      <button class="fact" onclick={() => app.openPage('blob/main/LICENSE')}>
        <span class="label">License</span>
        <span class="value">MIT, free and open source</span>
        <span class="out"><Icon name="external" size={14} /></span>
      </button>
    </div>

    {#if app.updatable}
      <label class="auto">
        <input type="checkbox" checked={app.autoUpdates} onchange={() => app.toggleAutoUpdates(false)} />
        <span>
          Check for updates automatically
          <small>
            When Bedsheet starts and every twelve hours while it runs. It asks GitHub for the latest version number and sends
            nothing about you or your files.
          </small>
        </span>
      </label>
    {/if}

    <p class="colophon">Built with Tauri and Svelte. Set in IBM Plex.</p>
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
    position: relative;
    width: min(460px, calc(100vw - 32px));
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    background: var(--popover);
    border-radius: 12px;
    box-shadow: var(--shadow-modal);
    outline: none;
    animation: pop 180ms var(--ease-spring);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.97);
    }
  }
  .close {
    position: absolute;
    top: 12px;
    right: 12px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 26px 48px 22px 22px;
  }
  .head img {
    flex: none;
    border-radius: 14px;
  }
  h2 {
    margin: 0 0 3px;
    font-size: 18px;
    font-weight: 600;
    line-height: 1.25;
  }
  p {
    margin: 0;
    color: var(--ink-2);
  }
  .facts {
    border-top: 1px solid var(--line);
  }
  .fact {
    display: grid;
    grid-template-columns: 68px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 38px;
    padding: 4px 22px;
    border-bottom: 1px solid var(--line);
    text-align: left;
  }
  button.fact {
    transition: background var(--t-fast) var(--ease-out);
  }
  button.fact:hover {
    background: var(--accent-soft);
  }
  button.fact:focus-visible {
    outline-offset: -2px;
  }
  .label {
    color: var(--ink-3);
    font-size: 12px;
    font-weight: 500;
  }
  .value {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: var(--font-mono);
    font-size: 12.5px;
  }
  .note {
    color: var(--ink-2);
    font-size: 12px;
  }
  .out {
    display: flex;
    color: var(--ink-4);
  }
  button.fact:hover .out {
    color: var(--accent);
  }
  .fact .btn {
    height: 26px;
    padding: 0 10px;
    font-size: 12px;
  }
  .fact .btn:disabled {
    color: var(--ink-3);
    pointer-events: none;
  }
  .auto {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 14px 22px 0;
  }
  .auto input {
    flex: none;
    margin: 2px 0 0;
    accent-color: var(--accent);
  }
  .auto small {
    display: block;
    margin-top: 2px;
    color: var(--ink-3);
    font-size: 12px;
  }
  .colophon {
    padding: 14px 22px 18px;
    color: var(--ink-3);
    font-size: 12px;
  }
</style>
