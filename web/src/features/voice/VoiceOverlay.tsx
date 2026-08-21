import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Settings2, X } from 'lucide-react'
import { LiveVoice, type Phase } from '../../lib/liveVoice'
import { SPEAKERS } from '../../lib/speakers'
import { Button, Portal, cx } from '../../ui'

/**
 * Full-screen voice. The one surface where Oscar is the product rather than a
 * feature of a screen.
 *
 * The engine underneath is the panel's proven LiveVoice, unchanged. What this file
 * adds is the part a user actually experiences, and each piece answers a specific
 * way the spike UI failed to communicate:
 *
 *  · the ORB carries the state. Four phases, four distinct behaviours — it breathes
 *    with your voice while listening, pulses on its own while thinking (so the wait
 *    never looks frozen), and settles while speaking. A spinner cannot say which of
 *    those four is happening, and "which" is the only question a user has.
 *
 *  · the PARTIAL transcript is shown as it arrives. Without it there is no evidence
 *    the microphone is working, and the failure mode of a silent open mic is
 *    indistinguishable from a broken one.
 *
 *  · a TAP interrupts. The microphone is muted while Oscar speaks — he was
 *    transcribing his own voice and cutting his turn short — so voice barge-in is
 *    off by design. A tap needs no echo heuristics and works on a loudspeaker.
 *
 *  · the wake word is STATED. An open microphone with an invisible gate is a
 *    privacy question the user cannot answer; telling them the name is the answer.
 */

const PHASE_COPY: Record<Phase, { title: string; hint: string }> = {
  idle:      { title: 'Tap to start', hint: 'Oscar will listen until you close this' },
  listening: { title: 'Listening',    hint: 'Say "Oscar…" then what you need' },
  thinking:  { title: 'Working on it', hint: 'Checking your tasks and calendar' },
  speaking:  { title: 'Speaking',     hint: 'Tap to interrupt' },
}

const WAKE = (import.meta.env.VITE_WAKE_WORD as string) ?? 'oscar'

export function VoiceOverlay({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [level, setLevel] = useState(0)
  const [partial, setPartial] = useState('')
  const [heard, setHeard] = useState('')
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [speaker, setSpeaker] = useState(
    (import.meta.env.VITE_SARVAM_SPEAKER as string) ?? 'dev')
  const [showSettings, setShowSettings] = useState(false)

  const engine = useRef<LiveVoice | null>(null)

  const stop = useCallback(() => {
    engine.current?.stop()
    engine.current = null
  }, [])

  // Stopping on unmount is not optional: the engine holds a microphone stream, an
  // AudioContext and three sockets. Leaking those leaves the browser's recording
  // indicator lit after the overlay is gone, which is alarming and correct — it
  // really would still be listening.
  useEffect(() => stop, [stop])

  const start = useCallback(async () => {
    setError(null); setPartial(''); setHeard(''); setReply('')
    const lv = new LiveVoice({
      onPhase: p => { setPhase(p); if (p === 'listening') setPartial('') },
      onLevel: setLevel,
      onPartial: setPartial,
      onFinal: t => { setHeard(t); setPartial(''); setReply('') },
      onReplyToken: setReply,
      // Required by the engine, deliberately unused: the numbers are
      // instrumentation, and this is the assistant's screen rather than a
      // benchmark. Re-add a readout here if voice ever feels slow.
      onTimings: () => {},
      onError: setError,
    }, undefined, speaker)
    engine.current = lv
    await lv.start()
  }, [speaker])

  /** One control, three meanings, in priority order: interrupt a reply, else start
   *  a call, else do nothing (the call is already live and listening — tapping
   *  should not hang up mid-sentence by accident). */
  const onOrbTap = useCallback(() => {
    const e = engine.current
    if (e?.isRunning && e.isSpeaking) { e.interrupt(); return }
    if (!e?.isRunning) void start()
  }, [start])

  // Escape closes. Space starts or interrupts — the two things you want without
  // moving your hand, and both ignored while typing so a future text input inside
  // the overlay cannot be hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      if (e.key === 'Escape') { stop(); onClose() }
      if (e.code === 'Space') { e.preventDefault(); onOrbTap() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onOrbTap, stop])

  const live = phase !== 'idle'
  const copy = PHASE_COPY[phase]
  // Capped so a loud room cannot inflate the orb off the screen; the multiplier is
  // generous enough that normal speech is visibly moving it.
  const scale = phase === 'listening' ? 1 + Math.min(level * 5.5, 0.4) : 1

  return (
    <Portal>
      <div
      className="fade fixed inset-0 z-[60] flex flex-col"
      style={{ background: 'var(--bg)' }}
      role="dialog" aria-modal="true" aria-label="Talk to Oscar"
    >
      <header className="flex items-center justify-between px-4 py-3.5 sm:px-6">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Mic className="size-4" style={{ color: 'var(--accent)' }} /> Voice
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setShowSettings(v => !v)} aria-label="Voice settings"
                  className="grid size-9 place-items-center rounded-lg"
                  style={{ color: 'var(--text-muted)' }}>
            <Settings2 className="size-4" />
          </button>
          <button onClick={() => { stop(); onClose() }} aria-label="Close voice"
                  className="grid size-9 place-items-center rounded-lg"
                  style={{ color: 'var(--text-muted)' }}>
            <X className="size-5" />
          </button>
        </div>
      </header>

      {showSettings && (
        <div className="fade mx-auto w-full max-w-md px-4 pb-2 sm:px-6">
          <label className="flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5"
                 style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}>
            <span className="text-[13px] font-medium">Oscar's voice</span>
            <select
              value={speaker}
              // Changing the voice mid-call would need the TTS socket reconfigured,
              // and the config frame is sent once at connect. Disabled while live
              // rather than silently ignored — a control that does nothing is worse
              // than one that is visibly unavailable.
              disabled={live}
              onChange={e => setSpeaker(e.target.value)}
              className="rounded-lg border px-2 py-1 text-[13px]"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
            >
              {SPEAKERS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          {live && (
            <p className="mt-1.5 px-1 text-[11px]" style={{ color: 'var(--text-subtle)' }}>
              Close and reopen to change voice.
            </p>
          )}
        </div>
      )}

      {/* ── the orb ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 flex-col items-center justify-center gap-7 px-6">
        <button
          onClick={onOrbTap}
          aria-label={phase === 'speaking' ? 'Interrupt Oscar'
                    : live ? 'Listening' : 'Start talking'}
          className="relative grid size-52 place-items-center rounded-full sm:size-60"
        >
          {/* Halo. Distinct animation per phase so the state is legible from across
              a desk, without reading any text. */}
          <span className={cx('absolute inset-0 rounded-full transition-opacity duration-500',
                              phase === 'listening' && 'animate-ping',
                              phase === 'thinking' && 'breathe',
                              phase === 'speaking' && 'animate-pulse',
                              phase === 'idle' && 'opacity-0')}
                style={{
                  background:
                    phase === 'thinking' ? 'rgba(245,158,11,.18)'
                    : phase === 'speaking' ? 'rgba(34,197,94,.18)'
                    : 'color-mix(in srgb, var(--accent) 18%, transparent)',
                }} />
          <span
            style={{
              transform: `scale(${scale})`,
              background:
                phase === 'idle' ? 'var(--bg-sunken)'
                : phase === 'thinking' ? 'rgba(245,158,11,.22)'
                : phase === 'speaking' ? 'rgba(34,197,94,.22)'
                : 'color-mix(in srgb, var(--accent) 22%, transparent)',
            }}
            // 100ms so it tracks the mic frames rather than lagging behind them.
            className="grid size-44 place-items-center rounded-full transition-[transform,background-color]
                       duration-100 sm:size-52"
          >
            <Mic className="size-11" style={{ color: live ? 'var(--accent)' : 'var(--text-subtle)' }} />
          </span>
        </button>

        <div className="text-center">
          <div className="text-lg font-semibold">{copy.title}</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{copy.hint}</div>
        </div>

        {/* Live transcript. min-height reserved so the orb does not jump every time
            a partial arrives and disappears. */}
        <div className="min-h-[4.5rem] w-full max-w-xl text-center">
          {partial && (
            <p className="text-[15px] italic" style={{ color: 'var(--text-subtle)' }}>{partial}</p>
          )}
          {!partial && heard && (
            <p className="text-[15px] font-medium">{heard}</p>
          )}
          {reply && (
            <p className="mt-2.5 text-[15px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {reply}
            </p>
          )}
        </div>

        {error && (
          <div className="w-full max-w-md rounded-xl px-4 py-3 text-center text-[13px]"
               style={{ background: 'rgba(239,68,68,.1)', color: '#DC2626' }}>
            {error}
          </div>
        )}
      </div>

      {/* ── footer ──────────────────────────────────────────────────── */}
      <footer className="px-6 pb-8 pt-2 text-center"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
        {!live
          ? <Button variant="primary" onClick={() => void start()}>Start talking</Button>
          : <Button onClick={() => { stop(); setPhase('idle') }}>End</Button>}
        <p className="mx-auto mt-4 max-w-sm text-[11px] leading-relaxed"
           style={{ color: 'var(--text-subtle)' }}>
          The microphone stays open during a call. Oscar only acts on what is
          addressed to it — start with &ldquo;{WAKE}&rdquo;, or just answer when it
          asks you something.
        </p>
      </footer>
    </div>
    </Portal>
  )
}
