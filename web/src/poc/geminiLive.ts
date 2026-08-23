/**
 * Gemini 2.5 Flash Live — browser client for the POC.
 *
 * `mic → Gemini Live → speaker`, and that is the whole pipeline. Compare
 * `liveVoice.ts`, which orchestrates five sockets and four services to do the
 * same job:
 *
 *   liveVoice.ts   TTS ws + app ws + session POST + STT ws + mic
 *                  → wakeStrip, firstChunkEnd, 250 ms/6 s idle timers,
 *                    half-duplex mic gate, MediaSource mp3 playback
 *   this file      ONE socket + mic
 *                  → no sentence splitting, no idle timers, no mic gate
 *
 * 🔴 NOT A REPLACEMENT, AND STILL NOT WIRED INTO THE APP. Nothing here imports
 * `liveVoice.ts` and nothing in the app imports this; it is reached only from
 * `poc-gemini.html`, which is not in the production build.
 *
 * ⚠️ As of Phase 2 it DOES reach the Oscar agent — but only through the relay's
 * single `ask_oscar` bridge, and only when a `user_id` is supplied AND the backend
 * runs with `GEMINI_LIVE_TOOLS=1`. This file declares no tools, names no tool, and
 * cannot invoke one: it sees a `toolCall` frame only as something to display. The
 * execution happens server-side, inside the LangGraph, so the confirmation gate
 * and disambiguation still stand between a spoken sentence and a destructive
 * write. `/chat/stream` and chat persistence remain untouched.
 *
 * WHAT IS REUSED VERBATIM from the shipping pipeline, because it already emits
 * exactly what the Live API wants: the capture chain. 16 kHz mono PCM16 in 100 ms
 * frames is both what Sarvam needs and what Gemini needs, so `toPcm16` and the
 * frame-accumulation loop are ported unchanged.
 *
 * 🔴 100 ms FRAMES ARE MANDATORY, and this is the single most expensive thing
 * learned building the Sarvam path — 20 ms frames (what a mic naturally emits)
 * transcribe as `"Rem, Rem, Rem"` and the socket reports no error at all.
 */

import { GEMINI_OUTPUT_RATE, PcmPlayer } from '../lib/pcmPlayer'

const FRAME_MS = 100
/** Gemini's input rate. Fixed by the API — `audio/pcm;rate=16000` is asserted in
 *  the mime type we send, so sending 48 kHz here means Gemini hears speech at a
 *  third speed and transcribes gibberish rather than erroring. */
const TARGET_SR = 16000

/**
 * Local speech-end detection — FOR MEASUREMENT ONLY.
 *
 * 🔴 This does NOT end the turn. Gemini's own server-side VAD does that, which is
 * the entire point of the experiment. But the latency question the POC has to
 * answer is "how long from when I stop talking until I hear a reply", and only the
 * browser knows when the user stopped talking in wall-clock terms. So this is an
 * observer: it stamps t0 and is never allowed to influence what is sent.
 *
 * 500 ms rather than the Sarvam path's 800: this timer is not cutting a sentence
 * in half (Gemini decides that), so it can be tighter without the confetti-
 * transcript failure. It only needs to be longer than a within-sentence pause to
 * avoid stamping t0 early and UNDER-reporting latency.
 */
const OBSERVER_SILENCE_MS = 500
const OBSERVER_RMS = 0.012

export type Turn = {
  /** ms from speech end to the LAST audio chunk of the reply. With blocking calls
   *  this is what the user actually waits for; first-audio alone can look fast
   *  while the real answer is still seconds away. */
  finalMs?: number | null
  /** 🔴 THE METRIC THAT PROVES NON_BLOCKING. True when Gemini began speaking
   *  BEFORE the tool result came back — i.e. it filled the silence instead of
   *  sitting in it. False means the flag changed nothing observable. */
  spokeBeforeTool?: boolean | null
  /** Audio began again after the tool result landed — the "correcting itself"
   *  half of non-blocking. Two bursts is expected and correct; what is NOT
   *  acceptable is two bursts that OVERLAP. */
  secondBurst?: boolean | null
  toolMs?: number | null
  /** What Gemini heard, from `inputTranscription`. */
  heard: string
  /** What Gemini said, from `outputTranscription`. */
  said: string
  /** ms from the user falling silent to the first sample reaching the speaker.
   *  Null when it could not be measured honestly (e.g. barge-in mid-reply). */
  latencyMs: number | null
  interrupted: boolean
}

export type GeminiHandlers = {
  onState: (s: 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking') => void
  onLevel: (rms: number) => void
  onTurn: (t: Turn) => void
  onLog: (line: string) => void
  onError: (msg: string) => void
}

/** Downsample the browser's native rate (usually 48 kHz float) to 16 kHz PCM16.
 *  Averaged, not decimated — plain decimation aliases and measurably degrades
 *  sibilants, which is a transcription problem, not just a quality one.
 *  Ported unchanged from liveVoice.ts. */
function toPcm16(input: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / TARGET_SR
  const outLen = Math.floor(input.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    const v = sum / Math.max(1, end - start)
    out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff
  }
  return out
}

function b64(samples: Int16Array): string {
  const u8 = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let s = ''
  // Chunked: String.fromCharCode(...u8) blows the argument limit on anything
  // over ~64 kB, and a 100 ms frame is 3.2 kB — fine now, a landmine if the
  // frame size is ever raised.
  const CH = 0x8000
  for (let i = 0; i < u8.length; i += CH) {
    s += String.fromCharCode(...u8.subarray(i, i + CH))
  }
  return btoa(s)
}

export class GeminiLive {
  private h: GeminiHandlers
  private url: string
  private ws?: WebSocket
  private player = new PcmPlayer({
    onStart: () => this.onAudioStart(),
    onDrain: () => this.onAudioDrain(),
  })
  private stream?: MediaStream
  private ctx?: AudioContext
  private node?: ScriptProcessorNode
  private src?: MediaStreamAudioSourceNode
  private pending: number[] = []
  private running = false

  // ── measurement state ──────────────────────────────────────────────────────
  private loudAt = 0
  private silenceStamped = false
  private speechEndAt: number | null = null
  private awaitingAudio = false
  private turn: Turn = { heard: '', said: '', latencyMs: null, interrupted: false }
  // Per-turn ordering state. All of it exists to answer one question: did audio
  // start before or after the tool answered?
  private toolAtMs: number | null = null
  private firstAudioAtMs: number | null = null
  private speaking = false
  /** 🔴 Overlapping speech: a new burst starting while the previous one is still
   *  playing. The ring buffer would mix them into gibberish, so this is the
   *  failure mode that would disqualify non-blocking outright. */
  overlaps = 0
  /** Every completed turn's latency, so the report quotes a distribution and not
   *  one lucky number. */
  readonly latencies: number[] = []
  /** Frames sent / audio chunks received — a stability signal that survives a
   *  session ending badly, unlike anything printed at the end. */
  stats = { framesSent: 0, chunksIn: 0, turns: 0, interruptions: 0, errors: 0, toolCalls: 0 }
  /** How long the LangGraph took, separately from Gemini. Measured because the
   *  bridge inverts the latency profile: Gemini answers in ~1.2 s and Oscar takes
   *  ~5.6 s, so a tool turn is dominated by the agent, not by the voice layer. */
  readonly toolMs: number[] = []

  constructor(url: string, h: GeminiHandlers) {
    this.url = url
    this.h = h
  }

  async start(): Promise<void> {
    this.h.onState('connecting')
    await this.player.start()
    await this.openSocket()
    await this.openMic()
    this.running = true
    this.h.onState('listening')
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.onopen = () => {
        // NOTE: no setup frame is sent from here. The relay owns it, so the
        // browser cannot select a model and bill it to our key.
        this.h.onLog('socket open — relay is configuring the session')
        resolve()
      }
      ws.onerror = () => {
        this.stats.errors++
        reject(new Error('socket error'))
      }
      ws.onclose = ev => {
        // 1011 is the documented signature of the native-audio mid-turn failure,
        // so the code is surfaced rather than swallowed — "it stopped working" is
        // not a usable data point for the stability question.
        this.h.onLog(`socket closed code=${ev.code} reason=${ev.reason || '(none)'}`)
        if (this.running && ev.code !== 1000) {
          this.stats.errors++
          this.h.onError(`session dropped: code ${ev.code} ${ev.reason || ''}`)
        }
        this.h.onState('idle')
      }
      ws.onmessage = e => this.onServer(e.data)
    })
  }

  private onServer(data: unknown) {
    // The relay forwards Gemini's frames untouched, so this parses Google's
    // wire format directly — camelCase, per the v1beta reference.
    let msg: any
    try {
      msg = JSON.parse(typeof data === 'string' ? data : '')
    } catch { return }
    if (!msg) return

    if (msg.setupComplete) { this.h.onLog('setup complete — say something'); return }
    // Not part of Google's protocol — the relay injects this so the page can show
    // the bridge round trip. Without it a tool turn is just an unexplained pause,
    // and "was that Gemini being slow or Oscar?" is the whole question.
    if (msg.pocToolResult) {
      const r = msg.pocToolResult
      this.stats.toolCalls++
      this.toolMs.push(r.ms)
      this.toolAtMs = performance.now()
      this.turn.toolMs = r.ms
      // Ordering, decided by wall clock rather than by hope.
      this.turn.spokeBeforeTool = this.firstAudioAtMs != null
      // `r.raw` is the tool's whole return value. The old version read only
      // `response`/`error`, which direct-mode results do not carry — so every
      // successful call displayed "null" and looked like a failure.
      const shown = r.error ?? r.response ?? r.raw
      this.h.onLog(`🔧 ${r.ms} ms — ${JSON.stringify(r.request)} → `
        + JSON.stringify(shown).slice(0, 160))
      return
    }
    if (msg.goAway) {
      this.h.onLog(`goAway: server ending session (${JSON.stringify(msg.goAway)})`)
      return
    }
    if (msg.toolCall) {
      // Written when NO tools were declared, where any toolCall really was a
      // surprise. In direct mode tools ARE declared, so it fired on every healthy
      // turn and made a working session look broken. Now it reports the CALL,
      // and flags only the thing that is genuinely suspicious: more than one
      // function in a single frame, which is how duplicate tasks get created.
      const fc = msg.toolCall.functionCalls ?? []
      const names = fc.map((f: any) => f.name).join(', ')
      if (fc.length > 1) {
        this.h.onLog(`⚠️ ${fc.length} tool calls in ONE frame: ${names} — `
          + `duplicates are likely`)
      } else {
        this.h.onLog(`→ tool call: ${names}`)
      }
      return
    }
    if (msg.usageMetadata) {
      this.h.onLog(`usage: ${JSON.stringify(msg.usageMetadata)}`)
    }

    const sc = msg.serverContent
    if (!sc) return

    if (sc.interrupted) {
      // Native barge-in. Everything buffered is a reply the user talked over, so
      // it is dropped rather than played out — without this the speaker keeps
      // finishing a sentence the user has already moved past, which is exactly
      // the "it ignored me" complaint.
      this.player.clear()
      this.turn.interrupted = true
      this.stats.interruptions++
      this.h.onLog('⟂ interrupted — barge-in, buffer dropped')
      this.h.onState('listening')
      // The latency of an interrupted turn is not comparable, so it is not
      // recorded rather than recorded as an outlier.
      this.awaitingAudio = false
      this.speechEndAt = null
    }

    if (sc.inputTranscription?.text) {
      this.turn.heard += sc.inputTranscription.text
    }
    if (sc.outputTranscription?.text) {
      this.turn.said += sc.outputTranscription.text
    }

    const parts = sc.modelTurn?.parts ?? []
    for (const p of parts) {
      const d = p.inlineData?.data
      if (d) {
        this.stats.chunksIn++
        this.player.push(d)
      }
    }

    if (sc.turnComplete) {
      this.stats.turns++
      this.h.onTurn({ ...this.turn })
      if (this.turn.latencyMs != null) this.latencies.push(this.turn.latencyMs)
      this.turn = { heard: '', said: '', latencyMs: null, interrupted: false }
      this.toolAtMs = null
      this.firstAudioAtMs = null
      // Deliberately NOT setting state to 'listening' here: turnComplete means
      // generation finished, not that playback did. The buffer's drain event is
      // the honest end of speaking.
    }
  }

  private onAudioStart() {
    if (this.speaking) {
      this.overlaps++
      this.h.onLog(`🔴 OVERLAPPING SPEECH — a new burst began while the previous `
        + `one was still playing. This is the failure mode that disqualifies `
        + `non-blocking.`)
    }
    this.speaking = true
    if (this.firstAudioAtMs == null) this.firstAudioAtMs = performance.now()
    else if (this.toolAtMs != null) {
      this.turn.secondBurst = true
      this.h.onLog('↩ second burst after the tool result — Gemini correcting itself')
    }
    if (this.awaitingAudio && this.speechEndAt != null) {
      this.turn.latencyMs = Math.round(performance.now() - this.speechEndAt)
      this.h.onLog(`⏱ first audio ${this.turn.latencyMs} ms after you stopped speaking`)
      this.awaitingAudio = false
    }
    this.h.onState('speaking')
  }

  private onAudioDrain() {
    this.speaking = false
    // Drain is the honest end of the ANSWER, not turnComplete — generation can
    // finish while seconds of audio are still queued.
    if (this.speechEndAt != null) {
      this.turn.finalMs = Math.round(performance.now() - this.speechEndAt)
    }
    if (this.running) this.h.onState('listening')
  }

  private async openMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      // 🔴 echoCancellation is doing real work here, not box-ticking. The mic
      // stays HOT through the reply (that is what makes native barge-in possible
      // and is the opposite of liveVoice.ts's half-duplex gate), so without it
      // Gemini hears its own voice on laptop speakers and interrupts itself in a
      // loop. On a phone loudspeaker browser AEC is weaker — headphones are the
      // honest test, and the difference is called out in the report.
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    })
    const ctx = new AudioContext()
    this.ctx = ctx
    const src = ctx.createMediaStreamSource(this.stream)
    this.src = src
    // ScriptProcessor, deprecated but deliberate: the capture side is ported
    // verbatim from the shipping path so the POC is measuring GEMINI, not a new
    // capture implementation. Playback needed a worklet for real reasons; this
    // does not.
    const node = ctx.createScriptProcessor(4096, 1, 1)
    this.node = node
    const framesPer = TARGET_SR * (FRAME_MS / 1000)

    node.onaudioprocess = ev => {
      if (!this.running || this.ws?.readyState !== WebSocket.OPEN) return
      const input = ev.inputBuffer.getChannelData(0)

      let sum = 0
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
      const rms = Math.sqrt(sum / input.length)
      this.h.onLevel(rms)

      // Observer only — see OBSERVER_SILENCE_MS. Never gates the send.
      const now = performance.now()
      if (rms >= OBSERVER_RMS) {
        this.loudAt = now
        this.silenceStamped = false
      } else if (!this.silenceStamped && this.loudAt > 0
                 && now - this.loudAt >= OBSERVER_SILENCE_MS) {
        this.silenceStamped = true
        this.speechEndAt = this.loudAt + OBSERVER_SILENCE_MS
        this.awaitingAudio = true
        this.h.onState('thinking')
      }

      const pcm = toPcm16(input, ctx.sampleRate)
      for (let i = 0; i < pcm.length; i++) this.pending.push(pcm[i])

      // Fixed 100 ms frames regardless of the browser's buffer size. This loop
      // is the whole reason the accumulator exists.
      while (this.pending.length >= framesPer) {
        const frame = Int16Array.from(this.pending.splice(0, framesPer))
        this.ws.send(JSON.stringify({
          realtimeInput: {
            audio: { data: b64(frame), mimeType: `audio/pcm;rate=${TARGET_SR}` },
          },
        }))
        this.stats.framesSent++
      }
    }
    src.connect(node)
    // 🔴 A ScriptProcessorNode does not run unless it is connected to a
    // destination, even when its output is unused. Connecting to `destination`
    // would echo the microphone to the speaker, so it goes to a zero-gain node —
    // the standard workaround, and without it `onaudioprocess` simply never fires
    // and the POC looks like a dead socket.
    const mute = ctx.createGain()
    mute.gain.value = 0
    node.connect(mute)
    mute.connect(ctx.destination)
  }

  /** Manual interrupt, for comparison against Gemini's own barge-in. */
  interrupt() {
    this.player.clear()
    this.h.onState('listening')
  }

  summary() {
    const l = [...this.latencies].sort((a, b) => a - b)
    const pct = (p: number) => l.length ? l[Math.min(l.length - 1, Math.floor(l.length * p))] : null
    return {
      ...this.stats,
      outputRate: GEMINI_OUTPUT_RATE,
      latencyCount: l.length,
      latencyMin: l[0] ?? null,
      latencyMedian: pct(0.5),
      latencyP90: pct(0.9),
      latencyMax: l[l.length - 1] ?? null,
      latencies: l,
      overlaps: this.overlaps,
      toolMs: this.toolMs,
      toolMsMedian: this.toolMs.length
        ? [...this.toolMs].sort((a, b) => a - b)[this.toolMs.length >> 1] : null,
    }
  }

  async stop() {
    this.running = false
    try { this.node?.disconnect() } catch {}
    try { this.src?.disconnect() } catch {}
    this.stream?.getTracks().forEach(t => t.stop())
    await this.ctx?.close().catch(() => {})
    await this.player.stop()
    // 1000, so onclose can tell a clean stop from the 1011 the stability
    // question is actually about.
    this.ws?.close(1000, 'client stop')
    this.h.onState('idle')
  }
}
