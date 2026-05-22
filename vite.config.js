import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Which visual backend gets bundled. Default is hydra (current behavior);
// set `VITE_VISUAL_BACKEND=shader` to swap in the AGPL-free WebGL stub.
// See src/visuals/backend.js for the contract both backends satisfy.
const backend = process.env.VITE_VISUAL_BACKEND === 'shader' ? 'shader' : 'hydra'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Set base path for GitHub Pages
  base: '/wavetuner/',
  // hydra-synth pulls in CommonJS deps (right-now, raf-loop) that
  // reference Node's `global`. Aliasing it to `globalThis` is the
  // standard browser shim — the deps just need a global-scope object,
  // and globalThis is the spec-defined cross-environment alias.
  // Harmless when the shader backend is active (hydra-synth not bundled).
  define: {
    global: 'globalThis',
  },
  resolve: {
    alias: {
      // backend.js imports `@visual-backend`; this alias points it at
      // whichever implementation matches VITE_VISUAL_BACKEND. The other
      // backend's file is unreferenced by the import graph and gets
      // tree-shaken out of the bundle (along with its deps — most
      // importantly hydra-synth when backend === 'shader').
      '@visual-backend': fileURLToPath(
        new URL(`./src/visuals/backends/${backend}.js`, import.meta.url)
      ),
    },
  },
  server: {
    host: true, // Expose to network (0.0.0.0)
    port: 5173,
  },
})
