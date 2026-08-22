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

function refreshSummary() {
  if (!live) return
  const s = live.summary()
  const mem = heap.length
    ? `${Math.round(Math.min(...heap) / 1e6)}–${Math.round(Math.max(...heap) / 1e6)} MB`
    : 'n/a'
  $('summary').textContent = JSON.stringify({ ...s, jsHeap: mem }, null, 2)
}

async function start() {
  const k = ($('secret') as HTMLInputElement).value.trim()
  const voice = ($('voice') as HTMLSelectElement).value
  if (!k) { log('⚠️ ADMIN_SECRET required — the relay fails closed without it'); return }

  const url = `${wsBase}/voice/gemini/live?k=${encodeURIComponent(k)}&voice=${voice}`
  log(`connecting → ${url.replace(/k=[^&]+/, 'k=***')}`)

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
$('copy').addEventListener('click', () => {
  navigator.clipboard.writeText($('summary').textContent || '')
  log('summary copied')
})

log(`backend: ${backend}`)
log('POC only — no Oscar agent, no tools, nothing persisted.')
