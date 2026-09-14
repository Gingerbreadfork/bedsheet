<script lang="ts">
  import { app } from '../lib/app.svelte';

  let primary = $state<HTMLButtonElement>();
  let dialog = $derived(app.dialog);

  $effect(() => {
    primary?.focus();
  });

  function onKey(e: KeyboardEvent): void {
    if (!dialog) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      const cancel = dialog.actions.find((a) => a.label === 'Cancel') ?? dialog.actions[dialog.actions.length - 2];
      cancel?.run();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      dialog.actions.find((a) => a.kind === 'primary')?.run();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

{#if dialog}
  <div class="scrim" role="presentation">
    <div class="panel" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title">
      <h2 id="dlg-title">{dialog.title}</h2>
      <p>{dialog.message}</p>
      <div class="actions">
        {#each dialog.actions as a (a.label)}
          {#if a.kind === 'primary'}
            <button class="btn primary" bind:this={primary} onclick={a.run}>{a.label}</button>
          {:else}
            <button class="btn" class:ghost={a.kind === 'ghost'} class:danger={a.kind === 'danger'} onclick={a.run}>{a.label}</button>
          {/if}
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 70;
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
    width: min(420px, calc(100vw - 32px));
    padding: 22px 22px 18px;
    background: var(--popover);
    border-radius: 12px;
    box-shadow: var(--shadow-modal);
    animation: pop 180ms var(--ease-spring);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.96) translateY(6px);
    }
  }
  h2 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
    line-height: 1.35;
    word-break: break-word;
  }
  p {
    margin: 0 0 20px;
    color: var(--ink-2);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions .ghost {
    margin-right: auto;
  }
</style>
