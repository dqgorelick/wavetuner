import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Set base path for GitHub Pages - change 'binaural-tuner' to your repo name
  base: '/binaural-tuner/',
  server: {
    host: true, // Expose to network (0.0.0.0)
    port: 5173,
  },
})
