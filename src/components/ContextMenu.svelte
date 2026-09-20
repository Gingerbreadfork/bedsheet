<script lang="ts">
  import { tick } from 'svelte';
  import { app, type MenuItem } from '../lib/app.svelte';
  import { shortcutKeys } from '../lib/keys';
  import Icon from './Icon.svelte';

  let el = $state<HTMLDivElement>();
  let left = $state(0);
  let top = $state(0);
  let index = $state(-1);
  let ready = $state(false);

  let menu = $derived(app.menu);
  let items = $derived(menu?.items ?? []);

  $effect(() => {
    const m = menu;
    if (!m) {
      ready = false;
      return;
    }
    index = -1;
    ready = false;
    tick().then(() => {
      const box = el?.getBoundingClientRect();
      const w = box?.width ?? 200;
      const h = box?.height ?? 200;
      let x = m.align === 'right' ? m.x - w : m.x;
      let y = m.y;
      if (y + h > window.innerHeight - 8) y = Math.max(8, (m.align ? m.y - 4 : m.y) - h);
      if (x + w > window.innerWidth - 8) x = window.innerWidth - w - 8;
      if (x < 8) x = 8;
      left = x;
      top = y;
      ready = true;
    });
  });

  function run(item: MenuItem): void {
    if (item === 'sep' || item.disabled) return;
    app.closeMenu();
    item.run();
  }

  function enabledIndices(): number[] {
    return items.map((it, i) => (it !== 'sep' && !it.disabled ? i : -1)).filter((i) => i >= 0);
  }

  function onKey(e: KeyboardEvent): void {
    if (!menu) return;
    const en = enabledIndices();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      if (en.length === 0) return;
      const pos = en.indexOf(index);
      const next = e.key === 'ArrowDown' ? en[(pos + 1) % en.length] : en[(pos - 1 + en.length) % en.length];
      index = next;
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      const it = items[index];
      if (it) run(it);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      app.closeMenu();
    } else if (e.key === 'Tab' || e.key === 'PageUp' || e.key === 'PageDown' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
    }
  }

  async function passThroughRightClick(e: MouseEvent): Promise<void> {
    e.preventDefault();
    app.closeMenu();
    await tick();
    const target = document.elementFromPoint(e.clientX, e.clientY);
    target?.dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: e.clientX, clientY: e.clientY, button: 2 }),
    );
  }
</script>

<svelte:window onkeydown={menu ? onKey : undefined} />

{#if menu}
  <div
    class="scrim"
    role="presentation"
    onpointerdown={(e) => {
      if (e.button === 2) return;
      app.closeMenu();
    }}
    oncontextmenu={passThroughRightClick}
  >
    <div
      class="menu"
      class:ready
      role="menu"
      tabindex="-1"
      bind:this={el}
      style:left="{left}px"
      style:top="{top}px"
      style:min-width="{menu.width ?? 200}px"
      onpointerdown={(e) => e.stopPropagation()}
      oncontextmenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {#each items as item, i (i)}
        {#if item === 'sep'}
          <div class="sep"></div>
        {:else}
          <button
            class="item"
            class:danger={item.danger}
            class:active={i === index}
            role="menuitem"
            disabled={item.disabled}
            onpointermove={() => (index = i)}
            onclick={() => run(item)}
          >
            <span class="check">{#if item.checked}<Icon name="check" size={14} />{/if}</span>
            <span class="label">{item.label}</span>
            {#if item.shortcut}
              <span class="keys">{#each shortcutKeys(item.shortcut) as k, j (j)}<kbd>{k}</kbd>{/each}</span>
            {/if}
          </button>
        {/if}
      {/each}
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 60;
  }
  .menu {
    position: fixed;
    display: flex;
    flex-direction: column;
    padding: 5px;
    background: var(--popover);
    border-radius: 8px;
    box-shadow: var(--shadow-pop);
    opacity: 0;
    transform: scale(0.98);
    transform-origin: top left;
  }
  .menu.ready {
    opacity: 1;
    transform: none;
    transition: opacity 110ms var(--ease-out), transform 130ms var(--ease-spring);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 10px 0 6px;
    border-radius: 5px;
    color: var(--ink);
    white-space: nowrap;
    text-align: left;
  }
  .item.active {
    background: var(--accent-soft);
  }
  .item.danger {
    color: var(--danger);
  }
  .item.danger.active {
    background: var(--danger-soft);
  }
  .item:disabled {
    color: var(--ink-4);
  }
  .check {
    display: inline-flex;
    width: 16px;
    justify-content: center;
    color: var(--accent);
  }
  .label {
    flex: 1;
  }
  .keys {
    margin-left: 18px;
  }
  .item kbd {
    height: 17px;
    min-width: 17px;
    font-size: 10.5px;
    color: var(--ink-3);
    background: transparent;
    border-color: var(--line);
  }
  .sep {
    height: 1px;
    margin: 5px 6px;
    background: var(--line);
  }
</style>
