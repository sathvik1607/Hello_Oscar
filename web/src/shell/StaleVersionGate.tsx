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

  /**
   * Reload. Does NOT sign the user out.
   *
   * 🔴 It used to, and that was wrong for a client-facing app: a stale BUNDLE says
   * nothing about whether the SESSION is bad. The overwhelmingly common case is a
   * tab open across a routine deploy where the backend has not moved — so signing
   * out made a routine refresh cost a re-login, which for anyone who does not have
   * their password to hand is a much bigger interruption than the problem.
   *
   * A session that genuinely is invalid is already handled elsewhere and more
   * precisely: a 401 signs out through the api client, and a cached identity from
   * another database is caught by identityIsStale. Neither needs this button's
   * help, and pre-emptively destroying a good session to cover a case those two
   * already own is the kind of "safe" that is actually just lossy.
   */
  const reloadClean = () => location.reload()

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-6"
         style={{ background: 'var(--bg)' }}>
      <div className="w-full max-w-sm text-center">
        <h1 className="text-[17px] font-semibold">Oscar has been updated</h1>

        {/* One sentence, and it names the action. The long version of this card
            explained caching, listed two numbered steps and spent a paragraph on
            why signing out does not help — all true, none of it what someone
            staring at a stuck page needs. The button does the work; the only
            thing worth saying in words is that reloading is what fixes it. */}
        <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          This page is running an old version. Reload to continue — signing out
          won’t fix it.
        </p>

        <button type="button" onClick={reloadClean}
                className="mt-5 w-full rounded-xl px-4 py-2.5 text-[14px] font-semibold text-white"
                style={{ background: 'var(--accent)' }}>
          Reload
        </button>

        {/* Kept: it is the one fact that made this class of bug diagnosable at all,
            and a screenshot of it answers "which build are you on?". */}
        <p className="mt-3 font-mono text-[10.5px]" style={{ color: 'var(--text-subtle)' }}>
          {BUILD_ID}{server ? ` · server ${server}` : ''}
        </p>
      </div>
    </div>
  )
}
