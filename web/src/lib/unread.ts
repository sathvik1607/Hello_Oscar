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
    const onHash = () => {
      if (location.hash.includes('notifications')) setN(0)
    }
    window.addEventListener('hashchange', onHash)

    return () => {
      alive = false
      unsubFrame()
      unsubRecovery()
      window.removeEventListener('hashchange', onHash)
    }
  }, [])

  return n
}
