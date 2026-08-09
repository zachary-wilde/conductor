// Dedicated Vite build for the responsive web operator UI (Phase 2).
//
// The Electron renderer is built by `electron-vite` from `src/renderer`; this
// is a SEPARATE, standalone SPA rooted at `src/web` that the loopback core
// serves as static files from `out/web`. It bundles to relative asset paths
// (`base: './'`) so the same build loads whether the core serves it at the API
// origin or a dev server proxies it. It reuses the same React + Tailwind stack
// as the renderer and aliases into the PURE operations brain (`web-client-core`
// and friends) so the client and server never drift on the protocol.

import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const sharedAlias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@ops': resolve(__dirname, 'src/main/operations')
}

export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  plugins: [react()],
  resolve: { alias: sharedAlias },
  build: {
    // Absolute so the output lands at the repo root's `out/web` regardless of
    // `root`. `emptyOutDir` is set explicitly because outDir is outside root.
    outDir: resolve(__dirname, 'out/web'),
    emptyOutDir: true
  },
  server: { fs: { allow: ['..'] } }
})
