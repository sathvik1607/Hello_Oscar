import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Which build is this?
 *
 * Injected at COMPILE time, because the running code cannot otherwise know — and
 * without it nobody can answer "which version is that user on?". This session was
 * spent diagnosing a tab running old code, and the single fact that would have
 * short-circuited it was the build id of the bundle in that browser.
 *
 * Vercel provides VERCEL_GIT_COMMIT_SHA on every deploy, so the build id IS the
 * commit — traceable straight back to source with no bookkeeping. Falls back to a
 * timestamp locally, where a commit sha is either absent or misleading (a dirty
 * tree is not the commit it claims to be).
 *
 * A plain string, deliberately. It is compared for EQUALITY only — never ordered,
 * never parsed — so a sha and a timestamp are equally valid and no format needs
 * agreeing with the server.
 */
const BUILD_ID =
  process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ??
  `local-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    // Literal, so it survives minification and tree-shaking as a constant.
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  server: {
    // 5174, not 5173. 5173 belongs to the admin panel — running both at once is
    // normal during development, and Vite silently moving to the next free port
    // would land this app on an origin the backend's CORS list does not contain,
    // which surfaces as an opaque preflight failure with nothing in the server
    // log. strictPort makes that a startup error instead of a mystery.
    port: 5174,
    strictPort: true,
    watch: {
      // 🔴 tsc -b's incremental caches live in this directory, and `npm run
      // typecheck`/`build` rewrite them. Vite watches the project ROOT, not just
      // src/, so each rewrite looked like a source change and triggered an HMR
      // FULL RELOAD — the dev page appearing to "constantly refresh" while
      // nothing in src/ had changed. .gitignore alone is not enough: Vite's
      // watcher does not consult it for files already on disk.
      ignored: ['**/*.tsbuildinfo'],
    },
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
