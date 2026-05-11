import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Set base path for GitHub Pages
  base: '/wavetuner/',
  // hydra-synth pulls in CommonJS deps (right-now, raf-loop) that
  // reference Node's `global`. Aliasing it to `globalThis` is the
  // standard browser shim — the deps just need a global-scope object,
  // and globalThis is the spec-defined cross-environment alias.
  define: {
    global: 'globalThis',
  },
  server: {
    host: true, // Expose to network (0.0.0.0)
    port: 5173,
  },
})
