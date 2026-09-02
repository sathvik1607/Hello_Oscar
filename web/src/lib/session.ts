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

/** The URL compiled into this build. Empty string when the env var is unset, which
 *  is how `BUILT_IN` below distinguishes "a deploy told us where the backend is"
 *  from "nobody said, fall back to localhost". */
const BUILT_IN =
  (import.meta.env.VITE_BACKEND_URL as string | undefined)?.replace(/\/+$/, '') ?? ''

export const DEFAULT_BASE = BUILT_IN || 'http://127.0.0.1:8000'

/**
 * Backend origin.
 *
 * 🔴 A BUILD-TIME URL WINS OVER A SAVED ONE, and that ordering is the whole point.
 * It used to be the other way round — `localStorage || DEFAULT_BASE` — which meant
 * a value saved once from Settings silently beat every future deploy: the app kept
 * calling a backend that had since been suspended, the error named a host that
 * appears nowhere in the shipped bundle, and no amount of redeploying or
 * cache-clearing could fix it because the wrong URL was in the browser, not the
 * code. (The admin panel had the identical bug and was fixed the same way.)
 *
 * The runtime override survives where it is actually useful: local development,
 * where VITE_BACKEND_URL is the localhost default, so Settings can still point a
 * dev server at dev or prod without a rebuild.
 *
 * A stale key is PURGED rather than merely ignored, so it cannot resurface if this
 * precedence is ever revisited.
 */
export function getBase(): string {
  const saved = localStorage.getItem(K_BASE)?.replace(/\/+$/, '') || ''
  if (BUILT_IN) {
    if (saved && saved !== BUILT_IN) localStorage.removeItem(K_BASE)
    return BUILT_IN
  }
  return saved || DEFAULT_BASE
}

/** Point this browser at another backend. Only takes effect when the build carries
 *  no URL of its own (i.e. local dev) — see getBase(). */
export function setBase(url: string) {
  localStorage.setItem(K_BASE, url.replace(/\/+$/, ''))
}

/** Is the runtime override actually honoured? False on a real deploy. Lets Settings
 *  say so instead of offering a field that silently does nothing. */
export const baseIsLocked = () => !!BUILT_IN

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

/**
 * Is the cached identity still valid on the backend we are now talking to?
 *
 * 🔴 A TOKEN SURVIVES A DATABASE SWAP, AND THAT IS THE WHOLE PROBLEM. The bearer
 * token is an HMAC over a user id with nothing binding it to a particular database,
 * so pointing the app at a different backend leaves `oscar.web.user` holding an id
 * from the OLD one — and it still verifies. Login succeeds, the shell renders your
 * name, and then every id-scoped call asks about a person who does not exist there.
 *
 * Observed: the app was repointed from a prod backend to `epa-3` (which runs against
 * the DEV database). The same human is a different id in each — Sathvik is 48 on
 * dev, Vijender 45 on dev and 4 on prod — so My Team requested
 * `/teams/7/members/<old id>/tasks` and got a red "Member not in this team" card on
 * a team that was in perfect health. The screen looked broken; the data was fine and
 * the cached id was stale.
 *
 * Rather than add a startup probe, this reuses a roster the screen already fetches:
 * if the signed-in id is absent from its own team's member list, the cached identity
 * cannot be right. Cheap, and no new endpoint (there is no `/me`, and the
 * user-scoped reads answer 200-with-nothing for an unknown id, so they cannot tell
 * "no data" from "no such user" — the only route that does validate is a POST that
 * calls an LLM).
 *
 * Returns true only for a CONFIRMED mismatch: an empty or failed roster returns
 * false, because signing someone out over a network blip is worse than the
 * confusing screen this exists to prevent.
 */
export function identityIsStale(roster: { user_id: number }[] | null | undefined): boolean {
  const u = getUser()
  if (!u || !roster || roster.length === 0) return false
  return !roster.some(m => m.user_id === u.id)
}

const K_SIGNOUT_REASON = 'oscar.web.signout_reason'

/** Sign out because the cached identity belongs to another backend's database.
 *  Leaves a one-shot reason behind so the login screen can say WHY — being bounced
 *  to a login screen with no explanation reads as a bug, and the honest sentence
 *  ("this account is from a different backend") is also the one that stops someone
 *  retrying the same password three times. */
export function signOutStaleIdentity() {
  try { localStorage.setItem(K_SIGNOUT_REASON, 'stale_identity') } catch { /* private mode */ }
  signOut()
}

/** Read AND clear the reason — one-shot, so it explains the redirect that just
 *  happened and never a later visit. */
export function takeSignOutReason(): string | null {
  const r = localStorage.getItem(K_SIGNOUT_REASON)
  if (r) localStorage.removeItem(K_SIGNOUT_REASON)
  return r
}
