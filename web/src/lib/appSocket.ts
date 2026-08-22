/**
 * ONE app WebSocket for the whole page.
 *
 * The backend's `/ws` is per-user and process-local: frames go only to that user's
 * sockets on that instance. Opening a second one is not merely wasteful — every
 * frame is then delivered twice, and since `/chat/stream` only checks that *a*
 * socket exists, two of them means chat deltas race and the visible reply
 * interleaves with itself.
 *
 * So this is a module-level singleton with reference counting. Screens subscribe
 * and unsubscribe; the socket opens on the first subscriber and closes when the
 * last one leaves the page — not when a screen unmounts, because navigating from
 * Tasks to Chat would otherwise tear down and re-establish the connection and lose
 * whatever arrived in between.
 *
 * The voice engine is the deliberate exception: LiveVoice owns its own socket. It
 * needs the connection to exist BEFORE the first question is asked (`/chat/stream`
 * short-circuits without one) and its lifetime is the call, not the page. Sharing
 * one would couple a hang-up to the notification feed.
 */

import { getToken, getWsBase, getUser } from './session'

export type Frame = { type: string; timestamp?: string; payload?: Record<string, unknown> }
export type ConnState = 'connecting' | 'open' | 'reconnecting' | 'closed'

type Handler = (f: Frame) => void

const handlers = new Set<Handler>()
const stateWatchers = new Set<(s: ConnState) => void>()
/**
 * Called after a DROPPED connection comes back — never on the first connect.
 *
 * 🔴 This exists because frames sent while the socket was down are GONE. The
 * backend replays only unread `direct_message` on reconnect; a task completed, a
 * comment posted or a meeting cancelled during a thirty-second drop is never
 * re-sent. Without this the app sits on silently stale data and looks fine, which
 * is the worst failure mode available — the user has no reason to reload.
 *
 * Separate from `watchConnection` on purpose: "are we connected" and "did we miss
 * something" are different questions, and a screen that refetched on every state
 * change would refetch on the first connect too, doubling every page load.
 */
const recoveryWatchers = new Set<() => void>()

let ws: WebSocket | null = null
let state: ConnState = 'closed'
let retries = 0
let reconnectTimer: number | undefined
/** Set when the caller asked to close. Distinguishes "we hung up" from "the network
 *  dropped" — without it, an intentional sign-out immediately reconnects. */
let intentional = false

function setState(s: ConnState) {
  if (state === s) return
  state = s
  stateWatchers.forEach(f => f(s))
}

export const connectionState = () => state

/**
 * Exponential backoff, capped, with jitter.
 *
 * The cap matters because a free-tier backend that is spinning up will refuse
 * connections for ~50 seconds; without a cap the delay grows past the point where
 * the app notices it came back. The jitter matters because every open tab of this
 * app would otherwise retry on exactly the same schedule and arrive as a thundering
 * herd the moment the server accepts connections again.
 */
function backoffMs(): number {
  const base = Math.min(1000 * 2 ** retries, 20_000)
  return base + Math.random() * 400
}

function open() {
  const user = getUser()
  if (!user) return                       // signed out — nothing to subscribe to
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  intentional = false
  setState(retries === 0 ? 'connecting' : 'reconnecting')

  const token = getToken()
  // The token rides as ?t= because a browser cannot set headers on a WebSocket.
  // user_id stays for the server's own routing; the server rejects the pair when
  // they disagree, so this cannot be used to subscribe to somebody else's feed.
  const url = `${getWsBase()}/ws?user_id=${user.id}` +
    (token ? `&t=${encodeURIComponent(token)}` : '')

  const sock = new WebSocket(url)
  ws = sock

  sock.onopen = () => {
    // `retries > 0` is precisely "this is a RE-connect". On a first connect the
    // screens have just fetched, so firing recovery would be a wasted round trip.
    const recovered = retries > 0
    retries = 0
    setState('open')
    if (recovered) {
      recoveryWatchers.forEach(f => {
        try { f() } catch (e) { console.error('[ws] recovery handler threw', e) }
      })
    }
  }

  sock.onmessage = e => {
    let f: Frame
    try { f = JSON.parse(e.data) } catch { return }   // non-JSON is ignored by contract

    // The server pings every 30s and closes with 4002 if no pong arrives inside 90s.
    // Answered here rather than exposed to subscribers: a missed pong is a dropped
    // connection, and no screen should be able to cause one by forgetting.
    if (f.type === 'connection.ping') {
      try { sock.send(JSON.stringify({ type: 'connection.pong' })) } catch { /* closing */ }
      return
    }

    // A throwing handler must not stop the frame reaching the others — one screen's
    // render bug would otherwise silently kill notifications app-wide.
    handlers.forEach(h => {
      try { h(f) } catch (err) { console.error('[ws] handler threw', err) }
    })
  }

  sock.onclose = ev => {
    ws = null
    if (intentional || handlers.size === 0) { setState('closed'); return }
    // 1008 is the server refusing our credentials. Retrying cannot fix that and
    // would spin forever against a rejected token, so stop and let the next API
    // call surface the 401 that returns the user to the login screen.
    if (ev.code === 1008) { setState('closed'); return }
    retries += 1
    setState('reconnecting')
    reconnectTimer = setTimeout(open, backoffMs()) as unknown as number
  }

  sock.onerror = () => { /* onclose always follows; handled there */ }
}

/** Subscribe to frames. Returns an unsubscribe — call it from an effect's cleanup.
 *  Double-invoking the cleanup is safe (Set.delete is idempotent), which matters
 *  under React StrictMode's deliberate double-mount in development. */
export function subscribe(h: Handler): () => void {
  handlers.add(h)
  if (handlers.size === 1) open()
  return () => {
    handlers.delete(h)
    if (handlers.size === 0) close()
  }
}

/** Subscribe to "the connection dropped and came back — refetch". */
export function onRecovered(f: () => void): () => void {
  recoveryWatchers.add(f)
  return () => { recoveryWatchers.delete(f) }
}

export function watchConnection(f: (s: ConnState) => void): () => void {
  stateWatchers.add(f)
  f(state)                                 // current state immediately, not on next change
  return () => { stateWatchers.delete(f) }
}

/**
 * Send a frame to the server.
 *
 * The socket has only ever RECEIVED until now; typing is the first thing the
 * client tells the server over it. Fire-and-forget by design: the return value says
 * whether it went out, and no caller should care — a dropped typing signal is
 * invisible, whereas an error path for one would be noise. Anything that must not
 * be lost belongs in an HTTP request, not here.
 */
export function send(frame: Record<string, unknown>): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false
  try {
    ws.send(JSON.stringify(frame))
    return true
  } catch {
    return false
  }
}

export function close() {
  intentional = true
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined }
  retries = 0
  try { ws?.close() } catch { /* already gone */ }
  ws = null
  setState('closed')
}

/** Re-open with fresh credentials. Called on sign-in, and on sign-out to tear the
 *  old user's subscription down before the next one's is created — otherwise the
 *  previous socket outlives the session that authorised it. */
export function reset() {
  close()
  if (handlers.size > 0) { intentional = false; open() }
}

/** Come back immediately when the tab is focused again, instead of waiting out a
 *  backoff that may have grown to 20s while the laptop was asleep. A browser does
 *  not reliably fire `close` for a socket that died while the tab was hidden, so
 *  without this the app can sit on a dead connection that still reads as open. */
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (handlers.size === 0) return
    if (!ws || ws.readyState > WebSocket.OPEN) {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      retries = 0
      open()
    }
  })
  window.addEventListener('online', () => {
    if (handlers.size > 0 && (!ws || ws.readyState > WebSocket.OPEN)) {
      if (reconnectTimer) clearTimeout(reconnectTimer)
      retries = 0
      open()
    }
  })
}
