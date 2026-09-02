/**
 * Is this tab running code from a previous deploy?
 *
 * 🔴 A TAB OPENED BEFORE A DEPLOY KEEPS RUNNING THE OLD BUNDLE, FOREVER, and no
 * amount of redeploying reaches it. That is not a caching bug to fix — it is how
 * the web works: the JavaScript was already downloaded, and nothing re-requests it
 * until the document is reloaded.
 *
 * It matters here more than usual because the backend URL is COMPILED IN
 * (`VITE_BACKEND_URL`). So a stale tab does not merely look old — it calls a host
 * that may no longer exist, and reports a name that appears nowhere in the shipped
 * code, which is genuinely hard to diagnose from the outside.
 *
 * 🔴 AND SIGNING OUT DOES NOT HELP. That clears storage; it does not re-download
 * anything. A tester told to "sign out and sign in" does exactly that, the same
 * stale bundle runs again against the same wrong host, and they loop — which is
 * precisely what happened. Only a reload fixes it.
 *
 * HOW: `index.html` is served `no-cache` while the hashed assets are immutable, so
 * re-fetching the document is cheap and always current. If it names asset hashes
 * this tab is not running, a newer deploy exists.
 *
 * Deliberately advisory. It never reloads on its own — a surprise reload can
 * discard a half-typed message — it reports, and the UI offers the button. The one
 * place we DO force a reload is a stale IDENTITY (see signOutStaleIdentity), where
 * the session is already being destroyed and there is nothing to lose.
 */

/** Asset URLs this document was built with, captured at startup before any
 *  navigation can add more. */
const OWN_ASSETS = new Set(
  Array.from(document.querySelectorAll<HTMLScriptElement>('script[src]'))
    .map(el => el.getAttribute('src') || '')
    .filter(src => src.includes('/assets/')))

export type Freshness = 'current' | 'stale' | 'unknown'

/**
 * Fetch index.html and compare its asset hashes with ours.
 *
 * Returns 'unknown' on any failure — offline, a proxy serving something odd, a
 * dev server with no hashed assets. Never guess 'stale': a false positive nags a
 * user to reload a page that is perfectly fine.
 */
export async function checkFreshness(): Promise<Freshness> {
  if (OWN_ASSETS.size === 0) return 'unknown'   // dev server: unhashed modules
  try {
    // Cache-busted so an intermediary cannot answer with the same document that
    // produced this tab in the first place.
    const res = await fetch(`/?_fresh=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return 'unknown'
    const html = await res.text()
    const live = new Set((html.match(/[^"']*\/assets\/[^"']+\.js/g) ?? []))
    if (live.size === 0) return 'unknown'

    /**
     * 🔴 STALE WHEN ANY OF OUR SCRIPTS IS ABSENT FROM THE LIVE DOCUMENT — not when
     * ALL of them are.
     *
     * The first version required ZERO overlap, reasoning that partial overlap was
     * too weak a signal. That was wrong, and a realistic two-build simulation is
     * what exposed it: a content hash only changes for chunks whose CONTENTS
     * changed, so across a real deploy most bundles keep their exact filename.
     * Measured on two genuine builds of this app — 8 of 12 names identical, only
     * index/format/AppShell/VoiceProvider rotated. Overlap is therefore the NORMAL
     * case on every deploy, and "zero overlap" would essentially never be true:
     * the gate would have shipped permanently dormant while every test of the
     * detector in isolation passed.
     *
     * Any missing script is sufficient and safe: our own document loaded these, so
     * a name the live index no longer mentions means that exact file was replaced.
     * Shared vendor chunks (react, icons) simply never trigger it, which is
     * correct — they are not evidence of anything either way.
     */
    const norm = (u: string) => u.replace(/^.*\/assets\//, 'assets/')
    const theirs = new Set(Array.from(live, norm))
    const missing = Array.from(OWN_ASSETS, norm).filter(a => !theirs.has(a))
    return missing.length > 0 ? 'stale' : 'current'
  } catch {
    return 'unknown'
  }
}

// ── build identity ──────────────────────────────────────────────────────────

/**
 * The build this code was compiled from — a git sha on Vercel, a timestamp
 * locally. See vite.config.ts.
 *
 * Compared for EQUALITY only. It is never ordered or parsed, so "newer" is not a
 * question this can answer — only "different", which is the only question that
 * matters for staleness.
 */
export const BUILD_ID: string =
  typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unknown'

/**
 * The build the SERVER is currently running, as reported by `X-App-Version` on any
 * API response.
 *
 * 🔴 Read off responses the app was making anyway — no poll, no /version endpoint,
 * no extra request. A version check that costs a request gets set to a long
 * interval and then detects staleness minutes late; one that rides existing
 * traffic is immediate and free.
 *
 * Null until a response carries the header, which also covers a backend that does
 * not send it — in which case this whole path stays quiet rather than guessing.
 */
let serverBuild: string | null = null

const buildListeners = new Set<(mismatch: boolean) => void>()

/** Called by the api layer for every response. Cheap and idempotent. */
export function noteServerBuild(v: string | null) {
  if (!v || v === serverBuild) return
  serverBuild = v
  // Only a CONFIRMED disagreement counts. An unknown local build (a dev bundle
  // built before this existed) must not report a mismatch against every response.
  const mismatch = BUILD_ID !== 'unknown' && v !== BUILD_ID
  buildListeners.forEach(f => f(mismatch))
}

export const serverBuildId = () => serverBuild
export function watchBuildMismatch(fn: (mismatch: boolean) => void): () => void {
  buildListeners.add(fn)
  if (serverBuild) fn(BUILD_ID !== 'unknown' && serverBuild !== BUILD_ID)
  return () => buildListeners.delete(fn)
}
