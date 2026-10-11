import { defineConfig } from 'vite';

// No external resources: relative base, everything bundled, no CDN.
export default defineConfig({
  root: 'src/client',
  base: './',
  // The model packs are imported as data (`?inline`), never fetched: every
  // three.js loader contains a `fetch()` and the bundle must not. A `.glb`
  // is not one of Vite's known asset types, so it has to be named here.
  assetsInclude: ['**/*.glb'],
  server: {
    host: '127.0.0.1',
    // cli.ts reads it too, for the origin admitted to the WebSocket in --dev:
    // two copies of the tree developed side by side need two ports, and
    // strictPort keeps one from silently sliding onto another.
    port: Number(process.env['TOWERGLOW_DEV_PORT'] ?? 5173),
    strictPort: true,
  },
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
    // No modulepreload polyfill: it would put a fetch() in the bundle
    // for a capability our browser target already has.
    modulePreload: false,
    target: 'es2023',
    // The pack chunk is seven megabytes of base64 by design (see
    // src/client/assets/pack.ts); the warning would only ever say so.
    chunkSizeWarningLimit: 8000,
    assetsInlineLimit: 0,
    rollupOptions: {
      output: { banner: '' },
    },
  },
});
