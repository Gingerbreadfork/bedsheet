import { mount } from 'svelte';
import App from './App.svelte';
import { app } from './lib/app.svelte';
import { isTauri } from './lib/platform';

if (import.meta.env.DEV) {
  (window as unknown as { __bedsheet: unknown }).__bedsheet = app;
  import.meta.hot?.on('bedsheet:eval', async ({ id, code, tauri }: { id: string; code: string; tauri: boolean }) => {
    if (tauri !== isTauri) return;
    try {
      const result = await new Function('app', `return (async () => { ${code} })()`)(app);
      import.meta.hot?.send('bedsheet:result', { id, ok: true, result });
    } catch (e) {
      import.meta.hot?.send('bedsheet:result', { id, ok: false, error: String(e) });
    }
  });
}

mount(App, { target: document.getElementById('app')! });
