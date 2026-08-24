/**
 * Raw-PCM streaming player — the one piece of the Sarvam pipeline that could NOT
 * be reused.
 *
 * `liveVoice.ts` plays Sarvam's mp3 through `MediaSource('audio/mpeg')`: hand it
 * container bytes and the browser decodes, buffers and schedules them for you.
 * Gemini returns **raw little-endian PCM16 at 24 kHz with no container**, so
 * MediaSource cannot be used at all — there is no MIME type for it and
 * `isTypeSupported('audio/pcm')` is false everywhere. The audio has to be fed
 * into the graph sample by sample, which means an AudioWorklet over a ring buffer.
 *
 * Why a worklet and not `AudioBufferSourceNode` per chunk — the obvious approach,
 * and it is wrong: chunks arrive every ~20-60 ms, and scheduling each as its own
 * source node leaves an audible seam at every boundary the moment one arrives a
 * millisecond late. The worklet runs on the audio thread with a continuous buffer,
 * so a late chunk is a brief underrun that fills back in rather than a click.
 *
 * The worklet is compiled from a Blob URL rather than shipped as a separate file:
 * `addModule` needs a real URL, and adding an entry to `public/` would be a build
 * change for no benefit. Same code, no build config.
 *
 * Lives in `lib/` because BOTH the app engine (`geminiVoice.ts`) and the POC page
 * use it. Two copies would mean a bug fixed in one surviving in the other.
 */

/** Fixed by the Live API — not a preference. Playing 24 kHz audio through a
 *  48 kHz context without telling it the rate plays everything at double speed,
 *  which sounds like a chipmunk rather than like an error. */
export const GEMINI_OUTPUT_RATE = 24000

/** The worklet. Runs on the audio thread, so it may not allocate or log.
 *
 *  A plain Float32Array ring buffer with read/write cursors. Sized for ~8 s of
 *  audio: long enough that a network stall does not underrun, short enough that
 *  `clear()` on a barge-in does not leave seconds of stale speech to drain. */
const WORKLET_SRC = `
class PcmRing extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = new Float32Array(${GEMINI_OUTPUT_RATE} * 8)
    this.r = 0
    this.w = 0
    this.playing = false
    this.port.onmessage = e => {
      const m = e.data
      if (m.type === 'push') {
        const s = m.samples
        for (let i = 0; i < s.length; i++) {
          this.buf[this.w] = s[i]
          this.w = (this.w + 1) % this.buf.length
          // Overrun: the producer outran the speaker. Drop the OLDEST sample by
          // shoving the read cursor forward — losing the front of an 8 s backlog
          // is inaudible, whereas overwriting ahead of the read cursor would
          // splice the future into the present mid-word.
          if (this.w === this.r) this.r = (this.r + 1) % this.buf.length
        }
      } else if (m.type === 'clear') {
        // Barge-in. Everything already buffered is a reply the user has stopped
        // listening to, so it is discarded rather than drained.
        this.r = this.w = 0
        this.playing = false
      }
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0][0]
    let avail = (this.w - this.r + this.buf.length) % this.buf.length
    for (let i = 0; i < out.length; i++) {
      if (avail > 0) {
        out[i] = this.buf[this.r]
        this.r = (this.r + 1) % this.buf.length
        avail--
        if (!this.playing) { this.playing = true; this.port.postMessage({ type: 'start' }) }
      } else {
        out[i] = 0
        if (this.playing) { this.playing = false; this.port.postMessage({ type: 'drain' }) }
      }
    }
    return true      // never let the node be garbage collected mid-session
  }
}
registerProcessor('pcm-ring', PcmRing)
`

export type PcmPlayerEvents = {
  /** First sample of a reply actually reaching the speaker. This — not the
   *  arrival of the first WebSocket frame — is the honest end of the
   *  "how long until I hear something" measurement. */
  onStart?: () => void
  /** Buffer ran dry. Either the reply finished or the network stalled; the
   *  caller knows which because it also sees `turnComplete`. */
  onDrain?: () => void
}

export class PcmPlayer {
  private ctx?: AudioContext
  private node?: AudioWorkletNode
  private ev: PcmPlayerEvents

  constructor(ev: PcmPlayerEvents = {}) { this.ev = ev }

  async start(): Promise<void> {
    if (this.node) return
    // The context is created AT Gemini's rate so no resampling happens in our
    // code at all — the hardware does it, correctly, for free.
    const ctx = new AudioContext({ sampleRate: GEMINI_OUTPUT_RATE })
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'text/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)      // the module is compiled; the URL is dead weight
    }
    const node = new AudioWorkletNode(ctx, 'pcm-ring')
    node.port.onmessage = e => {
      if (e.data?.type === 'start') this.ev.onStart?.()
      else if (e.data?.type === 'drain') this.ev.onDrain?.()
    }
    node.connect(ctx.destination)
    this.ctx = ctx
    this.node = node
    // Autoplay policy: a context created before a user gesture starts suspended
    // and every sample is silently discarded. Resuming here is harmless when it
    // is already running and is the difference between working and "no audio,
    // no error" when it is not.
    if (ctx.state === 'suspended') await ctx.resume()
  }

  /** Feed one base64 chunk of raw PCM16 straight from the wire. */
  push(base64: string): void {
    if (!this.node) return
    const bin = atob(base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    // A chunk can arrive with an odd byte count if it splits a sample across
    // frames; the trailing byte is dropped rather than read past the end.
    const n = bytes.length >> 1
    const view = new DataView(bytes.buffer)
    const samples = new Float32Array(n)
    for (let i = 0; i < n; i++) samples[i] = view.getInt16(i * 2, true) / 0x8000
    this.node.port.postMessage({ type: 'push', samples }, [samples.buffer])
  }

  /** Barge-in: drop everything buffered, immediately. */
  clear(): void { this.node?.port.postMessage({ type: 'clear' }) }

  async stop(): Promise<void> {
    this.clear()
    this.node?.disconnect()
    this.node = undefined
    await this.ctx?.close().catch(() => {})
    this.ctx = undefined
  }
}
