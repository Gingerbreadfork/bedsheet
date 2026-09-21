<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { removeRecent } from '../lib/platform';
  import Icon from './Icon.svelte';

  function shortPath(p: string): string {
    const dir = p.slice(0, p.lastIndexOf('/'));
    return dir.replace(/^\/home\/[^/]+/, '~') || '/';
  }

  function ago(ts: number): string {
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    const m = s / 60;
    if (m < 60) return `${Math.floor(m)} min ago`;
    const h = m / 60;
    if (h < 24) return `${Math.floor(h)} h ago`;
    const d = h / 24;
    if (d < 2) return 'yesterday';
    if (d < 14) return `${Math.floor(d)} days ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
</script>

<div class="empty" class:hover={app.dragHover}>
  <div class="page">
    <div class="ledger">
      <h1>{app.dragHover ? 'Drop to open' : 'Drop a file here'}</h1>
      <p class="lede">CSV, TSV, or any delimited text. Or start with a blank sheet, or paste a table.</p>
      <div class="actions">
        <button class="btn primary" onclick={() => app.open()}>
          Open file
          <span class="keys"><kbd>Ctrl</kbd><kbd>O</kbd></span>
        </button>
        <button class="btn" onclick={() => app.newSheet()}>
          New sheet
          <span class="keys"><kbd>Ctrl</kbd><kbd>N</kbd></span>
        </button>
      </div>

      {#if app.recent.length > 0}
        <div class="recent">
          <div class="recent-head">Recent</div>
          {#each app.recent as r (r.path)}
            <div class="entry">
              <button class="open" onclick={() => app.openPath(r.path)} title={r.path}>
                <span class="ico"><Icon name="file" size={15} /></span>
                <span class="rname">{r.name}</span>
                <span class="rpath" dir="rtl">&lrm;{shortPath(r.path)}&lrm;</span>
                <span class="rtime">{ago(r.openedAt)}</span>
              </button>
              <button class="forget" title="Remove from recent" onclick={() => (app.recent = removeRecent(r.path))}>
                <Icon name="close" size={13} />
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .empty {
    position: relative;
    height: 100%;
    overflow: auto;
    background-color: var(--paper);
    --margin-x: clamp(56px, 10vw, 112px);
  }
  .empty.hover::after {
    content: '';
    position: absolute;
    inset: 10px;
    border: 2px dashed var(--accent);
    border-radius: 10px;
    pointer-events: none;
  }
  .page {
    max-width: 960px;
    min-height: 100%;
    margin: 0 auto;
    padding: 84px 40px 56px calc(var(--margin-x) + 22px);
    background-color: var(--sheet);
    background-image:
      linear-gradient(to right, transparent calc(var(--margin-x) - 5px), var(--margin-rule) calc(var(--margin-x) - 5px), var(--margin-rule) calc(var(--margin-x) - 4px), transparent calc(var(--margin-x) - 4px), transparent calc(var(--margin-x) - 1px), var(--margin-rule) calc(var(--margin-x) - 1px), var(--margin-rule) var(--margin-x), transparent var(--margin-x)),
      repeating-linear-gradient(to bottom, transparent 0, transparent 27px, var(--line) 27px, var(--line) 28px);
    box-shadow: 0 0 0 1px var(--line), 0 0 48px -12px oklch(20% 0.02 150 / 0.18);
    transition: background-color var(--t-med) var(--ease-out);
  }
  .empty.hover .page {
    background-color: color-mix(in oklch, var(--sheet) 88%, var(--accent));
  }
  .ledger {
    max-width: 600px;
  }
  h1 {
    margin: 0;
    font-size: 30px;
    font-weight: 500;
    letter-spacing: -0.015em;
    line-height: 56px;
    color: var(--ink);
    transform: translateY(15px);
  }
  .lede {
    margin: 0 0 28px;
    line-height: 28px;
    color: var(--ink-2);
    font-size: 14px;
    transform: translateY(6px);
  }
  .actions {
    display: flex;
    gap: 10px;
    align-items: center;
    height: 56px;
    margin-bottom: 28px;
  }
  .recent-head {
    height: 28px;
    line-height: 28px;
    font-size: 12px;
    font-weight: 500;
    color: var(--ink-3);
  }
  .entry {
    display: flex;
    align-items: center;
    height: 28px;
    margin-left: -8px;
  }
  .open {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    height: 28px;
    padding: 0 8px;
    border-radius: 5px;
    color: var(--ink);
    text-align: left;
    transition: background var(--t-fast) var(--ease-out);
  }
  .open:hover {
    background: var(--accent-soft);
  }
  .ico {
    display: flex;
    color: var(--ink-3);
  }
  .rname {
    font-weight: 500;
    white-space: nowrap;
  }
  .rpath {
    flex: 1;
    min-width: 0;
    color: var(--ink-3);
    font-family: var(--font-mono);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
    unicode-bidi: isolate;
  }
  .rtime {
    color: var(--ink-3);
    font-size: 12px;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .forget {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-left: 4px;
    border-radius: 5px;
    color: var(--ink-3);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease-out), background var(--t-fast) var(--ease-out);
  }
  .entry:hover .forget {
    opacity: 1;
  }
  .forget:hover {
    background: var(--danger-soft);
    color: var(--danger);
  }
</style>
