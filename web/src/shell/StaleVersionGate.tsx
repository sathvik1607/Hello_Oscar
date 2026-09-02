import { RefreshCw } from 'lucide-react'
import { signOut } from '../lib/session'
import { BUILD_ID, serverBuildId } from '../lib/freshness'

/**
 * This tab is running code from an earlier deploy. Say so, and say what to do.
 *
 * 🔴 BLOCKING, not a banner, and that is the point. A stale tab cannot be worked
 * around: the backend URL is compiled into the bundle, so old code may be calling a
 * host that no longer exists — every screen behind this is either broken or lying.
 * A dismissable notice on top of a broken app trains people to dismiss it, and the
 * session this was written after was spent diagnosing a tester who kept using such
 * an app instead of reloading it.
 *
 * 🔴 THE ORDER OF THE TWO INSTRUCTIONS IS LOAD-BEARING. Reload FIRST, sign in
 * second — and the copy says outright that signing out alone is not enough,
 * because that is the intuitive fix and it does not work: signing out clears
 * storage, it does not re-download JavaScript. Told only "log out and log in", a
 * user does exactly that, the same stale bundle runs against the same wrong host,
 * and they loop indefinitely having followed the instructions correctly. Naming
 * the useless action explicitly is what stops the loop.
 *
 * The build ids are shown because "which version are you on?" was unanswerable for
 * an entire debugging session, and a screenshot of this answers it.
 */
export function StaleVersionGate() {
  const server = serverBuildId()

  // Sign out BEFORE reloading, so the fresh bundle starts at a clean login rather
  // than rehydrating a session minted against whatever backend the old code was
  // talking to — the stale-identity bug this pairs with.
  const reloadClean = () => {
    signOut()
    location.reload()
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-6"
         style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-md rounded-2xl border p-6"
           style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}>
        <div className="flex size-11 items-center justify-center rounded-xl"
             style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
          <RefreshCw className="size-5" />
        </div>

        <h1 className="mt-4 text-[17px] font-semibold">This page is out of date</h1>

        <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Oscar has been updated since you opened this tab, and this page is still
          running the old version. It may be talking to a server that no longer
          exists, so what you see here can be wrong.
        </p>

        <div className="mt-4 rounded-xl p-3.5 text-[13px] leading-relaxed"
             style={{ background: 'var(--bg-sunken)' }}>
          <p className="font-semibold">Do this:</p>
          <ol className="mt-1.5 list-decimal space-y-1 pl-4">
            <li><span className="font-semibold">Reload this page</span> — use the
              button below, or press <kbd className="rounded px-1 font-mono text-[11px]"
              style={{ background: 'var(--bg)' }}>⌘⇧R</kbd> / <kbd
              className="rounded px-1 font-mono text-[11px]"
              style={{ background: 'var(--bg)' }}>Ctrl⇧R</kbd>.</li>
            <li><span className="font-semibold">Sign in again</span> after it reloads.</li>
          </ol>
          {/* The correction that saves the loop. */}
          <p className="mt-2.5" style={{ color: 'var(--text-subtle)' }}>
            Signing out on its own will <span className="font-semibold">not</span> fix
            this — it does not reload the page, so the old version keeps running.
            You have to reload.
          </p>
        </div>

        <button type="button" onClick={reloadClean}
                className="mt-4 w-full rounded-xl px-4 py-2.5 text-[14px] font-semibold text-white"
                style={{ background: 'var(--accent)' }}>
          Reload and sign in again
        </button>

        <p className="mt-3 text-center font-mono text-[10.5px]"
           style={{ color: 'var(--text-subtle)' }}>
          this tab {BUILD_ID}{server ? ` · server ${server}` : ''}
        </p>
      </div>
    </div>
  )
}
