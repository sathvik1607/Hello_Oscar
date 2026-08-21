import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // 5174, not 5173. 5173 belongs to the admin panel — running both at once is
    // normal during development, and Vite silently moving to the next free port
    // would land this app on an origin the backend's CORS list does not contain,
    // which surfaces as an opaque preflight failure with nothing in the server
    // log. strictPort makes that a startup error instead of a mystery.
    port: 5174,
    strictPort: true,
  },
  build: {
    // Voice is the one thing that must not stutter, and it is the largest chunk.
    // Splitting it out means the rest of the app is not re-downloaded when the
    // voice engine changes, and the voice engine is not parsed on a page load
    // that never opens the microphone.
    rollupOptions: {
      output: {
        // A function rather than the object form: the object form is typed as a
        // record of known chunk names in this Rollup version and rejects new ones.
        manualChunks(id) {
          if (id.includes('node_modules/react')) return 'react'
          if (id.includes('node_modules/lucide-react')) return 'icons'
          return undefined
        },
      },
    },
  },
})
