import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { applyTheme } from './lib/session'

// Before React mounts, so the first paint is already the right theme. Doing this in
// an effect leaves a visible white flash on a dark-mode load.
applyTheme()

// The app reached mount, so whatever chunk error triggered an automatic reload is
// resolved — return the one-shot allowance so the NEXT deploy can self-heal too.
// Without this, one stale-chunk reload would spend the tab's only attempt forever.
try { sessionStorage.removeItem('oscar.web.chunk_reloaded') } catch { /* blocked */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
)
