import { useCallback, useEffect, useRef, useState } from 'react'
import { send, subscribe } from './appSocket'

/**
 * "X is typing…", both directions.
 *
 * The backend has supported this the whole time and nothing used it:
 * `ws/websocket_router.py` accepts `{type:'typing.changed', to_user_id, typing}`
 * from the client and relays `typing.changed` to that peer alone.
 *
 * DMs only. The relay takes a single `to_user_id`, so there is no group form — and
 * that is the right call anyway: "three people are typing" in a team channel is
 * noise, not information.
 *
 * Ephemeral by design server-side: never persisted, never replayed to a socket that
 * reconnects. So a peer cannot be left looking at a stale "typing…" forever — which
 * is the failure every naive implementation of this has.
 */

/** How long after the last keystroke we claim to have stopped. Long enough to
 *  survive a pause for thought, short enough that closing the tab mid-word does not
 *  leave the indicator up for ages. */
const STOP_AFTER_MS = 2500
/** Minimum gap between "started" signals. Sending one per keystroke would be a
 *  frame per character — the peer only needs to know the state, not the cadence. */
const THROTTLE_MS = 2000

/** Tell a peer we are typing. Returns a function to call on every keystroke. */
export function useTypingSignal(peerId: number | null) {
  const lastSent = useRef(0)
  const stopTimer = useRef<number | undefined>(undefined)

  const stop = useCallback(() => {
    if (peerId == null) return
    lastSent.current = 0
    send({ type: 'typing.changed', to_user_id: peerId, typing: false })
  }, [peerId])

  const onKeystroke = useCallback(() => {
    if (peerId == null) return
    const now = Date.now()
    if (now - lastSent.current > THROTTLE_MS) {
      lastSent.current = now
      send({ type: 'typing.changed', to_user_id: peerId, typing: true })
    }
    if (stopTimer.current) clearTimeout(stopTimer.current)
    stopTimer.current = setTimeout(stop, STOP_AFTER_MS) as unknown as number
  }, [peerId, stop])

  // Say we stopped when the composer goes away — switching conversation, closing
  // the tab. Without this the peer keeps seeing "typing…" from a thread nobody is
  // in any more.
  useEffect(() => () => {
    if (stopTimer.current) clearTimeout(stopTimer.current)
    stop()
  }, [stop])

  return { onKeystroke, stopTyping: stop }
}

/** Whether a given peer is currently typing to us. */
export function usePeerTyping(peerId: number | null): boolean {
  // The state carries WHO it is about, so switching conversation needs no reset —
  // it is simply no longer a match. Resetting in an effect instead meant a setState
  // on every peer change whose only job was to undo the previous one.
  const [who, setWho] = useState<{ peerId: number; typing: boolean } | null>(null)

  useEffect(() => {
    if (peerId == null) return
    let expiry: number | undefined

    const unsub = subscribe(f => {
      if (f.type !== 'typing.changed') return
      const p = (f.payload ?? {}) as Record<string, unknown>
      const from = Number(p.user_id)
      if (from !== peerId) return
      const on = p.typing === true
      setWho({ peerId: from, typing: on })
      if (expiry) clearTimeout(expiry)
      // A local expiry as well as the peer's own "stopped" signal. If their tab
      // dies mid-word that signal never arrives, and an indicator that can stick
      // forever is worse than one that occasionally clears early.
      if (on) {
        expiry = setTimeout(
          () => setWho({ peerId: from, typing: false }), 6000) as unknown as number
      }
    })

    return () => { if (expiry) clearTimeout(expiry); unsub() }
  }, [peerId])

  return who?.peerId === peerId && who.typing
}
