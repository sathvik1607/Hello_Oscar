/**
 * Who is signed in, and the token that proves it.
 *
 * ONE module owns this. Every other file asks here rather than reading
 * localStorage, because the failure mode of a second reader is a screen that keeps
 * rendering a signed-out user's data from a stale copy.
 *
 * Storage is localStorage rather than sessionStorage: an assistant you have to log
 * back into every time you reopen a tab is an assistant you stop using. The
 * exposure is the standard one for a bearer token in a browser (XSS reads it), and
 * the token is scoped to one user's own data with a 30-day life.
 */

import type { SessionUser } from './types'

const K_TOKEN = 'oscar.web.token'
const K_USER = 'oscar.web.user'
const K_BASE = 'oscar.web.base'
const K_THEME = 'oscar.web.theme'

export const DEFAULT_BASE =
  (import.meta.env.VITE_BACKEND_URL as string | undefined)?.replace(/\/+$/, '') ??
  'http://127.0.0.1:8000'

/** Backend origin. Overridable at runtime from Settings so one build can be pointed
 *  at local / dev / prod without a rebuild — the value is an origin, not a secret. */
export function getBase(): string {
  return localStorage.getItem(K_BASE)?.replace(/\/+$/, '') || DEFAULT_BASE
}
export function setBase(url: string) {
  localStorage.setItem(K_BASE, url.replace(/\/+$/, ''))
}

/** ws:// for http://, wss:// for https://. An https page opening a ws:// socket is
 *  blocked as mixed content, and that failure surfaces as "voice does not work"
 *  rather than as a URL scheme problem — so it is derived, never configured. */
export function getWsBase(): string {
  return getBase().replace(/^http/, 'ws')
}

export function getToken(): string | null {
  return localStorage.getItem(K_TOKEN)
}

export function getUser(): SessionUser | null {
  const raw = localStorage.getItem(K_USER)
  if (!raw) return null
  try {
    return JSON.parse(raw) as SessionUser
  } catch {
    // A corrupt blob would otherwise throw on every render and white-screen the
    // app with no way out but devtools. Treat it as signed out.
    localStorage.removeItem(K_USER)
    return null
  }
}

/** Signed in means BOTH a user and a token. A user with no token is the state left
 *  behind when the backend has no signing secret configured, and letting that count
 *  as signed in would produce an app that renders and then 401s on every request. */
export function isSignedIn(): boolean {
  return !!getToken() && !!getUser()
}

const listeners = new Set<() => void>()

/** Subscribe to sign-in / sign-out. Used by App at the root so a 401 anywhere
 *  returns the whole app to the login screen instead of leaving one dead panel. */
export function onSessionChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
const emit = () => listeners.forEach(f => f())

export function signIn(token: string, user: SessionUser) {
  localStorage.setItem(K_TOKEN, token)
  localStorage.setItem(K_USER, JSON.stringify(user))
  emit()
}

export function signOut() {
  localStorage.removeItem(K_TOKEN)
  localStorage.removeItem(K_USER)
  // Wipe every cached response. It holds one person's tasks, notes and chat
  // previews, and leaving it in memory across a sign-out on a shared machine is
  // the whole reason the cache is not persisted to disk either.
  void import('./cache').then(m => m.invalidate())
  // The base URL and theme survive: they are preferences, not credentials, and
  // wiping the base on sign-out would send the next login at the wrong host.
  emit()
}

/** The signed-in user's id, or throw. Callers inside the authenticated shell can
 *  rely on this; it throwing means a screen rendered outside the shell, which is a
 *  bug worth surfacing loudly rather than papering over with a `?? 0`. */
export function requireUserId(): number {
  const u = getUser()
  if (!u) throw new Error('requireUserId() called while signed out')
  return u.id
}

// ── theme ───────────────────────────────────────────────────────────────────

export type Theme = 'light' | 'dark' | 'system'

export function getTheme(): Theme {
  return (localStorage.getItem(K_THEME) as Theme) || 'system'
}

/** Applies the theme to <html>. Called at boot before first paint and on change,
 *  so there is no flash of the wrong theme. */
export function applyTheme(t: Theme = getTheme()) {
  localStorage.setItem(K_THEME, t)
  const dark = t === 'dark' ||
    (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}
