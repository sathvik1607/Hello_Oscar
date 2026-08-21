/**
 * Live voice engine — hold a conversation, no buttons between turns.
 *
 *   mic ─100ms PCM16─▶ Sarvam STT (WS) ─final─▶ LLM (SSE) ─sentence─▶ Sarvam TTS (WS) ─▶ speaker
 *
 * PORTED VERBATIM from the admin panel's proven engine (Admin_repo, feat/sarvam-voice).
 * The pipeline, the framing, the timers, the barge-in heuristics and every comment
 * below are unchanged — they encode measurements and failures that would have to be
 * re-discovered from scratch otherwise. ONE thing was changed, and only one:
 *
 *   the relay is authorised by the signed-in USER'S BEARER TOKEN (?t=), not by the
 *   panel's shared admin secret (?k=).
 *
 * That had to change: a user-facing page cannot hold an operator secret. Everything
 * else was left alone deliberately, including the parts that look improvable — see
 * the noise gate and the 800 ms VAD window for two that were "improved" once and
 * broke the product both times.
 *
 * Three things here are load-bearing and were each found the hard way:
 *
 * 1. **100 ms frames, never 20 ms.** Streaming 20 ms frames — which is what a mic
 *    naturally produces — returns `"Rem, Rem, Rem"` for a clean English sentence.
 *    The socket accepts them and reports no error, so it looks like a bad model
 *    rather than a framing bug. 100 ms transcribes perfectly.
 *
 * 2. **Auth by SUBPROTOCOL, not header.** A browser cannot set headers on a
 *    WebSocket. Sarvam accepts `api-subscription-key.<key>` as a subprotocol and
 *    echoes it back, which is the only way this works client-side at all.
 *
 * 3. **Speak sentence one while the model is still writing.** Waiting for the full
 *    reply before starting TTS adds ~400 ms of dead air to every turn and is the
 *    difference between "it thinks, then talks" and "it starts talking".
 */

import { getToken, getUser, getBase, getWsBase } from './session'

/**
 * 🔴 VITE_SARVAM_KEY IS GONE, ON PURPOSE — do not put it back.
 *
 * It used to be read here and sent as a WebSocket subprotocol. Vite inlines every
 * VITE_* value into the shipped bundle, so on any deployed page that key was
 * readable by whoever opened it. The key now lives on the backend and the speech
 * sockets are relayed through it.
 *
 * What the browser sends instead is the signed-in user's own BEARER TOKEN, as `?t=`
 * — a WebSocket cannot set headers, so a query param is the only channel. It gates
 * OUR relay; it is not a Sarvam credential and cannot be used to call Sarvam
 * directly. The panel's `?k=` admin-secret door still exists server-side, and this
 * app deliberately does not use it: a page any user can open must not carry an
 * operator secret, and a per-user token is also what lets the relay refuse a token
 * for one user that arrives claiming to be another.
 */

/** The REAL backend. `/chat/stream` is used, not `/chat`: it streams the agent's
 *  tokens over the WebSocket the client already holds, so the first sentence can be
 *  spoken while the model is still writing the rest. `/chat` returns one complete
 *  body, which forces a full wait before any sound — the thing this spike exists to
 *  avoid. Same agent either way; only the delivery differs. */
/** Resolved per call rather than captured at module load, so pointing the app at
 *  another backend from Settings takes effect on the next call instead of needing a
 *  reload. */
const base = () => getBase()
/**
 * bulbul:v3 voices, VERIFIED against the live API on 2026-08-19 — every name here
 * returned audio, and the seven that did not (karun, hitesh, abhilash, anushka,
 * manisha, vidya, arya) have been removed.
 *
 * They were v2 speaker names. Selecting one did not fail loudly: the config frame was
 * rejected and the turn simply produced SILENCE, which is indistinguishable from a
 * broken microphone, a dead socket or a hung backend. A picker must never offer a
 * choice that quietly does nothing.
 *
 * `dev` is the default and is a MALE voice — the first four here are male, the last
 * four female. Re-verify this list when the model version changes; the names are not
 * stable across bulbul versions, which is exactly how the dead ones got in.
 */
export { SPEAKERS } from './speakers'
import { DEFAULT_SPEAKER } from './speakers'

/**
 * Speech sockets now go through OUR backend, not to Sarvam directly.
 *
 * The direct connection worked and was fine on localhost, but Vite inlines every
 * VITE_* value into the shipped bundle — so a deployed page handed the Sarvam key to
 * anyone who opened it. The relay holds the key server-side and passes frames through
 * untouched, so the protocol below is unchanged; only the URL moved.
 *
 * Derived from VITE_BACKEND_URL so it follows the backend across localhost / dev /
 * prod with no extra config, and http→ws / https→wss so a deployed page (which MUST
 * be https for getUserMedia) does not try to open an insecure socket and get blocked
 * by the browser as mixed content.
 */
const sttWs = () => `${getWsBase()}/voice/sarvam/stt`
const ttsWs = () => `${getWsBase()}/voice/sarvam/tts`

const FRAME_MS = 100
const TARGET_SR = 16000
/** How much silence ends your turn.
 *
 *  🔴 NOT tuned for latency, and 400 was a mistake. 400 ms is the floor a CLIP can
 *  survive, but a person pausing to think mid-sentence is silent for longer than
 *  that — so "assign task to Sriram … regarding … the TTS event" arrived as three
 *  separate questions and Oscar answered each with "could you clarify?". The
 *  transcript in the logs is a conversation cut into confetti.
 *
 *  800 ms costs 400 ms of latency and buys back whole sentences. Coherence beats
 *  speed: a fast answer to half a sentence is not an answer. */
const SILENCE_MS = Number(import.meta.env.VITE_VAD_SILENCE_MS ?? 800)
/** The first point in a growing reply worth speaking.
 *
 *  The obvious /[.!?]\s/ is WRONG and cost the whole benefit of streaming: it needs
 *  whitespace AFTER the punctuation, so a one-sentence reply — "Understood!", "Got
 *  it! What next?" — never matched and nothing was spoken until the model finished.
 *  Most replies are one sentence, so streaming was effectively off.
 *
 *  Now: end of a sentence anywhere (trailing punctuation counts), or a clause break
 *  once there is enough to be worth saying. MIN_SPEAK_CHARS stops us shipping "I"
 *  or "Done," as a standalone utterance, which sounds worse than waiting. */
const MIN_SPEAK_CHARS = 24
/**
 * → the message with the name stripped, or null when it was never addressed to us.
 *
 * The name must appear in the FIRST FEW WORDS. "Oscar, remind me at four" is addressed
 * to it; "…so I told Oscar about the meeting" is a sentence about it, and answering
 * that would be the same class of error as the router matching "hello oscar" inside a
 * task request. Position is the cheapest available proxy for intent.
 */
function wakeStrip(text: string): string | null {
  const norm = text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const words = norm.split(' ')
  const at = words.findIndex(w => WAKE_VARIANTS.includes(w))
  if (at === -1) return null
  // 🔴 Position alone is not enough. "send hello oscar poster to sriram" has the name
  // at index 2, and an index test passed it — stripping the first three words and
  // leaving "poster to sriram", a request that no longer says WHICH poster. The name
  // of the assistant is also part of a template name, a company name and a greeting.
  //
  // So anything before the name must be pure address-filler. "hey oscar" is someone
  // calling it; "send hello oscar" is someone naming a thing.
  if (!words.slice(0, at).every(w => WAKE_FILLER.includes(w))) return null
  // Strip the name and any leading filler it left behind ("Oscar, please …").
  const rest = words.slice(at + 1).join(' ').replace(/^(please|can you|could you)\s+/, '')
  // Bare "Oscar" with nothing after it is a summons, not an instruction — let it
  // through as a greeting so it answers rather than silently doing nothing.
  return rest.trim() || 'hello'
}

function firstChunkEnd(s: string): number {
  const sentence = /[.!?](\s|$)/.exec(s)
  if (sentence && sentence.index + 1 >= MIN_SPEAK_CHARS) return sentence.index + 1
  if (s.length >= MIN_SPEAK_CHARS) {
    const clause = /[,;:—]\s/.exec(s.slice(MIN_SPEAK_CHARS))
    if (clause) return MIN_SPEAK_CHARS + clause.index + 1
  }
  return -1
}

/** How long the TTS socket must be quiet before we treat the reply as fully
 *  synthesised. Chunks arrive ~32 ms apart, so 250 ms is comfortably past the gap
 *  without adding noticeable delay before playback starts. */
/** How long after the voice starts before an interruption is believed. Echo is
 *  loudest at the start, and nobody interrupts before they have heard anything. */
const BARGE_GRACE_MS = 600
/** A second speech_start must follow within this window to count as a real
 *  interruption. Echo produces one blip; a person talking keeps producing them. */
const BARGE_WINDOW_MS = 1200

/** Backstop after the final text is sent: how long to wait for the tail audio to
 *  begin before giving up on it. Generous on purpose — it should never be what ends a
 *  healthy reply; the 250ms idle timer does that once audio is flowing. */
const TTS_TAIL_MS = 6000

/**
 * WAKE WORD. With the microphone permanently open, everything said in the room reaches
 * the agent — a colleague's sentence, the TV, half of a phone call — and any of it can
 * create a real task on a real calendar. A name is the difference between an assistant
 * that is listening and one that is merely on.
 *
 * Matched against the STT transcript, so the variants matter more than the spelling:
 * "Oscar" comes back as "oskar", "ascar", "osker" often enough that requiring the exact
 * word would make the assistant look deaf. Kept deliberately tight all the same — every
 * entry here is a phrase that can wake it, so a loose one ("ask") would undo the point.
 */
const WAKE_WORD = ((import.meta.env.VITE_WAKE_WORD as string) ?? 'oscar').toLowerCase()
const WAKE_VARIANTS = [WAKE_WORD, 'oskar', 'osker', 'ascar', 'askar', 'auscar', 'ossca']
/** Words allowed BEFORE the name while still counting as addressing it. Anything else
 *  in front means the name is being used as a noun, not as a summons. */
const WAKE_FILLER = ['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'um', 'uh', 'so', 'excuse', 'me']

/**
 * How long after a reply you may keep talking WITHOUT the name.
 *
 * Without this the assistant is unusable in conversation: it asks "which poster?" and
 * you would have to answer "Oscar, the hello oscar one". Worse, a staged confirmation
 * expects a bare "yes" — requiring the name there would strand every destructive action
 * behind a phrasing nobody would guess. The window opens only after IT has spoken, so
 * ambient speech in a quiet room still cannot reach the agent.
 */
const FOLLOWUP_MS = 20000

/**
 * NOISE GATE — stop paying to transcribe an empty room.
 *
 * The socket streams continuously, so Sarvam bills every second the tab is open
 * (₹30/hour) and transcribes every conversation within earshot. Observed in a real
 * session: two people talking near the laptop produced fifteen transcripts in ninety
 * seconds, none of them addressed to the assistant. The wake word stops it ACTING on
 * them; it does not stop us paying for them.
 *
 * A gate on loudness is the cheap fix. It cannot tell speech from noise — only near
 * from far — but that is the distinction that matters here: the person talking TO the
 * assistant is next to the microphone, and the room is not.
 */
/**
 * 🔴 OFF BY DEFAULT, and that default is the point.
 *
 * Shipped ON with a guessed threshold of 0.02 RMS and it broke the product: on a mic
 * quieter than mine the gate never opened, no audio ever reached Sarvam, and the orb
 * sat in "listening" forever with nothing happening. A cost optimisation that can
 * silence the assistant is not worth having on by default — the failure looks like a
 * dead microphone and gives the user nothing to act on.
 *
 * Enable with VITE_MIC_GATE=1 once the threshold below is tuned to your room. Watch
 * the orb while speaking normally: it is driven by the same RMS, and the threshold
 * wants to sit just under the level you see when talking, comfortably above idle.
 */
const GATE_ENABLED = (import.meta.env.VITE_MIC_GATE as string) === '1'
/** Tunable, because "loud enough to be talking to the mic" is a property of the room
 *  and the hardware, not something a default can know. */
const GATE_RMS = Number(import.meta.env.VITE_MIC_GATE_RMS ?? 0.02)
/** Keep streaming for this long after the level drops, so trailing words survive the
 *  gate closing between syllables. */
const GATE_HANGOVER_MS = 900
/** Frames held back while quiet and flushed when the gate opens. Without them the
 *  first word is always clipped — the gate can only open AFTER sound has arrived, so
 *  by then its opening syllable is already in the past. */
const GATE_PREROLL_FRAMES = 3

const IDLE_MS = 250

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking'

export type Timings = {
  sttMs?: number       // speech end → final transcript
  llmMs?: number       // speech end → first token
  audioMs?: number     // speech end → first spoken word
  /** Which turn these belong to. Without it, a slow turn's audio arriving after the
   *  next utterance began was measured against the NEW anchor and logged a 0.11s
   *  total with a NEGATIVE tts figure — a number that reads as a speed record and is
   *  actually two turns spliced together. */
  turn?: number
  /** True once a tool ran. A tool turn is TWO model passes with the tool in between,
   *  so its first-word time is not comparable to a plain reply and must not be
   *  averaged with one. */
  tool?: boolean
}

export type Handlers = {
  onPhase: (p: Phase) => void
  onLevel: (rms: number) => void          // drives the orb
  onPartial: (text: string) => void
  onFinal: (text: string) => void
  onReplyToken: (full: string) => void
  onTimings: (t: Timings) => void
  onError: (msg: string) => void
}

/** Downsample browser audio (usually 48 kHz float) to 16 kHz PCM16.
 *  Averaged rather than decimated — plain decimation aliases and measurably hurts
 *  transcription on sibilants. */
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

function b64(bytes: Int16Array): string {
  const u8 = new Uint8Array(bytes.buffer)
  let s = ''
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
  return btoa(s)
}

export class LiveVoice {
  private h: Handlers
  private userId: number
  private speaker: string
  private stt?: WebSocket
  private tts?: WebSocket
  private appWs?: WebSocket
  private ctx?: AudioContext
  private stream?: MediaStream
  private node?: ScriptProcessorNode
  private pending: number[] = []
  private running = false

  /** This call's own conversation. Without it every turn lands in the AMBIENT
   *  history bucket (session_id = null), which `_history_messages` shows to EVERY
   *  conversation — so a photo sent from the phone a minute earlier leaked into a
   *  spoken "Hey hi" and Oscar answered "Got the image — what would you like me to
   *  do with it?". Opening a session scopes this call to itself. */
  private sessionId?: number

  /** A turn is in flight. Sending another while one is running is what broke the
   *  conversation: history is only written when a turn COMPLETES (agent.py pushes
   *  at the end), so a second turn starting 0.6 s later reads an empty history and
   *  has no idea what was just asked. That is why "assign a task to Sriram" →
   *  "what time?" → "11 AM today" → "clarify what you'd like to schedule at 11 AM".
   *  Overlapping turns also race on the server's per-user turn context. */
  private busy = false
  /** Speech that arrived while busy — merged into ONE message rather than dropped,
   *  because the fragments are usually halves of the same sentence. */
  private queued: string[] = []

  private speechEndAt = 0
  // The anchor is FROZEN when a turn starts. speechEndAt keeps moving as the person
  // talks; measuring against it mid-turn is what produced negative durations.
  private turnAnchor = 0
  private turnId = 0
  private spokenFiller = false
  private speaking = false
  /** True once the LAST text of this turn has been sent to TTS. Until then, silence on
   *  the socket means "the model is still writing", NOT "the reply is over". */
  private textDone = false
  /** When playback of this reply began — the anchor for BARGE_GRACE_MS. */
  /** When the last reply finished — opens the follow-up window. */
  private lastReplyAt = 0
  /** Whether that reply asked for something back. Only an invited answer may skip
   *  the wake word; a fresh instruction always needs the name. */
  private lastReplyInvited = false
  /** Last moment the mic was loud enough to be someone talking to us. */
  private loudAt = 0
  /** Recent frames held back while the gate is shut — the pre-roll. */
  private preroll: Int16Array[] = []
  private spokeAt = 0
  /** When the first unconfirmed speech_start arrived, 0 if none is pending. */
  private bargeSeen = 0
  private t: Timings = {}
  private reply = ''
  private spokenFirst = false

  // Playback via MediaSource — chunks are appended and PLAY IMMEDIATELY.
  //
  // The first version concatenated every chunk into one blob and played it after
  // the socket went quiet. That is correct and feels broken: it converts a stream
  // into a batch, so nothing is heard until the ENTIRE sentence has synthesised —
  // roughly a second of silence while the text was already on screen. "Text fast,
  // voice slow" is exactly what that looks like.
  //
  // MSE appends each MP3 chunk to a live buffer, so audio starts on chunk ONE
  // (~200 ms) and the rest arrives while it is already speaking. Falls back to the
  // blob path where MSE cannot take audio/mpeg (Safari), because slow audio still
  // beats no audio.
  private media?: MediaSource
  private sb?: SourceBuffer
  private appendQ: Uint8Array[] = []
  private mseReady = false
  private audioChunks: Uint8Array[] = []   // fallback path only
  private idleTimer: number | undefined
  private audioEl = new Audio()
  private audioWired = false
  private useMse = typeof MediaSource !== 'undefined'
    && MediaSource.isTypeSupported('audio/mpeg')

  /** userId defaults to whoever is signed in. There is deliberately no way to pass
   *  someone ELSE's id from a UI control: in the panel that field existed and a
   *  mistyped value wrote spoken turns into a real colleague's chat history and
   *  pushed them to their phone. The relay also rejects a token/user mismatch, so
   *  even a hand-edited value cannot land on another account. */
  constructor(h: Handlers, userId: number = getUser()?.id ?? 0,
              speaker: string = DEFAULT_SPEAKER) {
    this.h = h
    this.userId = userId
    this.speaker = speaker
  }

  get isRunning() { return this.running }

  async start() {
    if (!getToken() || !this.userId) {
      this.h.onError('Sign in first — the speech relay needs your session.')
      return
    }
    if (this.running) return
    this.running = true
    try {
      await this.openTts()
      await this.openApp()
      await this.openSession()
      await this.openStt()
      await this.openMic()
      this.h.onPhase('listening')
    } catch (e) {
      this.running = false
      this.h.onError((e as Error).message)
      this.stop()
    }
  }

  stop() {
    this.running = false
    this.busy = false
    this.queued = []
    try { this.node?.disconnect() } catch { /* already gone */ }
    try { this.stream?.getTracks().forEach(t => t.stop()) } catch { /* ditto */ }
    try { this.ctx?.close() } catch { /* ditto */ }
    try { this.stt?.close() } catch { /* ditto */ }
    try { this.appWs?.close() } catch { /* ditto */ }
    try { this.tts?.close() } catch { /* ditto */ }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.audioEl.pause()
    this.resetAudio()
    this.h.onLevel(0)
    this.h.onPhase('idle')
  }

  /** Stop the current utterance immediately: silence the element, drop what has
   *  been buffered, and clear the idle timer that would otherwise fire a stale
   *  end-of-reply. The TTS socket is left OPEN — reconnecting costs ~242ms and the
   *  next turn needs it warm; it simply has nothing more to send.
   *
   *  The turn's TEXT is untouched: the reply is already written to the user's chat
   *  history server-side, and any tool it called has already run. Barge-in cuts the
   *  audio, it does not undo the turn — that would need a cancel path the backend
   *  does not have. */
  /**
   * Interrupt the current reply. PUBLIC — this is the barge-in that voice cannot do.
   *
   * The microphone is muted while Oscar speaks (he was transcribing himself and cutting
   * his own turn short), so a spoken interruption cannot reach us by design. A tap has
   * no such problem: it is unambiguous, it works on a loudspeaker in a noisy room, and
   * it needs no echo heuristics at all. Un-mutes as a side effect via stopSpeaking(),
   * so the next thing you say is heard immediately.
   */
  interrupt() {
    if (!this.speaking) return
    this.stopSpeaking()
    this.h.onPhase('listening')
  }

  /** Whether a reply is currently being spoken — drives the Stop control. */
  get isSpeaking() { return this.speaking }

  private stopSpeaking() {
    this.speaking = false          // also the un-mute path for a cancelled reply
    try { this.audioEl.pause() } catch { /* nothing playing */ }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = undefined }
    this.resetAudio()
  }

  // ── Sockets ───────────────────────────────────────────────────────────────

  /** The relay credential, as a query fragment. Appended to both speech sockets.
   *  `user_id` rides along so the relay can refuse a token that arrives claiming a
   *  different user — the token alone would authorise, but not identify against the
   *  id this call will post chat turns as. */
  private relayKey(): string {
    return `t=${encodeURIComponent(getToken() ?? '')}&user_id=${this.userId}`
  }

  /** The app's own socket. /chat/stream refuses to generate at all unless this user
   *  has one open — the backend short-circuits rather than bill a reply nobody can
   *  see — so it must be connected BEFORE the first question is asked. */
  private openApp(): Promise<void> {
    const url = `${getWsBase()}/ws?user_id=${this.userId}`
      + `&t=${encodeURIComponent(getToken() ?? '')}`
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      this.appWs = ws
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error(`app socket failed: ${url}`))
      ws.onmessage = e => {
        // The server pings every 30 s and closes with 4002 if we never pong.
        try {
          const f = JSON.parse(e.data)
          if (f.type === 'connection.ping') {
            ws.send(JSON.stringify({ type: 'connection.pong' }))
            return
          }
        } catch { /* non-JSON frames are ignored by contract */ }
        this.onAppFrame(e)
      }
    })
  }

  /** Best-effort: if the backend predates sessions, carry on without one rather
   *  than refuse to start a call. */
  private async openSession() {
    try {
      // 🔴 user_id is a QUERY param on this route. Posting it in the body only
      // returns 422 — and because this call is best-effort (see below), that
      // failure was SILENT: every voice call fell back to the ambient history
      // bucket, which is shown to every conversation. Exactly the leak opening a
      // session is supposed to prevent.
      const qs = new URLSearchParams({
        user_id: String(this.userId), title: 'Voice conversation',
      })
      const r = await fetch(`${base()}/chat/sessions?${qs}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken() ?? ''}` },
      })
      if (r.ok) this.sessionId = (await r.json()).session_id
    } catch { /* no session — turns fall back to ambient, as before */ }
  }

  private openStt(): Promise<void> {
    // UNDERSCORES, not hyphens. The hyphenated form connects and is then closed
    // with 4000 "Missing required query parameter 'language_code'" — a failure that
    // looks like an auth problem and is not.
    const qs = new URLSearchParams({
      language_code: 'en-IN',
      model: 'saaras:v3-realtime',
      stream_type: 'fast',
      encoding: 'linear16',
      sample_rate: String(TARGET_SR),
      endpointing: 'vad',
      silence_duration_ms: String(SILENCE_MS),
    })
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${sttWs()}?${qs}&${this.relayKey()}`)
      this.stt = ws
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('STT socket failed to open'))
      ws.onclose = () => { if (this.running) this.h.onError('STT socket closed') }
      ws.onmessage = e => this.onSttMessage(e)
    })
  }

  private openTts(): Promise<void> {
    const qs = new URLSearchParams({ model: 'bulbul:v3' })
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${ttsWs()}?${qs}&${this.relayKey()}`)
      this.tts = ws
      ws.onopen = () => {
        // Pre-warmed and configured once for the whole conversation — a per-turn
        // connect would bill ~240 ms to every sentence.
        ws.send(JSON.stringify({
          type: 'config',
          data: {
            target_language_code: 'en-IN', speaker: this.speaker,
            output_audio_codec: 'mp3', speech_sample_rate: 22050,
            min_buffer_size: 50, max_chunk_length: 150,
          },
        }))
        resolve()
      }
      ws.onerror = () => reject(new Error('TTS socket failed to open'))
      ws.onmessage = e => this.onTtsMessage(e)
    })
  }

  private onSttMessage(e: MessageEvent) {
    let m: any
    try { m = JSON.parse(e.data) } catch { return }
    switch (m.event ?? m.type) {
      case 'transcript.partial':
        if (m.text) this.h.onPartial(m.text)
        break
      /**
       * BARGE-IN. Talking over the assistant stops it mid-word, the way a person
       * would stop when interrupted. Without this the only way to cut a long reply
       * short is to sit through it.
       *
       * Safe here ONLY because the mic is captured with echoCancellation — the
       * browser subtracts what the speaker is playing, so the assistant's own voice
       * does not read as the user talking. Turn that constraint off and this becomes
       * an infinite self-interruption loop: it hears itself, stops, which is silence,
       * which lets it speak again.
       *
       * Speaking-phase only. During 'listening' there is nothing to interrupt, and
       * during 'thinking' the audio has not started, so stopping would be a no-op
       * that also threw away a turn already paid for.
       */
      case 'vad.speech_start':
        /**
         * 🔴 A VAD blip is NOT enough to interrupt, and treating it as enough made
         * Oscar cut itself off on a phone.
         *
         * On a laptop the mic is captured with echoCancellation, so the browser
         * subtracts what the speaker is playing and Oscar never hears himself. Through
         * a phone's LOUDSPEAKER that cancellation is far weaker — the mic picks up the
         * reply, Sarvam's VAD calls it speech, and the audio stopped mid-sentence. The
         * user experiences a reply that trails off for no reason.
         *
         * Two conditions now, and both are needed:
         *
         *   • a grace window after playback starts. Echo is loudest exactly when the
         *     voice begins, and nobody interrupts in the first half second — they have
         *     not heard enough yet to want to.
         *   • speech that is still going a moment later. Echo triggers a blip; a person
         *     talking keeps triggering. Sarvam re-sends speech_start per utterance, so
         *     a single stray frame no longer counts.
         *
         * A real interruption is late and sustained; an echo is early and momentary.
         */
        if (this.speaking && performance.now() - this.spokeAt > BARGE_GRACE_MS) {
          if (this.bargeSeen && performance.now() - this.bargeSeen < BARGE_WINDOW_MS) {
            this.bargeSeen = 0
            this.stopSpeaking()
            this.h.onPhase('listening')
          } else {
            this.bargeSeen = performance.now()
          }
        }
        break

      case 'vad.speech_end':
        // The user has stopped talking — every latency number is anchored here.
        this.speechEndAt = performance.now()
        this.h.onPhase('thinking')
        break
      case 'transcript.final': {
        const text = (m.text ?? m.transcript ?? '').trim()
        if (!text) { if (!this.busy) this.h.onPhase('listening'); return }

        /**
         * Addressed to us, or just noise in the room?
         *
         * Checked BEFORE the busy branch, and that ordering is the fix for a hole:
         * anything said while Oscar was mid-turn used to be pushed onto `queued` and
         * fired verbatim by turnDone() — never passing through this check at all. So
         * the one moment the microphone is most likely to hear the room (while the
         * assistant is talking) was the one moment the wake word did not apply.
         *
         * The follow-up exemption is DELIBERATELY NARROW. It first was "any reply
         * within 20s", which in practice meant the wake word did nothing — during
         * normal use you always speak within 20s of the last answer, so every
         * utterance sailed through and the feature looked broken. It now opens only
         * when the previous reply actually INVITED one: a question, or a staged
         * confirmation. Answering "which poster?" or "reply confirm to send" must not
         * require the name; volunteering a new instruction must.
         */
        const invited = performance.now() - this.lastReplyAt < FOLLOWUP_MS
                        && this.lastReplyInvited
        const addressed = invited ? text : wakeStrip(text)
        if (addressed === null) {
          // Heard clearly, deliberately not answered. Surfaced rather than swallowed:
          // silence here is indistinguishable from a broken microphone, and the user
          // needs to see that it IS listening and chose not to act.
          this.h.onPartial(`(not addressed to ${WAKE_WORD}) ${text}`)
          if (!this.busy) this.h.onPhase('listening')
          return
        }

        if (this.busy) {
          // Addressed, but we are still answering — hold it and send it with the next
          // message rather than racing. Already wake-checked above.
          this.queued.push(addressed)
          this.h.onFinal([...this.queued].join(' '))
          return
        }

        this.turnId += 1
        this.turnAnchor = this.speechEndAt
        this.t = { turn: this.turnId,
                   sttMs: Math.round(performance.now() - this.turnAnchor) }
        this.h.onTimings(this.t)
        this.h.onFinal(addressed)
        void this.ask(addressed)
        break
      }
      case 'error':
        this.h.onError(JSON.stringify(m).slice(0, 200))
        break
    }
  }

  private onTtsMessage(e: MessageEvent) {
    let m: any
    try { m = JSON.parse(e.data) } catch { return }
    const b = m?.data?.audio
    if (b) {
      if (this.t.audioMs === undefined) {
        this.t.audioMs = Math.round(performance.now() - this.turnAnchor)
        this.h.onTimings({ ...this.t })
        this.speaking = true
        this.spokeAt = performance.now()
        this.bargeSeen = 0
        this.h.onPhase('speaking')
      }
      const bin = atob(b)
      const u8 = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
      if (this.useMse) {
        this.pushMse(u8)
        /**
         * Sarvam sends no completion event, so end-of-reply is detected by idle.
         *
         * 🔴 But idle alone is WRONG while the turn is still running, and it silently
         * truncated every long reply. A long answer is spoken in two pieces — sentence
         * one while the model is still writing, the rest at chat.complete — and seconds
         * pass between them. The 250ms timer fired in that gap, called endOfStream(),
         * and the second piece then had no buffer to append to. Measured symptom: a
         * 302-character reply where only the first sentence was audible. Short replies
         * arrive in one burst, which is why this hid for so long.
         *
         * So the stream is only closed once the last text has been handed to TTS.
         */
        if (this.idleTimer) clearTimeout(this.idleTimer)
        if (this.textDone) {
          this.idleTimer = setTimeout(() => this.endMse(), IDLE_MS) as unknown as number
        }
      } else {
        this.audioChunks.push(u8)
        if (this.idleTimer) clearTimeout(this.idleTimer)
        // Same rule as the MSE path above — an iPhone takes this branch (no
        // MediaSource on iOS Safari), so the truncation bug lived here too.
        if (this.textDone) {
          this.idleTimer = setTimeout(() => this.flushAudio(), IDLE_MS) as unknown as number
        }
      }
    }
  }

  /** Open a fresh MediaSource for this reply and start playing the moment the
   *  first bytes land. */
  private startMse() {
    if (!this.audioWired) {
      // One listener for the life of the engine — re-adding per reply would stack
      // handlers and fire the phase change N times.
      this.audioEl.addEventListener('ended', () => {
        // Playback is genuinely over: re-open the microphone. Without this the
        // half-duplex gate above would mute the user permanently after the first
        // reply — a far worse failure than the echo it exists to prevent.
        this.speaking = false
        this.resetAudio()
        if (this.running) this.h.onPhase('listening')
      })
      this.audioWired = true
    }
    const ms = new MediaSource()
    this.media = ms
    this.mseReady = false
    this.appendQ = []
    this.audioEl.src = URL.createObjectURL(ms)
    ms.addEventListener('sourceopen', () => {
      try {
        const sb = ms.addSourceBuffer('audio/mpeg')
        this.sb = sb
        sb.addEventListener('updateend', () => this.drainQ())
        this.mseReady = true
        this.drainQ()
      } catch {
        // Codec refused after all — fall back rather than go silent.
        this.useMse = false
      }
    })
    void this.audioEl.play().catch(e => {
      this.h.onError(`Audio blocked by the browser (${(e as Error).name}) — click the page once.`)
    })
  }

  /** Tear down the current reply's buffer so the next turn starts clean. */
  private resetAudio() {
    try {
      if (this.media && this.media.readyState === 'open') this.media.endOfStream()
    } catch { /* fine */ }
    this.media = undefined
    this.sb = undefined
    this.appendQ = []
    this.audioChunks = []
    this.mseReady = false
  }

  private pushMse(u8: Uint8Array) {
    if (!this.media) this.startMse()
    this.appendQ.push(u8)
    this.drainQ()
  }

  /** A SourceBuffer accepts one append at a time; queue the rest. */
  private drainQ() {
    if (!this.mseReady || !this.sb || this.sb.updating) return
    const next = this.appendQ.shift()
    if (!next) return
    try {
      this.sb.appendBuffer(next as unknown as BufferSource)
    } catch {
      this.appendQ.unshift(next)
    }
  }

  /** The reply is fully synthesised — close the stream so `ended` fires and the
   *  call returns to listening. */
  private endMse() {
    if (!this.media || this.media.readyState !== 'open') return
    const finish = () => {
      try { this.media?.endOfStream() } catch { /* already ended */ }
    }
    if (this.sb?.updating || this.appendQ.length) setTimeout(() => this.endMse(), 60)
    else finish()
  }

  /** Fallback only: no MSE, so play what accumulated once the socket goes quiet. */
  private flushAudio() {
    if (!this.audioChunks.length) return
    const blob = new Blob(this.audioChunks as BlobPart[], { type: 'audio/mpeg' })
    this.audioChunks = []
    const url = URL.createObjectURL(blob)
    this.audioEl.src = url
    this.audioEl.onended = () => {
      URL.revokeObjectURL(url)
      this.speaking = false          // same un-mute as the MSE path — see 'ended' above
      if (this.running) this.h.onPhase('listening')
    }
    void this.audioEl.play().catch(e => {
      this.h.onError(`Audio blocked by the browser (${(e as Error).name}) — click the page once.`)
    })
  }

  // ── LLM ───────────────────────────────────────────────────────────────────

  private async ask(text: string) {
    // Anything buffered while the last turn ran belongs with this one.
    if (this.queued.length) {
      text = [...this.queued, text].join(' ')
      this.queued = []
    }
    this.busy = true
    this.speaking = false
    this.textDone = false
    this.reply = ''
    this.spokenFirst = false; this.spokenFiller = false
    this.t.llmMs = undefined
    this.t.audioMs = undefined
    try {
      // POST only STARTS the run; the answer arrives on the app socket. A
      // `streaming:false` reply means the backend saw no live socket for this user
      // and generated nothing — worth surfacing rather than waiting forever.
      const res = await fetch(`${base()}/chat/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // The turn's subject is in the BODY, so the server checks it against this
          // token (require_owner). Omit the header and the turn 401s under
          // WEB_AUTH_ENFORCE — which is exactly the point of sending it.
          Authorization: `Bearer ${getToken() ?? ''}`,
        },
        body: JSON.stringify({
          user_id: this.userId, message: text, voice: true,
          ...(this.sessionId ? { session_id: this.sessionId } : {}),
        }),
      })
      if (!res.ok) throw new Error(`/chat/stream -> HTTP ${res.status}`)
      const d = await res.json()
      if (d.streaming === false) {
        throw new Error(`backend declined to stream (${d.reason ?? 'no socket'})`)
      }
    } catch (e) {
      this.busy = false
      this.h.onError((e as Error).message)
      this.h.onPhase('listening')
    }
  }

  /** Frames from the app's own WebSocket — the same ones the Flutter client gets.
   *
   *  chat.delta is prose only: a structured (JSON) answer and every fast-path reply
   *  emit NO deltas, just chat.complete. So this must never assume deltas arrive, or
   *  greetings and "what's due today" would be silent — the two most common things
   *  anyone says to it.
   */
  private onAppFrame(ev: MessageEvent) {
    let f: any
    try { f = JSON.parse(ev.data) } catch { return }
    const p = f.payload ?? {}
    switch (f.type) {
      case 'chat.delta': {
        if (!p.text) return
        if (this.t.llmMs === undefined) {
          this.t.llmMs = Math.round(performance.now() - this.turnAnchor)
          this.h.onTimings({ ...this.t })
        }
        this.reply += p.text
        this.h.onReplyToken(this.reply)
        // Sentence one to the speaker while the model keeps writing.
        if (!this.spokenFirst) {
          const cut = firstChunkEnd(this.reply)
          if (cut > 0) { this.speak(this.reply.slice(0, cut)); this.spokenFirst = true }
        }
        break
      }
      /**
       * A TOOL turn is two model passes with the tool executed in between, so the
       * user hears NOTHING from the first token until the second pass produces a
       * sentence — measured at 3.3s on a create_task turn, which is most of a 5.2s
       * total and reads as a hang.
       *
       * The backend already names what it is doing ("checking your tasks"), so say
       * that. It does not make the turn faster; it makes the wait audible, which is
       * the part the person actually experiences. Spoken only when nothing has been
       * said yet — never on top of a real answer.
       */
      case 'chat.tool': {
        this.t.tool = true
        this.h.onTimings({ ...this.t })
        if (!this.spokenFirst && !this.spokenFiller) {
          const label = (p.label ?? '').toString().trim()
          if (label) {
            this.spokenFiller = true
            // Deliberately NOT setting spokenFirst: the real first sentence must
            // still be spoken when it arrives. This is filler, not the answer.
            this.speak(label.endsWith('.') ? label : label + '.')
          }
        }
        break
      }

      case 'chat.complete': {
        // chat.complete.text is AUTHORITATIVE and replaces the buffer — that is the
        // documented contract, and it is how a fast-path reply (zero deltas) arrives.
        const full = (p.text ?? '').toString()
        if (this.t.llmMs === undefined) {
          this.t.llmMs = Math.round(performance.now() - this.turnAnchor)
          this.h.onTimings({ ...this.t })
        }
        this.reply = full
        this.h.onReplyToken(full)
        if (!this.spokenFirst) {
          if (full.trim()) this.speak(full)
        } else {
          const cut = firstChunkEnd(full)
          const rest = cut > 0 ? full.slice(cut).trim() : ''
          if (rest) this.speak(rest)
        }
        this.tts?.send(JSON.stringify({ type: 'flush' }))
        /**
         * Everything for this turn is now with TTS, so socket silence finally MEANS
         * finished — but only once audio has actually started flowing again.
         *
         * 🔴 Arming the 250ms idle timer HERE was wrong and truncated the reply to its
         * first chunk: at this instant the closing sentences have been SENT to Sarvam
         * and none of their audio has come back yet. Synthesis takes longer than 250ms,
         * so the timer fired into that gap and closed the stream before the tail
         * arrived.
         *
         * The timer armed here is therefore a long BACKSTOP, not the idle detector. It
         * exists only for the case where no further audio ever arrives (a TTS error, a
         * dropped socket), so the stream cannot stay open forever. Once a chunk does
         * arrive, the handler above re-arms the real 250ms idle timer and that is what
         * ends the reply.
         */
        this.textDone = true
        // Did THIS reply invite an answer? Only then may the next sentence skip the
        // name. A question mark covers "which poster?"; the phrases cover a staged
        // confirmation, which asks for a bare "yes" and never ends in a question mark.
        this.lastReplyAt = performance.now()
        this.lastReplyInvited = /\?\s*$/.test(full.trim())
          || /\b(confirm|shall i|should i|would you like|yes or no)\b/i.test(full)
        if (this.idleTimer) clearTimeout(this.idleTimer)
        this.idleTimer = setTimeout(
          () => (this.useMse ? this.endMse() : this.flushAudio()),
          TTS_TAIL_MS) as unknown as number
        this.turnDone()
        break
      }
    }
  }

  /** The turn is over: the server has now written this exchange to history, so the
   *  NEXT message will actually see it. Anything the user said while we were busy
   *  goes out as a single merged message. */
  private turnDone() {
    this.busy = false
    if (this.queued.length) {
      const merged = this.queued.join(' ')
      this.queued = []
      void this.ask(merged)
    }
  }

  /** Start a fresh conversation without dropping the call — new session id, so the
   *  agent stops carrying the previous topic. */
  async newSession() {
    this.queued = []
    this.busy = false
    this.sessionId = undefined
    await this.openSession()
    return this.sessionId
  }

  private speak(text: string) {
    this.tts?.send(JSON.stringify({ type: 'text', data: { text } }))
  }

  // ── Mic ───────────────────────────────────────────────────────────────────

  private async openMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    })
    const ctx = new AudioContext()
    this.ctx = ctx
    const src = ctx.createMediaStreamSource(this.stream)
    // ScriptProcessor is deprecated in favour of AudioWorklet, but a worklet needs a
    // separate module file and buys nothing for a spike — this runs for seconds at a
    // time, not hours.
    const node = ctx.createScriptProcessor(4096, 1, 1)
    this.node = node
    const framesPer = TARGET_SR * (FRAME_MS / 1000)

    node.onaudioprocess = ev => {
      if (!this.running || this.stt?.readyState !== WebSocket.OPEN) return
      const input = ev.inputBuffer.getChannelData(0)

      let sum = 0
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i]
      const rms = Math.sqrt(sum / input.length)
      this.h.onLevel(rms)
      if (rms >= GATE_RMS) this.loudAt = performance.now()
      // Disabled → always open, i.e. exactly the behaviour before the gate existed.
      const gateOpen = !GATE_ENABLED
        || performance.now() - this.loudAt < GATE_HANGOVER_MS

      const pcm = toPcm16(input, ctx.sampleRate)
      for (let i = 0; i < pcm.length; i++) this.pending.push(pcm[i])

      // Emit fixed 100 ms frames regardless of the browser's buffer size — the
      // whole point of the buffer.
      while (this.pending.length >= framesPer) {
        const frame = Int16Array.from(this.pending.splice(0, framesPer))
        /**
         * 🔴 HALF-DUPLEX WHILE SPEAKING. Do not send the microphone upstream while
         * Oscar is talking.
         *
         * The mic stays open through the reply, so the speaker feeds straight back
         * into it. Sarvam transcribes Oscar's own words as a user utterance, that
         * utterance ends the current turn and starts a new one, and what the user
         * experiences is the reply being cut off mid-sentence for no reason. On a
         * laptop echoCancellation hides most of it; through a phone's loudspeaker it
         * does not, and every reply is at risk.
         *
         * Gating here — at the send — rather than closing the socket keeps the STT
         * connection warm (reconnecting costs a round trip per turn) and keeps the
         * frame clock intact. Sarvam simply sees silence, which is the truth: the only
         * sound in the room is ours.
         *
         * The cost is barge-in: you cannot interrupt by voice while this holds, so the
         * earlier VAD-based interruption is now effectively off during playback. That
         * is the right trade — an interruption that works sometimes is worth less than
         * a reply that always finishes. A tap-to-interrupt control is the honest way
         * back to barge-in and needs no echo heuristics at all.
         */
        if (this.speaking) continue
        // Quiet: hold the frame in the pre-roll and send nothing. The buffer is short,
        // so an idle tab costs nothing and the first word is still not clipped.
        if (!gateOpen) {
          this.preroll.push(frame)
          if (this.preroll.length > GATE_PREROLL_FRAMES) this.preroll.shift()
          continue
        }
        // Gate just opened — flush what was held so the utterance starts intact.
        if (this.preroll.length) {
          // Identical payload shape to the live send below — a pre-roll frame that
          // differs is a frame Sarvam quietly ignores, which would clip exactly the
          // syllable this buffer exists to preserve.
          for (const held of this.preroll) {
            this.stt.send(JSON.stringify({ event: 'audio_input', audio: b64(held) }))
          }
          this.preroll = []
        }
        this.stt.send(JSON.stringify({
          event: 'audio_input', audio: b64(frame),
        }))
      }
    }
    src.connect(node)
    node.connect(ctx.destination)
  }
}
