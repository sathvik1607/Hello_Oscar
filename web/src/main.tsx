import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { applyTheme } from './lib/session'

// Before React mounts, so the first paint is already the right theme. Doing this in
// an effect leaves a visible white flash on a dark-mode load.
applyTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode><App /></StrictMode>,
)
