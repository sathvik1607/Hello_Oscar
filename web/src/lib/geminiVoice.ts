/**
 * Gemini 3.1 Flash Live as the app's voice engine — a DROP-IN for `LiveVoice`.
 *
 *   Sarvam path   mic → Sarvam STT → /chat/stream → Sarvam TTS → speaker   (5 sockets)
 *   this          mic → Gemini Live ──────────────────────────→ speaker    (2 sockets)
 *
 * 🔴 IT IMPLEMENTS THE SAME `Handlers` CONTRACT AS `LiveVoice`, DELIBERATELY.
 * Same constructor `(handlers, userId, speaker)`, same `start`/`stop`/`interrupt`/
 * `isRunning`. So `VoiceProvider` swaps one import and nothing else in the app
 * changes — not the overlay, not the orb, not the transcript view.
 *
 * ⚠️ SWITCHING BACK IS AN ENV VAR **PLUS A REBUILD**, not a runtime toggle. Vite
 * inlines `import.meta.env.VITE_VOICE_ENGINE` at build time, so the unused engine
 * is tree-shaken out entirely — verified: a default build contains no
 * `voice/sarvam` reference at all, and `VITE_VOICE_ENGINE=sarvam npm run build`
 * emits `liveVoice` and drops this file. Good for bundle size, but it means a
 * deployed page cannot be flipped by changing an env var on the server.
 *
 * The wake logic is REUSED from `wakeWord.ts`, not forked. It carries detail that
 * cost real debugging — `"send hello oscar poster to sriram"` passed a naive
 * substring test and was answered as a greeting — and two copies would mean a fix
 * in one silently surviving in the other. It was extracted out of `liveVoice.ts`
 * (moved verbatim) rather than imported FROM it, because a value import across
 * engines bundles the whole ~1,000-line Sarvam engine into the Gemini chunk.
 *
 * WHAT THE APP GAINS
 * ------------------
 * · One socket instead of five: no STT relay, no TTS relay, no sentence splitting.
 * · Native barge-in — the server tells us it was interrupted, so the mic can stay
 *   hot through the reply instead of being gated shut.
 * · ~1.2 s to first audio on a conversational turn (measured, 4 ms spread over ten
 *   consecutive turns).
 *
 * WHAT THE APP LOSES, AND THESE ARE REAL
 * --------------------------------------
 * PERSISTENCE. A chat session is opened on start and its id rides on the socket,
 * so the RELAY writes each completed turn to `pa_chat_messages` — voice history
 * now appears in the chat list like the typed path. Written server-side because the
 * relay already sees both transcripts and a client that reports its own
 * conversation can report anything.
 *
 * ⚠️ What is saved is the TRANSCRIPT, not what Gemini understood. On a native-audio
 * model the transcription is a separate lossy channel — measured, it rendered "who
 * are my teammates" as "Poor my teammates" while the tool call was perfect. So
 * history is a faithful record of the transcript and an approximate record of the
 * conversation. If the session cannot be opened, voice still works and simply
 * persists nothing.
 *
 * 🔴 `onReplyToken` IS A TRANSCRIPT, NOT THE ANSWER. On the Sarvam path the text
 * IS the reply — it is what gets spoken. Here Gemini speaks from audio directly and
 * `outputTranscription` is a separate, lossy rendering of what it said. The caption
 * can differ slightly from the audio. It is the best text available; it is not
 * authoritative.
 *
 * 🔴 The same is true INBOUND, and it surprised us: `inputTranscription` is a
 * courtesy channel, not what Gemini understands from. Measured — the transcript
 * read `"Poor my teammates."` and the model correctly called `list_team_members`.
 * So a scruffy `onPartial`/`onFinal` does NOT mean it misheard you.
 */

import { PcmPlayer } from './pcmPlayer'
import { getBase, getToken, getUser, getWsBase } from './session'
import { GEMINI_VOICES } from './speakers'
import { wakeStrip } from './wakeWord'
import type { Handlers, Phase } from './liveVoice'

/** One task/meeting Oscar's answer referred to. Ids only — the client resolves them
 *  against task data it already holds. */
export type OscarItem = { id: number; type: 'task' | 'meeting' }

/**
 * `Handlers` plus the one signal the Sarvam engine has no equivalent for.
 *
 * Extended HERE rather than in `liveVoice.ts`, which is the shipping Sarvam engine
 * and stays untouched. `onItems` is optional, so every existing caller still
 * satisfies the type and the two engines remain interchangeable.
 */
export type GeminiHandlers = Handlers & {
  onItems?: (items: OscarItem[]) => void
}

const FRAME_MS = 100
/** Fixed by the Live API. Sending the browser's native 48 kHz makes Gemini hear
 *  speech at a third speed and transcribe gibberish rather than erroring. */
const TARGET_SR = 16000

/** Gemini's own VAD ends the turn, so this timer only STAMPS latency — it never
 *  gates what is sent. Kept because only the browser knows, in wall-clock terms,
 *  when the user stopped talking. */
const OBSERVER_SILENCE_MS = 500
const OBSERVER_RMS = 0.012

/** How long after a reply a follow-up may skip the wake word. Mirrors
 *  `liveVoice.FOLLOWUP_MS` — a conversation where every sentence must re-address
 *  the assistant is not a conversation. */
const FOLLOWUP_MS = 20000

const voiceWs = () => `${getWsBase()}/voice/gemini/live`

/** Averaged, not decimated: decimation aliases and measurably degrades sibilants.
 *  Same function as the Sarvam path, because the capture requirement is identical —
 *  16 kHz mono PCM16 in 100 ms frames. */
function toPcm16(input: Float32Array, fromRate: number): Int16Array {
  const ratio = fromRate / TARGET_SR
  const outLen = Math.floor(input.length / ratio)
  const out = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = Math.max(-1, Math.min(1, sum / Math.max(1, end - start))) * 0x7fff
  }
  return out
}

function b64(samples: Int16Array): string {
  const u8 = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let s = ''
  // Chunked: String.fromCharCode(...u8) blows the argument limit past ~64 kB. A
  // 100 ms frame is 3.2 kB, so this is headroom rather than a fix.
  for (let i = 0; i < u8.length; i += 0x8000) {
    s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

/** Sarvam speaker names mean nothing to Gemini, and an unknown `voiceName` is
 *  rejected mid-setup — which surfaces as "voice is broken" rather than as a bad
 *  parameter. So the stored preference is mapped, and anything unrecognised falls
 *  back rather than being forwarded. */
function toGeminiVoice(speaker: string | undefined): string {
  if (speaker && (GEMINI_VOICES as readonly string[]).includes(speaker)) return speaker
  return (import.meta.env.VITE_GEMINI_VOICE as string) || 'Puck'
}

export class GeminiVoice {
  private h: GeminiHandlers
  private userId: number
  private voice: string
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
  private turnNo = 0

  // Latency observation only — never gates the microphone.
  private loudAt = 0
  private silenceStamped = false
  private speechEndAt: number | null = null
  private awaitingAudio = false
  private heard = ''
  private said = ''
  private toolRan = false
  private lastReplyAt = 0
  private speaking = false
  /** 🔴 Set when the user interrupts by tap/Space. Clearing the buffer is NOT
   *  enough: Gemini is still generating and keeps streaming the rest of the reply,
   *  so the freed buffer refills and playback RESUMES mid-sentence — "it stops,
   *  then carries on from where it stopped". Incoming audio is dropped for the
   *  remainder of the interrupted turn, so a tap ends the reply rather than
   *  pausing it.
   *
   *  A local drop rather than a protocol signal because the manual activity
   *  frames (`activityStart`/`activityEnd`) are only available with automatic VAD
   *  DISABLED, and Gemini's own VAD is the thing making barge-in work. */
  private dropUntilTurnEnd = false
  /** The chat session spoken turns are written into. Null when it could not be
   *  opened — voice keeps working, it just leaves no history. */
  private sessionId: number | null = null

  constructor(h: GeminiHandlers, userId: number = getUser()?.id ?? 0, speaker?: string) {
    this.h = h
    this.userId = userId
    this.voice = toGeminiVoice(speaker)
  }

  get isRunning() { return this.running }

  async start() {
    // Fail loudly BEFORE asking for a microphone. Prompting for the mic and then
    // dying on auth is the worst order — the user grants a permission for nothing.
    if (!getToken() || !this.userId) {
      this.h.onError('Please sign in again to use voice.')
      return
    }
    this.h.onPhase('idle')
    try {
      await this.player.start()
      // Before the socket, because the id has to ride on its query string. A
      // failure here is non-fatal by design — see openSession.
      await this.openSession()
      await this.openSocket()
      await this.openMic()
      this.running = true
      this.h.onPhase('listening')
    } catch (e: any) {
      this.h.onError(
        /permission|NotAllowed/i.test(String(e?.name || e))
          ? 'Microphone permission was refused.'
          : `Voice could not start: ${e?.message || e}`)
      this.stop()
    }
  }

  /** Open a chat session so the relay has somewhere to write.
   *
   *  Deliberately swallows its own failure: losing history is a far smaller
   *  problem than refusing to let the user speak, so a session that cannot be
   *  created leaves `sessionId` null and the call proceeds unpersisted.
   */
  private async openSession(): Promise<void> {
    try {
      const r = await fetch(`${getBase()}/chat/sessions?user_id=${this.userId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        },
        body: JSON.stringify({ user_id: this.userId }),
      })
      if (r.ok) this.sessionId = (await r.json()).session_id ?? null
    } catch {
      this.sessionId = null
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      // A browser cannot set headers on a WebSocket, so the bearer token rides as
      // ?t= — same door the Sarvam relays use. `user_id` rides along so the relay
      // can refuse a token that arrives claiming a different user.
      const url = `${voiceWs()}?user_id=${this.userId}`
        + `&t=${encodeURIComponent(getToken() || '')}&voice=${this.voice}`
        + (this.sessionId ? `&session_id=${this.sessionId}` : '')
      const ws = new WebSocket(url)
      this.ws = ws
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('could not reach the voice service'))
      ws.onclose = ev => {
        if (this.running && ev.code !== 1000) {
          this.h.onError(ev.code === 1008
            ? 'Voice is not authorised for this account.'
            : 'The voice connection dropped.')
        }
        this.running = false
        this.h.onPhase('idle')
      }
      ws.onmessage = e => this.onServer(e.data)
    })
  }

  private onServer(data: unknown) {
    let msg: any
    try { msg = JSON.parse(typeof data === 'string' ? data : '') } catch { return }
    if (!msg) return

    if (msg.setupComplete) return
    if (msg.goAway) { this.h.onError('The voice session is ending.'); return }
    if (msg.toolCall) {
      // A tool turn is a model pass, a backend round trip and a second pass, so it
      // is flagged: its first-word time is not comparable to a plain reply and must
      // not be averaged with one.
      this.toolRan = true
      this.h.onTool?.(true)
      this.h.onPhase('thinking')
      return
    }
    /**
     * The task/meeting ids Oscar's answer referred to. Injected by the relay, not
     * part of Google's protocol.
     *
     * 🔴 THIS EXISTS BECAUSE GEMINI PARAPHRASES. Oscar's answer says "Prepare the
     * vendor onboarding deck"; Gemini speaks it as "preparing the vendor onboarding
     * deck". Every verb is conjugated, so matching the spoken transcript against
     * task titles finds nothing — measured on all four of a test user's tasks. Ids
     * cannot be paraphrased, so the relay sends those instead and the browser never
     * has to guess what was meant.
     */
    if (Array.isArray(msg.oscarItems)) {
      const items = (msg.oscarItems as unknown[])
        .filter((i): i is OscarItem =>
          !!i && typeof (i as OscarItem).id === 'number')
      if (items.length > 0) this.h.onItems?.(items)
      return
    }
    // Injected by the relay, not part of Google's protocol.
    if (msg.pocToolResult || msg.pocGuard) return

    const sc = msg.serverContent
    if (!sc) return

    if (sc.interrupted) {
      // Native barge-in. Everything buffered is a reply the user talked over, so it
      // is dropped rather than played out — otherwise the speaker keeps finishing a
      // sentence the user has already moved past.
      this.player.clear()
      // A server-side interruption already ends the turn upstream, so nothing more
      // arrives for it — the drop flag is cleared rather than set.
      this.dropUntilTurnEnd = false
      this.h.onPhase('listening')
      this.awaitingAudio = false
      this.speechEndAt = null
    }

    if (sc.inputTranscription?.text) {
      this.heard += sc.inputTranscription.text
      // Partial while it accumulates. The wake decision waits for the turn to end,
      // because a wake word is positional and a half-heard sentence cannot be judged.
      this.h.onPartial(this.heard.trim())
    }
    if (sc.outputTranscription?.text) {
      // Accumulated either way, so history keeps the whole reply. But NOT emitted
      // to the UI once interrupted: Gemini goes on transcribing the sentence it is
      // no longer allowed to speak, and pushing that to the screen made the
      // interrupted reply keep growing there after the screen had been cleared —
      // "the previous message is still showing". Silencing the audio without
      // silencing the caption is only half an interrupt.
      this.said += sc.outputTranscription.text
      if (!this.dropUntilTurnEnd) this.h.onReplyToken(this.said.trim())
    }

    for (const p of sc.modelTurn?.parts ?? []) {
      // Still accumulated into `said` above, deliberately: the transcript of what
      // Gemini was saying stays complete and gets persisted, even though the user
      // chose not to hear the rest of it.
      if (p.inlineData?.data && !this.dropUntilTurnEnd) this.player.push(p.inlineData.data)
    }

    if (sc.turnComplete) this.endTurn()
  }

  private endTurn() {
    const heard = this.heard.trim()
    if (heard) {
      // 🔴 The wake gate. Ambient mode keeps the microphone open, so without this
      // every passing remark becomes a turn. `wakeStrip` returns null when the
      // utterance was not addressed to Oscar; a follow-up inside FOLLOWUP_MS is
      // treated as still addressed, so a conversation does not need the name every
      // sentence.
      const invited = performance.now() - this.lastReplyAt < FOLLOWUP_MS
      const stripped = wakeStrip(heard)
      if (stripped !== null || invited) {
        this.h.onFinal(stripped ?? heard)
      }
      // Not addressed and not invited: left as a partial, exactly as the Sarvam
      // engine does. The app opens the overlay on onFinal, so this is what stops
      // background chatter from summoning the UI.
    }
    this.lastReplyAt = performance.now()
    this.h.onTool?.(false)
    this.dropUntilTurnEnd = false      // next turn starts audible
    this.heard = ''
    this.said = ''
    this.turnNo++
    this.toolRan = false
    // Phase is NOT set to listening here: turnComplete means generation finished,
    // not that playback did. The buffer's drain is the honest end of speaking.
  }

  private onAudioStart() {
    if (this.awaitingAudio && this.speechEndAt != null) {
      this.h.onTimings({
        audioMs: Math.round(performance.now() - this.speechEndAt),
        turn: this.turnNo,
        tool: this.toolRan,
      })
      this.awaitingAudio = false
    }
    this.speaking = true
    this.h.onPhase('speaking')
  }

  private onAudioDrain() {
    this.speaking = false
    this.lastReplyAt = performance.now()
    if (this.running) this.h.onPhase('listening')
  }

  private async openMic() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      // 🔴 echoCancellation is load-bearing, not box-ticking. The mic stays HOT
      // through the reply — that is what makes native barge-in possible, and it is
      // the opposite of the Sarvam engine's half-duplex gate. Without AEC, Gemini
      // hears its own voice and interrupts itself. Browser AEC handles a laptop;
      // a phone loudspeaker is weaker, so headphones are still the honest advice.
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    })
    const ctx = new AudioContext()
    this.ctx = ctx
    const src = ctx.createMediaStreamSource(this.stream)
    this.src = src
    // ScriptProcessor is deprecated in favour of AudioWorklet, but the capture side
    // is ported verbatim from the shipping Sarvam engine so this swap changes the
    // MODEL, not the microphone. Playback needed a worklet for real reasons; this
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

      const now = performance.now()
      if (rms >= OBSERVER_RMS) {
        this.loudAt = now
        this.silenceStamped = false
      } else if (!this.silenceStamped && this.loudAt > 0
                 && now - this.loudAt >= OBSERVER_SILENCE_MS) {
        this.silenceStamped = true
        this.speechEndAt = this.loudAt + OBSERVER_SILENCE_MS
        this.awaitingAudio = true
        if (!this.speaking) this.h.onPhase('thinking')
      }

      const pcm = toPcm16(input, ctx.sampleRate)
      for (let i = 0; i < pcm.length; i++) this.pending.push(pcm[i])

      // 🔴 100 ms FRAMES ARE MANDATORY. 20 ms frames — what a mic naturally emits —
      // transcribe as "Rem, Rem, Rem", and the socket reports no error at all. This
      // was the single most expensive thing learned building the Sarvam path.
      while (this.pending.length >= framesPer) {
        const frame = Int16Array.from(this.pending.splice(0, framesPer))
        this.ws.send(JSON.stringify({
          realtimeInput: {
            audio: { data: b64(frame), mimeType: `audio/pcm;rate=${TARGET_SR}` },
          },
        }))
      }
    }
    src.connect(node)
    // A ScriptProcessorNode does not run unless connected to a destination, even
    // with its output unused. Routing to `destination` would echo the microphone to
    // the speaker, so it goes through a zero-gain node — without this,
    // `onaudioprocess` never fires and voice looks like a dead socket.
    const mute = ctx.createGain()
    mute.gain.value = 0
    node.connect(mute)
    mute.connect(ctx.destination)
  }

  /** Stop speaking now. Gemini also interrupts itself on real barge-in; this is the
   *  tap-to-stop path the overlay offers. */
  interrupt() {
    // Order matters: raise the flag BEFORE clearing, or a chunk arriving between
    // the two lines lands in the buffer and playback stutters back to life.
    this.dropUntilTurnEnd = true
    this.player.clear()
    this.speaking = false
    // Wipe the caption explicitly rather than relying on the phase change. The
    // provider clears on speaking → listening, but a transcript chunk arriving a
    // moment later would repopulate it — this makes the screen state match the
    // audio state at the instant of the interrupt.
    this.h.onReplyToken('')
    this.h.onPartial('')
    if (this.running) this.h.onPhase('listening')
  }

  stop() {
    this.running = false
    try { this.node?.disconnect() } catch {}
    try { this.src?.disconnect() } catch {}
    this.stream?.getTracks().forEach(t => t.stop())
    void this.ctx?.close().catch(() => {})
    void this.player.stop()
    // 1000 so `onclose` can tell a deliberate stop from a dropped connection and
    // not show the user an error for something they did on purpose.
    this.ws?.close(1000, 'client stop')
    this.h.onPhase('idle')
  }
}

export type { Handlers, Phase }
