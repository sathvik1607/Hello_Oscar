import { useEffect, useState } from 'react'
import { notifications as notifApi } from './api'
import { onRecovered, subscribe } from './appSocket'

/**
 * How many unread notifications there are, live.
 *
 * Both the COUNT and its single WS/read subscription live at module level,
 * established exactly once (`_started`), not re-created per mount of the hook.
 *
 * React 19 StrictMode mounts an effect twice in dev; with the subscription
 * created fresh inside the hook's own effect, a fast navigation could leave a
 * stale mount's `subscribe()`/notifyOneRead listener registered without its
 * cleanup ever running (observed live: two live listeners simultaneously, no
 * click in between), so a single `notification.created` frame or a single
 * notifyOneRead() call fired twice — the badge silently jumped by 2 instead of
 * 1. Doing the real subscribing ONCE, ever, for the life of the module removes
 * the class of bug outright: the hook itself only ever reads/renders the
 * module's count, never owns a subscription of its own.
 */
let _count = 0
const _listeners = new Set<(n: number) => void>()
let _started = false

function _setCount(n: number) {
  _count = Math.max(0, n)
  for (const fn of _listeners) fn(_count)
}

async function _seed() {
  try {
    const rows = await notifApi.list(true)
    _setCount(rows.length)
  } catch { /* a badge is not worth surfacing an error for */ }
}

/** Runs exactly once for the life of the module — the ONE real WS/read
 *  subscription, regardless of how many times useUnreadCount mounts. */
function _start() {
  if (_started) return
  _started = true
  void _seed()
  subscribe(f => {
    if (f.type === 'notification.created') _setCount(_count + 1)
  })
  onRecovered(() => { void _seed() })
}

/** "One notification was marked read" — called by NotificationsScreen.open()
 *  and NotificationToasts right after their own markRead(id) succeeds.
 *
 * 🔴 Deliberately NOT fired by merely opening/navigating to Activity — that used
 * to hard-reset the badge to 0 the instant the screen mounted, before any row was
 * actually read. Two unread items opened the list and both instantly vanished
 * from the badge with nothing clicked — the badge stopped meaning "unread count"
 * and became "have you glanced at the list". Decrementing per-row instead keeps
 * the badge accurate to what has genuinely been read, one at a time. */
export function notifyOneRead(): void {
  _setCount(_count - 1)
}

/** "Mark all read" was clicked — the one case that DOES zero the badge outright,
 *  because every row genuinely became read at once, not merely viewed. */
export function notifyAllRead(): void {
  _setCount(0)
}

export function useUnreadCount(): number {
  // Lazy initializer reads _count at RENDER time, not react to it after commit
  // — covers the same "module already changed before this mount" case a
  // setN(_count) inside the effect would, without the extra render that causes.
  const [n, setN] = useState(() => _count)

  useEffect(() => {
    _start()
    _listeners.add(setN)
    return () => { _listeners.delete(setN) }
  }, [])

  return n
}
