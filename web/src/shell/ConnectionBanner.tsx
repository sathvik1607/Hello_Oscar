import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, WifiOff } from 'lucide-react'
import { connectionState, watchConnection, type ConnState } from '../lib/appSocket'
import { checkFreshness } from '../lib/freshness'

/**
 * The live-connection state, stated plainly.
 *
 * This is not decoration. When the socket is down, `/chat/stream` refuses to
 * generate at all (the backend will not bill a reply nobody can see) and no
 * notification, task update or DM arrives. Without a banner the app looks working
 * and is silently stale — the worst of the two failure modes, because the user has
 * no reason to reload.
 *
 * Deliberately silent while 'connecting': a banner that flashes on every page load
 * trains people to ignore banners. It appears only once the connection is actually
 * in trouble.
 */
export function ConnectionBanner() {
  const [state, setState] = useState<ConnState>(connectionState())
  const [offline, setOffline] = useState(!navigator.onLine)
  const [stale, setStale] = useState(false)

  useEffect(() => watchConnection(setState), [])

  /**
   * 🔴 A tab left open across a deploy runs the OLD code, including the OLD backend
   * URL (it is compiled in), and nothing re-downloads it until the page reloads. The
   * user has no way to know: the app renders, and the errors blame a host or a
   * password instead. Signing out does NOT fix it either — that clears storage, not
   * the bundle — so "sign out and sign in" sends someone round a loop that cannot
   * terminate. This banner is the only thing that names the real action.
   *
   * Checked on mount and whenever the tab is brought back to the foreground, which
   * is when a long-lived tab is most likely to have gone stale. No polling: a
   * background timer hitting the origin every minute for the life of a tab costs
   * more than it is worth.
   */
  useEffect(() => {
    let alive = true
    const run = () => { void checkFreshness().then(f => { if (alive) setStale(f === 'stale') }) }
    run()
    const onVis = () => { if (document.visibilityState === 'visible') run() }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive = false; document.removeEventListener('visibilitychange', onVis) }
  }, [])

  useEffect(() => {
    const on = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  /**
   * FIRST, above offline and reconnecting. A stale tab is the one failure the user
   * cannot wait out — every other banner here resolves itself, this one never does,
   * and until it is dealt with the other two may be reporting a backend this build
   * should not even be talking to.
   *
   * A button, not an automatic reload: discarding a half-written message to fix
   * something the user did not notice is its own bug.
   */
  if (stale) {
    return (
      <Bar tone="warn" icon={<RefreshCw className="size-3.5" />}>
        A new version of Oscar is available.{' '}
        <button type="button" onClick={() => location.reload()}
                className="font-semibold underline underline-offset-2">
          Reload
        </button>{' '}
        to get it — signing out will not.
      </Bar>
    )
  }

  // The browser knowing it is offline is more specific than our socket noticing,
  // so it wins the message.
  if (offline) {
    return (
      <Bar tone="warn" icon={<WifiOff className="size-3.5" />}>
        You're offline. Oscar will catch up when the connection returns.
      </Bar>
    )
  }
  if (state === 'reconnecting') {
    return (
      <Bar tone="warn" icon={<Loader2 className="size-3.5 animate-spin" />}>
        Reconnecting to Oscar — replies and reminders are paused.
      </Bar>
    )
  }
  return null
}

function Bar({ children, icon }: { tone: 'warn'; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div role="status"
         className="fade flex items-center justify-center gap-2 px-4 py-2 text-[12px] font-medium"
         style={{ background: 'rgba(245,158,11,.12)', color: '#B45309' }}>
      {icon}{children}
    </div>
  )
}
