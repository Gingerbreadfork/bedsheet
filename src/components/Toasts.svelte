<script lang="ts">
  import { app, type Toast } from '../lib/app.svelte';
  import Icon from './Icon.svelte';

  function act(t: Toast): void {
    app.dismissToast(t.id);
    t.action?.run();
  }
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as t (t.id)}
    <div class="toast {t.kind}" class:acts={t.action}>
      {#if t.kind === 'success'}<span class="ico"><Icon name="check" size={14} /></span>{/if}
      {#if t.kind === 'error'}<span class="ico"><Icon name="warning" size={14} /></span>{/if}
      <span>{t.text}</span>
      {#if t.action}
        <button class="act" onclick={() => act(t)}>{t.action.label}</button>
      {/if}
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 42px;
    z-index: 80;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: min(520px, calc(100vw - 32px));
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--ink);
    color: var(--paper);
    font-weight: 500;
    box-shadow: 0 6px 20px -6px oklch(0% 0 0 / 0.4);
    animation: rise 200ms var(--ease-spring);
  }
  .toast.acts {
    padding-right: 6px;
    pointer-events: auto;
  }
  .act {
    padding: 3px 11px;
    border-radius: 999px;
    background: color-mix(in oklch, currentColor 16%, transparent);
    font-weight: 600;
    white-space: nowrap;
    transition: background var(--t-fast) var(--ease-out);
  }
  .act:hover {
    background: color-mix(in oklch, currentColor 28%, transparent);
  }
  .toast.success .ico {
    color: var(--accent);
  }
  .toast.error {
    background: var(--danger);
    color: #fff;
  }
  :global(:root[data-theme='dark']) .toast.success .ico {
    color: var(--accent-strong);
  }
  .ico {
    display: flex;
  }
  @keyframes rise {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.97);
    }
  }
</style>
