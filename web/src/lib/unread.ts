import { useEffect, useState } from 'react'
import { notifications as notifApi } from './api'
import { onRecovered, subscribe } from './appSocket'

/**
 * How many unread notifications there are, live.
 *
 * ONE subscription for the whole app, held at the root. Counting inside the
 * Activity screen — which is where it started — means the badge only works while
 * you are looking at the badge.
 *
 * Seeded from the server rather than counted from zero: notifications that arrived
 * while the tab was closed are already unread, and a badge that starts at 0 after
 * every reload is worse than no badge, because it actively says "nothing new".
 */
/**
 * "Activity was opened" — called by App's navigate().
 *
 * 🔴 A SIGNAL, NOT A URL LISTENER, and that is a bug fix rather than a port.
 * This used to hang off `hashchange` and test `location.hash.includes('notifications')`,
 * which failed in two ways: `hashchange` does NOT fire when the hash is assigned the
 * value it already holds, so re-opening Activity from Activity left the badge up;
 * and `includes` is a substring test on a string the router does not own. The
 * navigation itself is the actual event, so it is the thing that should say so.
 *
 * A module-level set rather than a React context: the count lives in a hook mounted
 * once at the root, and threading a context through the shell for one boolean is
 * more moving parts than a subscription.
 */
const _opened = new Set<() => void>()

export function notifyActivityOpened(): void {
  for (const fn of _opened) fn()
}

export function useUnreadCount(): number {
  const [n, setN] = useState(0)

  useEffect(() => {
    let alive = true
    const seed = async () => {
      try {
        const rows = await notifApi.list(true)
        if (alive) setN(rows.length)
      } catch { /* a badge is not worth surfacing an error for */ }
    }
    void seed()

    const unsubFrame = subscribe(f => {
      if (f.type === 'notification.created') setN(c => c + 1)
    })
    // After a drop, the count is re-read rather than incremented — frames missed
    // while offline were never delivered, so the local tally is simply wrong.
    const unsubRecovery = onRecovered(() => { void seed() })

    // Opening Activity is the natural "I have seen these" signal.
    const onOpened = () => setN(0)
    _opened.add(onOpened)

    return () => {
      alive = false
      unsubFrame()
      unsubRecovery()
      _opened.delete(onOpened)
    }
  }, [])

  return n
}
