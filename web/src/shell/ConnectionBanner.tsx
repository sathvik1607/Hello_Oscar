import { useEffect, useState } from 'react'
import { Loader2, WifiOff } from 'lucide-react'
import { connectionState, watchConnection, type ConnState } from '../lib/appSocket'

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

  useEffect(() => watchConnection(setState), [])

  useEffect(() => {
    const on = () => setOffline(false)
    const off = () => setOffline(true)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

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
