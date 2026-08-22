import {
  createContext, lazy, Suspense, useCallback, useContext, useEffect, useMemo,
  useRef, useState,
} from 'react'
import type { LiveVoice, Phase } from '../../lib/liveVoice'
import { DEFAULT_SPEAKER } from '../../lib/speakers'
import { isSignedIn } from '../../lib/session'
import { VOICE_CHORD, VOICE_HOTKEY, useChord, useHotkey } from '../../lib/hotkeys'

const VoiceOverlay = lazy(() => import('./VoiceOverlay')
  .then(m => ({ default: m.VoiceOverlay })))

/**
 * Owns the voice engine for the whole app, and can run it AMBIENTLY.
 *
 * The engine lives here rather than inside the overlay for two reasons:
 *
 * 1. **Ambient listening.** "Open the page, say Oscar, get an answer" means the
 *    microphone is live with no overlay on screen — so an engine owned by the
 *    overlay cannot do it. Waking is then just: hear the name, open the overlay to
 *    show what is happening.
 *
 * 2. Closing the overlay used to end the call. It now hides the view and leaves the
 *    conversation running when ambient mode is on, which is what "always listening"
 *    has to mean.
 *
 * 🔴 AMBIENT IS OPT-IN AND OFF BY DEFAULT, and that is not timidity:
 *
 *  · the STT socket streams continuously, so Sarvam bills every second the tab is
 *    open (~₹30/hour) and transcribes every conversation within earshot. Measured
 *    in a real session: two people talking near the laptop produced fifteen
 *    transcripts in ninety seconds, none addressed to the assistant. The wake word
 *    stops it ACTING on them; it does not stop us paying for them.
 *  · the browser shows a recording indicator for as long as it runs. A page that
 *    silently claims the microphone on load is a page nobody should trust.
 *
 * So it is a switch the user throws, remembered per browser, and it only
 * auto-resumes when the microphone permission has ALREADY been granted — never by
 * triggering a permission prompt on page load.
 */

export type VoiceState = {
  phase: Phase
  level: number
  partial: string
  heard: string
  reply: string
  error: string | null
  running: boolean
  speaking: boolean
  /** Set when the browser refused to play audio without a user gesture. Autoplay
   *  policy blocks sound until the page has been interacted with, so an ambient
   *  wake on a fresh load can be heard by us and not heard BY the user. */
  needsGesture: boolean
}

type Ctx = VoiceState & {
  overlayOpen: boolean
  ambient: boolean
  openVoice: () => void
  closeVoice: () => void
  setAmbient: (on: boolean) => void
  speaker: string
  setSpeaker: (s: string) => void
  interrupt: () => void
  end: () => void
}

const VoiceCtx = createContext<Ctx | null>(null)

export function useVoice(): Ctx {
  const c = useContext(VoiceCtx)
  if (!c) throw new Error('useVoice() used outside VoiceProvider')
  return c
}

const LS_AMBIENT = 'oscar.web.ambient'
const LS_SPEAKER = 'oscar.web.speaker'

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const [overlayOpen, setOverlayOpen] = useState(false)
  const [ambient, setAmbientState] = useState(
    () => localStorage.getItem(LS_AMBIENT) === '1')
  const [speaker, setSpeakerState] = useState(
    () => localStorage.getItem(LS_SPEAKER) ?? DEFAULT_SPEAKER)

  const [st, setSt] = useState<VoiceState>({
    phase: 'idle', level: 0, partial: '', heard: '', reply: '',
    error: null, running: false, speaking: false, needsGesture: false,
  })

  const engine = useRef<LiveVoice | null>(null)
  /** Guards against two concurrent starts. `start()` awaits a dynamic import, so a
   *  fast double-tap could otherwise get two engines — two microphones, two STT
   *  sockets, both billing. */
  const starting = useRef(false)
  // Read inside the engine's callbacks, which are created once and would otherwise
  // capture the first render's value forever.
  const overlayRef = useRef(overlayOpen)
  overlayRef.current = overlayOpen

  const stop = useCallback(() => {
    engine.current?.stop()
    engine.current = null
    setSt(s => ({ ...s, running: false, phase: 'idle', level: 0, partial: '' }))
  }, [])

  const start = useCallback(async () => {
    if (engine.current?.isRunning || starting.current) return
    starting.current = true
    setSt(s => ({ ...s, error: null, needsGesture: false }))
    // Imported on demand: the engine is ~1,000 lines of audio code and most page
    // loads never open a microphone. Ambient mode pays this on load, which is the
    // user's own choice rather than everyone's default.
    const { LiveVoice } = await import('../../lib/liveVoice')
    const lv = new LiveVoice({
      onPhase: p => setSt(s => ({
        ...s, phase: p, running: true,
        speaking: p === 'speaking',
        partial: p === 'listening' ? '' : s.partial,
      })),
      onLevel: level => setSt(s => (
        // Only while listening: the orb is the only consumer, and updating state
        // ~10×/second through a whole reply re-renders the app for nothing.
        s.phase === 'listening' ? { ...s, level } : s)),
      onPartial: partial => setSt(s => ({ ...s, partial })),
      onFinal: heard => {
        setSt(s => ({ ...s, heard, partial: '', reply: '' }))
        // 🔴 THE WAKE. A final transcript only reaches here when the engine decided
        // it was ADDRESSED to Oscar — everything else is filtered inside the engine
        // and surfaced as a partial. So this is the moment to show ourselves: the
        // user said the name and is owed visible evidence that it landed.
        if (!overlayRef.current) setOverlayOpen(true)
      },
      onReplyToken: reply => setSt(s => ({ ...s, reply })),
      onTimings: () => { /* instrumentation; see VoiceOverlay */ },
      onError: error => setSt(s => ({
        ...s, error,
        // Autoplay refusal is not a failure to answer — the reply exists and cannot
        // be heard. It needs a click, not a retry, so it gets its own flag.
        needsGesture: /blocked by the browser/i.test(error) || s.needsGesture,
      })),
    }, undefined, speaker)
    engine.current = lv
    try {
      await lv.start()
    } finally {
      starting.current = false
    }
  }, [speaker])

  const openVoice = useCallback(() => {
    setOverlayOpen(true)
    void start()
  }, [start])

  /** Hide the view. The call keeps running in ambient mode — that is the whole
   *  point — and ends otherwise. */
  const closeVoice = useCallback(() => {
    setOverlayOpen(false)
    if (!ambient) stop()
  }, [ambient, stop])

  const setAmbient = useCallback((on: boolean) => {
    localStorage.setItem(LS_AMBIENT, on ? '1' : '0')
    setAmbientState(on)
    if (on) void start()
    else if (!overlayRef.current) stop()
  }, [start, stop])

  const setSpeaker = useCallback((s: string) => {
    localStorage.setItem(LS_SPEAKER, s)
    setSpeakerState(s)
    // The TTS socket is configured once at connect, so a live call keeps the old
    // voice. Restarting mid-sentence to change it would be worse than waiting.
  }, [])

  /**
   * Auto-resume on load — but ONLY when the microphone is already granted.
   *
   * Calling getUserMedia to find out would raise a permission prompt on page load,
   * which is exactly the behaviour that makes people distrust a site. The
   * Permissions API answers without asking; where it is unsupported (Safari), we do
   * nothing and the user taps once.
   */
  useEffect(() => {
    if (!ambient || !isSignedIn()) return
    let cancelled = false
    void (async () => {
      try {
        const p = await navigator.permissions?.query(
          { name: 'microphone' as PermissionName })
        if (cancelled) return
        if (p?.state === 'granted') void start()
      } catch { /* unsupported — wait for a tap rather than prompting */ }
    })()
    return () => { cancelled = true }
    // Deliberately mount-only: re-running on every `start` identity change would
    // restart the engine mid-conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Never keep the microphone after sign-out.
  useEffect(() => {
    if (!isSignedIn()) stop()
  }, [stop])

  const interrupt = useCallback(() => engine.current?.interrupt(), [])

  /**
   * The keyboard route in, from any screen.
   *
   * Three meanings in priority order, so one key covers the whole interaction
   * without the user having to know which state they are in:
   *   speaking  → interrupt (the same thing tapping the orb does)
   *   open      → hide it again
   *   otherwise → open and start listening
   *
   * Suppressed inside text fields by useHotkey, which matters more here than for
   * any other shortcut: firing mid-sentence in the chat composer would open the
   * microphone and eat the keystroke.
   */
  const toggleVoice = useCallback(() => {
    if (st.speaking) { interrupt(); return }
    if (overlayRef.current) { closeVoice(); return }
    openVoice()
  }, [st.speaking, interrupt, closeVoice, openVoice])

  // Space + V — the same on macOS and Windows, no modifier to relabel.
  useChord(VOICE_CHORD, toggleVoice)
  // Alt + V — the equivalent for anyone who would rather not involve the space bar.
  useHotkey(VOICE_HOTKEY, toggleVoice)

  const value = useMemo<Ctx>(() => ({
    ...st, overlayOpen, ambient, openVoice, closeVoice, setAmbient,
    speaker, setSpeaker, interrupt, end: stop,
  }), [st, overlayOpen, ambient, openVoice, closeVoice, setAmbient,
       speaker, setSpeaker, interrupt, stop])

  return (
    <VoiceCtx.Provider value={value}>
      {children}
      {overlayOpen && (
        <Suspense fallback={null}>
          <VoiceOverlay />
        </Suspense>
      )}
    </VoiceCtx.Provider>
  )
}
