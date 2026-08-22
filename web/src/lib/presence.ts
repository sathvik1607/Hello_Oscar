import { useEffect, useState } from 'react'
import { subscribe } from './appSocket'

/**
 * Live online/offline, overlaid on what the members fetch reported.
 *
 * The backend emits `presence.changed` whenever a teammate's first socket connects
 * or their last one disconnects — and nothing in this app was listening, so the
 * dots came only from `GET /teams/{id}/members` and were frozen at fetch time.
 * Someone coming online never lit up.
 *
 * An OVERLAY rather than a replacement, and that ordering is deliberate: the fetch
 * is the baseline truth for people we have heard nothing about, and a live frame
 * wins for anyone we have. Storing only live state would show everybody offline
 * until they happened to reconnect; storing only the fetch is what we had.
 *
 * `online` is derived server-side from the WebSocket registry, so it is only ever
 * meaningful about a live process — and `last_seen` is stamped when a person's LAST
 * socket disconnects, which is why it is null while they are online.
 */
export type Presence = { online: boolean; last_seen: string | null }

export function usePresence(): Map<number, Presence> {
  const [live, setLive] = useState<Map<number, Presence>>(() => new Map())

  useEffect(() => subscribe(f => {
    if (f.type !== 'presence.changed') return
    const p = (f.payload ?? {}) as Record<string, unknown>
    const id = Number(p.user_id)
    if (!id) return
    setLive(prev => {
      // A new Map, not a mutation: React compares by identity, and mutating in
      // place would leave every consumer rendering the previous value.
      const next = new Map(prev)
      next.set(id, {
        online: p.online === true,
        last_seen: typeof p.last_seen === 'string' ? p.last_seen : null,
      })
      return next
    })
  }), [])

  return live
}

/** The fetched row, corrected by anything live. Use this rather than reading
 *  `member.online` directly, or the dot is stale the moment someone connects. */
export function resolvePresence(
  live: Map<number, Presence>,
  userId: number,
  fetched: { online?: boolean; last_seen?: string | null },
): Presence {
  const l = live.get(userId)
  if (l) return l
  return { online: fetched.online === true, last_seen: fetched.last_seen ?? null }
}
