<script lang="ts">
  import { app } from '../lib/app.svelte';

  let input = $state<HTMLInputElement>();
  let prompt = $derived(app.prompt);
  // svelte-ignore state_referenced_locally
  let value = $state(prompt?.initial ?? '');

  $effect(() => {
    input?.focus();
    input?.select();
  });

  function close(): void {
    app.prompt = null;
    app.grid.focusGrid?.();
  }

  function onKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      if (prompt?.submit(value)) close();
      else input?.select();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }
</script>

{#if prompt}
  <div class="scrim" role="presentation" onpointerdown={close}>
    <div class="panel" role="dialog" tabindex="-1" aria-label={prompt.label} onpointerdown={(e) => e.stopPropagation()}>
      <label for="prompt">{prompt.label}</label>
      <input
        id="prompt"
        bind:this={input}
        bind:value
        inputmode={prompt.numeric ? 'numeric' : 'text'}
        placeholder={prompt.placeholder}
        spellcheck="false"
        autocomplete="off"
        onkeydown={onKey}
      />
      <kbd>↵</kbd>
    </div>
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
  }
  .panel {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 48px;
    padding: 0 14px;
    background: var(--popover);
    border-radius: 10px;
    box-shadow: var(--shadow-modal);
    animation: pop 160ms var(--ease-spring);
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: scale(0.97) translateY(-8px);
    }
  }
  label {
    font-weight: 500;
    color: var(--ink-2);
    white-space: nowrap;
  }
  input {
    width: 160px;
    height: 30px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid var(--line-strong);
    background: var(--sheet);
    font-variant-numeric: tabular-nums;
    outline: none;
  }
  input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
</style>
