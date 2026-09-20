import { defineConfig, type Plugin } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const host = process.env.TAURI_DEV_HOST;

/**
 * Dev-only bridge: POST JS to /__eval with an `x-bedsheet-eval: 1` header and it runs inside the
 * connected app page. Browsers can't send that header cross-origin, and always send Origin.
 */
function evalBridge(): Plugin {
  return {
    name: 'bedsheet-eval-bridge',
    apply: 'serve',
    configureServer(server) {
      const pending = new Map<string, (r: unknown) => void>();
      server.ws.on('bedsheet:result', (data: { id: string }) => {
        pending.get(data.id)?.(data);
        pending.delete(data.id);
      });
      server.middlewares.use('/__eval', (req, res) => {
        if (req.method !== 'POST' || req.headers['x-bedsheet-eval'] !== '1' || req.headers.origin) {
          res.statusCode = 403;
          res.end('forbidden');
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const id = Math.random().toString(36).slice(2);
          const tauri = req.headers['x-target'] === 'tauri';
          const timer = setTimeout(() => {
            pending.delete(id);
            res.statusCode = 504;
            res.end('timeout');
          }, 30000);
          pending.set(id, (r) => {
            clearTimeout(timer);
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify(r));
          });
          server.ws.send('bedsheet:eval', { id, code: body, tauri });
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [svelte(), ...(host ? [] : [evalBridge()])],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'safari15',
    sourcemap: false,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
