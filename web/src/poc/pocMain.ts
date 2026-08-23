/**
 * Harness for the Gemini Live POC page. Not part of the app.
 *
 * Deliberately plain DOM and no React: this page must be provably incapable of
 * affecting the app, and importing the app's component tree — with its session
 * store, socket singleton and theme side effects — would defeat that. It also
 * keeps the measurement honest, since React's render work would show up in the
 * CPU numbers being collected.
 *
 * Everything it displays is a number the report needs: per-turn latency, the
 * transcript pair (to judge speech-understanding and response quality), close
 * codes (stability), and a JS-heap sample (memory).
 */

import { GeminiLive } from './geminiLive'

const $ = (id: string) => document.getElementById(id)!
const backend = (import.meta.env.VITE_BACKEND_URL as string) || 'http://localhost:8000'
const wsBase = backend.replace(/^http/, 'ws').replace(/\/$/, '')

let live: GeminiLive | null = null
let heapTimer: number | undefined
const heap: number[] = []
let lastSummary: string | null = null

function log(line: string) {
  const el = $('log')
  const t = new Date().toLocaleTimeString()
  el.textContent = `[${t}] ${line}\n` + el.textContent
}

function setState(s: string) {
  $('state').textContent = s
  $('orb').className = `orb ${s}`
}

function renderTurn(t: { heard: string; said: string; latencyMs: number | null; interrupted: boolean }) {
  const row = document.createElement('div')
  row.className = 'turn'
  row.innerHTML = `
    <div class="lat">${t.latencyMs != null ? t.latencyMs + ' ms' : (t.interrupted ? 'barge-in' : '—')}</div>
    <div>
      <div class="heard">🎤 ${t.heard || '(no transcript)'}</div>
      <div class="said">🔊 ${t.said || '(no transcript)'}</div>
    </div>`
  $('turns').prepend(row)
  refreshSummary()
}

/** Render the metrics panel and return the exact text rendered.
 *
 *  Returns the string rather than only writing it to the DOM so the copy button
 *  can copy CURRENT numbers instead of re-reading whatever the panel happened to
 *  be showing — which, before this, could be the placeholder. */
function refreshSummary(): string | null {
  // `lastSummary` survives Stop, because the numbers are most wanted exactly
  // after a session ends and `live` is null by then.
  if (live) {
    const mem = heap.length
      ? `${Math.round(Math.min(...heap) / 1e6)}–${Math.round(Math.max(...heap) / 1e6)} MB`
      : 'n/a'
    lastSummary = JSON.stringify({ ...live.summary(), jsHeap: mem }, null, 2)
  }
  if (lastSummary) $('summary').textContent = lastSummary
  return lastSummary
}

async function start() {
  const k = ($('secret') as HTMLInputElement).value.trim()
  const voice = ($('voice') as HTMLSelectElement).value
  if (!k) { log('⚠️ ADMIN_SECRET required — the relay fails closed without it'); return }

  // user_id is what arms the tool bridge. Omitted when blank rather than sent
  // empty, because the relay treats "no user" as "no tools" and an empty string
  // would read as a malformed id instead of an intentional opt-out.
  const uid = ($('uid') as HTMLInputElement).value.trim()
  const url = `${wsBase}/voice/gemini/live?k=${encodeURIComponent(k)}&voice=${voice}`
    + (uid ? `&user_id=${encodeURIComponent(uid)}` : '')
  log(`connecting → ${url.replace(/k=[^&]+/, 'k=***')}`)
  log(uid
    ? `tools ARMED for user ${uid} — actions are real (backend also needs GEMINI_LIVE_TOOLS=1)`
    : 'no user_id → tools OFF, conversation only')

  live = new GeminiLive(url, {
    onState: setState,
    onLevel: rms => { ($('level') as HTMLElement).style.width = `${Math.min(100, rms * 900)}%` },
    onTurn: renderTurn,
    onLog: log,
    onError: m => log(`❌ ${m}`),
  })
  try {
    await live.start()
    ;($('start') as HTMLButtonElement).disabled = true
    ;($('stop') as HTMLButtonElement).disabled = false
    // performance.memory is Chrome-only and approximate; sampled anyway because
    // "does an hour-long session leak" is a question the report has to answer,
    // and a coarse answer beats none. Absent in Safari/Firefox → reported n/a.
    const m = (performance as any).memory
    if (m) {
      heapTimer = window.setInterval(() => {
        heap.push(m.usedJSHeapSize)
        refreshSummary()
      }, 3000)
    } else {
      log('note: performance.memory unavailable (not Chrome) — heap not sampled')
    }
  } catch (e: any) {
    log(`❌ start failed: ${e?.message || e}`)
  }
}

async function stop() {
  if (heapTimer) clearInterval(heapTimer)
  refreshSummary()
  log('--- final: ' + JSON.stringify(live?.summary()))
  await live?.stop()
  live = null
  ;($('start') as HTMLButtonElement).disabled = false
  ;($('stop') as HTMLButtonElement).disabled = true
}

$('start').addEventListener('click', start)
$('stop').addEventListener('click', stop)
$('interrupt').addEventListener('click', () => live?.interrupt())
$('copy').addEventListener('click', async () => {
  const text = refreshSummary()
  // Nothing to copy is a real outcome, not a silent no-op: the old version
  // cheerfully copied the literal placeholder "start a session".
  if (!text) { log('⚠️ nothing to copy yet — run at least one turn first'); return }
  try {
    // Requires a secure context. localhost qualifies, a plain-http LAN address
    // does NOT — and that failure is exactly why the result is now reported.
    await navigator.clipboard.writeText(text)
    log(`metrics copied (${text.length} chars)`)
  } catch (e: any) {
    // Never claim success on a rejected promise. The metrics are printed to the
    // log instead so the numbers are still recoverable by selecting text.
    log(`❌ clipboard blocked (${e?.name || e}) — metrics printed below instead`)
    log(text)
  }
})

log(`backend: ${backend}`)
log('POC only — no Oscar agent, no tools, nothing persisted.')
