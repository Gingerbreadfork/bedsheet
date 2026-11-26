<script lang="ts">
  import { app } from '../lib/app.svelte';
  import { removeRecent } from '../lib/platform';
  import { shortDir } from '../lib/paths';
  import Icon from './Icon.svelte';

  const version = __APP_VERSION__;

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

  /** The extension to tag a recent file with, or a plain word for a name without one. */
  function kind(name: string): string {
    return /\.([a-z0-9]{1,4})$/i.exec(name)?.[1].toLowerCase() ?? 'text';
  }
</script>

<div class="launch" class:hover={app.dragHover}>
  <div class="scroll">
    <div class="stage">
      <section class="brand">
        <div class="head">
          <div class="mascot" aria-hidden="true">
            <svg class="ghost" viewBox="240 228 544 596">
              <defs>
                <clipPath id="launch-ghost">
                  <path d="M262 500a250 250 0 0 1 500 0v300l-83-62-84 62-83-62-83 62-84-62-83 62Z" />
                </clipPath>
              </defs>
              <path class="body" d="M262 500a250 250 0 0 1 500 0v300l-83-62-84 62-83-62-83 62-84-62-83 62Z" />
              <g class="rules" clip-path="url(#launch-ghost)">
                <path d="M262 500h500M262 670h500M428 250v550M595 250v550" />
              </g>
              <g class="eyes">
                <rect x="352" y="430" width="76" height="70" />
                <rect x="595" y="430" width="76" height="70" />
              </g>
              <path class="edge" d="M262 500a250 250 0 0 1 500 0v300l-83-62-84 62-83-62-83 62-84-62-83 62Z" />
            </svg>
            <span class="shade"></span>
          </div>

          <div class="words">
            <div class="title">
              <h1>Bedsheet</h1>
              <button class="version" title="About Bedsheet" onclick={() => app.openAbout()}>{version}</button>
            </div>
            <p class="tagline">A fast, focused editor for CSV and other delimited text.</p>
          </div>
        </div>

        <div class="actions">
          <button class="action primary" onclick={() => app.open()}>
            <span class="tile"><Icon name="folder" size={18} /></span>
            <span class="what">
              <strong>Open a file</strong>
              <small>CSV, TSV, or any delimited text</small>
            </span>
            <span class="keys"><kbd>Ctrl</kbd><kbd>O</kbd></span>
          </button>
          <button class="action" onclick={() => app.newSheet()}>
            <span class="tile"><Icon name="plus" size={18} /></span>
            <span class="what">
              <strong>New sheet</strong>
              <small>Start from a blank grid</small>
            </span>
            <span class="keys"><kbd>Ctrl</kbd><kbd>N</kbd></span>
          </button>
          <button class="action" onclick={() => app.paste()}>
            <span class="tile"><Icon name="clipboard" size={18} /></span>
            <span class="what">
              <strong>Paste a table</strong>
              <small>Make a sheet from what you copied</small>
            </span>
            <span class="keys"><kbd>Ctrl</kbd><kbd>V</kbd></span>
          </button>
        </div>
      </section>

      <section class="side">
        {#if app.recent.length > 0}
          <h2>Recent</h2>
          <ul>
            {#each app.recent as r (r.path)}
              <li>
                <button class="open" onclick={() => app.openPath(r.path)} title={r.path}>
                  <span class="kind">{kind(r.name)}</span>
                  <span class="file">
                    <span class="name">{r.name}</span>
                    <span class="dir" dir="rtl">&lrm;{shortDir(r.path)}&lrm;</span>
                  </span>
                  <span class="when">{ago(r.openedAt)}</span>
                </button>
                <button class="forget" title="Remove from recent" onclick={() => (app.recent = removeRecent(r.path))}>
                  <Icon name="close" size={13} />
                </button>
              </li>
            {/each}
          </ul>
          <p class="hint">Or drop a file anywhere in the window.</p>
        {:else}
          <div class="invite">
            <span class="mark"><Icon name="file" size={20} /></span>
            <strong>Drop a file here</strong>
            <span>Or anywhere in the window. The files you open are listed here afterwards.</span>
          </div>
        {/if}
      </section>
    </div>
  </div>

  <div class="veil" aria-hidden="true"><span>Drop to open</span></div>
</div>

<style>
  .launch {
    position: relative;
    height: 100%;
    background: var(--paper);
    container-type: size;
  }
  .scroll {
    height: 100%;
    overflow: auto;
  }
  .stage {
    display: grid;
    grid-template-columns: minmax(0, 344px) minmax(0, 404px);
    gap: 76px;
    align-items: center;
    justify-content: center;
    min-height: 100%;
    padding: 36px 32px 52px;
  }

  /* The ghost floats over its own shadow. Nothing else on the page moves by itself. */
  .mascot {
    position: relative;
    width: var(--ghost-w);
    margin-bottom: 26px;
    --ghost-w: 112px;
  }
  .mascot::before {
    content: '';
    position: absolute;
    inset: -76px -90px -64px;
    background: radial-gradient(closest-side, var(--ghost-glow), transparent);
    pointer-events: none;
  }
  .ghost {
    position: relative;
    display: block;
    width: var(--ghost-w);
    height: auto;
    animation: float 5.6s ease-in-out infinite;
  }
  .body {
    fill: var(--ghost);
  }
  .rules {
    fill: none;
    stroke: var(--ghost-rule);
    stroke-width: 8;
  }
  .eyes {
    fill: var(--ghost-ink);
    transform-box: fill-box;
    transform-origin: center;
    animation: blink 6.4s infinite;
  }
  .edge {
    fill: none;
    stroke: var(--ghost-ink);
    stroke-width: 22;
    stroke-linejoin: round;
  }
  .shade {
    display: block;
    width: 65%;
    height: 9px;
    margin: 8px auto 0;
    border-radius: 50%;
    background: oklch(20% 0.02 150 / 0.2);
    filter: blur(4px);
    animation: shade 5.6s ease-in-out infinite;
  }
  @keyframes float {
    50% {
      transform: translateY(-7px);
    }
  }
  @keyframes shade {
    50% {
      transform: scaleX(0.8);
      opacity: 0.6;
    }
  }
  @keyframes blink {
    0%,
    93%,
    100% {
      transform: scaleY(1);
    }
    96% {
      transform: scaleY(0.12);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ghost,
    .eyes,
    .shade {
      animation: none;
    }
  }

  .title {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  h1 {
    margin: 0;
    font-size: 40px;
    font-weight: 600;
    letter-spacing: -0.032em;
    line-height: 1.05;
  }
  .version {
    padding: 1px 8px;
    border-radius: 999px;
    box-shadow: inset 0 0 0 1px var(--line-strong);
    color: var(--ink-3);
    font-family: var(--font-mono);
    font-size: 11.5px;
    line-height: 18px;
    transform: translateY(-4px);
    transition:
      color var(--t-fast) var(--ease-out),
      background var(--t-fast) var(--ease-out);
  }
  .version:hover {
    background: var(--paper-2);
    color: var(--ink);
  }
  .tagline {
    max-width: 30ch;
    margin: 10px 0 0;
    color: var(--ink-2);
    font-size: 15px;
    line-height: 1.5;
  }

  .actions {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 28px -10px 0;
  }
  .action {
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr) auto;
    align-items: center;
    gap: 13px;
    padding: 8px 12px 8px 10px;
    border-radius: 11px;
    text-align: left;
    transition: background var(--t-fast) var(--ease-out);
  }
  .action:hover {
    background: var(--paper-2);
  }
  .action:active {
    background: var(--paper-3);
  }
  .tile {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    border-radius: 10px;
    background: var(--sheet);
    box-shadow: inset 0 0 0 1px var(--line-strong);
    color: var(--ink-2);
  }
  .action.primary .tile {
    background: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent-strong);
    color: var(--accent-ink);
  }
  .what {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .what strong {
    font-size: 13.5px;
    font-weight: 500;
  }
  .what small {
    overflow: hidden;
    color: var(--ink-3);
    font-size: 12px;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .side {
    padding: 8px;
    border-radius: 14px;
    background: var(--sheet);
    box-shadow:
      0 0 0 1px var(--line),
      0 1px 2px oklch(20% 0.02 150 / 0.05),
      0 18px 40px -22px oklch(20% 0.02 150 / 0.28);
  }
  h2 {
    margin: 0;
    padding: 8px 10px 6px;
    color: var(--ink-3);
    font-size: 12px;
    font-weight: 500;
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    position: relative;
  }
  .open {
    display: grid;
    grid-template-columns: 38px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    width: 100%;
    padding: 7px 12px 7px 10px;
    border-radius: 8px;
    text-align: left;
    transition: background var(--t-fast) var(--ease-out);
  }
  .open:hover {
    background: var(--accent-soft);
  }
  .kind {
    padding: 3px 0;
    border-radius: 5px;
    background: color-mix(in oklch, var(--ink) 7%, transparent);
    color: var(--ink-2);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-weight: 500;
    line-height: 16px;
    text-align: center;
  }
  .open:hover .kind {
    background: var(--accent-soft-2);
    color: var(--accent-strong);
  }
  .file {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .name,
  .dir {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .name {
    font-weight: 500;
  }
  .dir {
    color: var(--ink-3);
    font-family: var(--font-mono);
    font-size: 11.5px;
    text-align: left;
    unicode-bidi: isolate;
  }
  .when {
    color: var(--ink-3);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
    transition: opacity var(--t-fast) var(--ease-out);
  }
  .forget {
    position: absolute;
    top: 50%;
    right: 9px;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    margin-top: -12px;
    border-radius: 6px;
    color: var(--ink-3);
    opacity: 0;
    transition:
      opacity var(--t-fast) var(--ease-out),
      background var(--t-fast) var(--ease-out);
  }
  li:hover .forget,
  .forget:focus-visible {
    opacity: 1;
  }
  li:hover .when,
  li:focus-within .when {
    opacity: 0;
  }
  .forget:hover {
    background: var(--danger-soft);
    color: var(--danger);
  }
  .hint {
    margin: 6px 0 0;
    padding: 10px 10px 6px;
    border-top: 1px solid var(--line);
    color: var(--ink-3);
    font-size: 12px;
  }
  .invite {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 268px;
    padding: 28px 44px;
    border: 1.5px dashed var(--line-strong);
    border-radius: 9px;
    color: var(--ink-3);
    text-align: center;
  }
  .invite strong {
    color: var(--ink);
    font-size: 16px;
    font-weight: 500;
  }
  .mark {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    margin-bottom: 8px;
    border-radius: 50%;
    background: color-mix(in oklch, var(--ink) 6%, transparent);
    color: var(--ink-2);
  }

  .veil {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: color-mix(in oklch, var(--paper) 80%, transparent);
    backdrop-filter: blur(3px);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--t-med) var(--ease-out);
  }
  .veil::before {
    content: '';
    position: absolute;
    inset: 12px;
    border: 2px dashed var(--accent);
    border-radius: 12px;
    background: var(--accent-soft);
  }
  .veil span {
    position: relative;
    color: var(--accent-strong);
    font-size: 22px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .launch.hover .veil {
    opacity: 1;
  }

  /* A window too narrow for two columns stacks them. */
  @container (max-width: 860px) {
    .stage {
      grid-template-columns: minmax(0, 440px);
      gap: 26px;
      align-content: center;
      padding: 26px 24px 36px;
    }
    .invite {
      min-height: 132px;
    }
  }
  /* A narrow or short window sets the ghost beside the name to save height. */
  @container (max-width: 860px) or (max-height: 600px) {
    .head {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .mascot {
      flex: none;
      margin-bottom: 0;
      --ghost-w: 56px;
    }
    .mascot::before {
      inset: -40px -48px -32px;
    }
    .shade {
      height: 6px;
      margin-top: 5px;
    }
    h1 {
      font-size: 30px;
    }
    .tagline {
      max-width: none;
      margin-top: 4px;
      font-size: 14px;
    }
    .actions {
      margin-top: 18px;
    }
  }
</style>
