import { useCallback, useEffect, useMemo, useState } from 'react'
import { Mic, Radio, Settings2, X } from 'lucide-react'
import { VOICE_OPTIONS, validVoice } from '../../lib/speakers'
import { useVoice } from './VoiceProvider'
import { Button, Portal, cx } from '../../ui'
import { useTaskActions } from '../tasks/useTaskActions'
import { useSpokenTasks } from '../chat/useSpokenTasks'
import { VoicePanel } from './VoicePanel'
import type { Phase } from '../../lib/liveVoice'
import { VOICE_TAP_LABEL } from '../../lib/hotkeys'

/**
 * Full-screen voice. A VIEW over the provider's engine, not the owner of it —
 * closing this hides the conversation, it does not hang up (see VoiceProvider).
 *
 * Each piece answers a specific way the spike UI failed to communicate:
 *
 *  · the ORB carries the state. Four phases, four behaviours — it breathes with
 *    your voice while listening, pulses alone while thinking (so the wait never
 *    looks frozen), settles while speaking. A spinner cannot say which of the four
 *    is happening, and "which" is the only question a user has.
 *  · the PARTIAL transcript proves the microphone works. A silent open mic is
 *    indistinguishable from a broken one.
 *  · a TAP interrupts. The mic is muted while Oscar speaks — he was transcribing
 *    his own voice and cutting his turn short — so voice barge-in is off by design.
 *  · the wake word is STATED. An open microphone with an invisible gate is a
 *    privacy question the user cannot answer; naming it is the answer.
 */

const PHASE_COPY: Record<Phase, { title: string; hint: string }> = {
  idle:      { title: 'Tap to start', hint: 'Oscar will listen while this is open' },
  listening: { title: 'Listening',    hint: `Say "${wakeWord()}…" then what you need` },
  // The hint here is deliberately vague: it is shown the moment the user falls
  // silent, BEFORE anything is known about the turn. Claiming "checking your tasks
  // and calendar" on every one of those was simply false — it appeared on "what can
  // you do", a turn that called no tool at all. Overridden below when a tool really
  // is running.
  thinking:  { title: 'Working on it', hint: 'One moment' },
  speaking:  { title: 'Speaking',     hint: 'Tap to interrupt' },
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded px-1.5 py-0.5 text-[10px] font-semibold"
         style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}>
      {children}
    </kbd>
  )
}

function wakeWord() {
  return (import.meta.env.VITE_WAKE_WORD as string) ?? 'oscar'
}

export function VoiceOverlay() {
  const v = useVoice()
  const [showSettings, setShowSettings] = useState(false)

  /**
   * What Oscar just talked about, pulled up on the right.
   *
   * Voice tells you "you have one task for today: Verify Oscar task cards at six PM"
   * and then it is gone — spoken words leave nothing to act on. The reply text is
   * already on screen as the caption, and the task list is one existing call
   * (`GET /tasks/{user_id}`), so the cards are a match between the two. Nothing is
   * added to the relay, the agent or the tool bridge.
   */
  const { pool: taskList, patch, reload: reloadTasks } = useSpokenTasks()
  const { toggle, busyId } = useTaskActions(patch, reloadTasks)

  /**
   * 🔴 STICKY, NOT DERIVED — and that is the whole behaviour of this panel.
   *
   * The first version computed the cards from `v.reply` directly. It worked for about
   * a second: as soon as Oscar finished speaking the phase went back to `listening`
   * and the provider cleared the caption, so the panel emptied itself and the cards
   * vanished while the user was still looking at them. A spoken reply is transient by
   * nature; what it was ABOUT should not be.
   *
   * So the last non-empty match is held until it is REPLACED by a later reply that
   * names something, or dismissed, or the call ends. A reply that names nothing —
   * a greeting, a confirmation — leaves what is on screen alone.
   */
  const [pinned, setPinned] = useState<number[]>([])

  // 🔴 IDS FROM THE RELAY, NOT A MATCH ON THE SPOKEN TEXT. Gemini paraphrases every
  // reply — "Prepare the vendor onboarding deck" is spoken as "preparing the vendor
  // onboarding deck" — so matching the transcript against titles found nothing on all
  // four of a test user's tasks. Oscar reports the ids its own tools returned, and an
  // id cannot be conjugated.
  const matched = useMemo(() => v.items.map(i => i.id), [v.items])

  useEffect(() => {
    // Only ever REPLACES a non-empty result. Comparing by joined ids so an identical
    // set does not re-set state on every caption token.
    if (matched.length > 0) {
      setPinned(prev => (prev.join() === matched.join() ? prev : matched))
    }
  }, [matched])

  /**
   * Cleared when a call STARTS, not when one ends.
   *
   * 🔴 Clearing on end looked equivalent and was wrong: tapping Edit ends the call
   * on purpose (the mic must not be open while you type), so clearing there wiped
   * the panel out from under the edit form the user had just opened. Clearing on
   * start gives the same guarantee that matters — a new call never opens showing the
   * last one's tasks — while letting the cards survive the call they came from.
   */
  useEffect(() => { if (v.running) setPinned([]) }, [v.running])

  // Resolved fresh from the list every render, so a card completed in the panel shows
  // its new state instead of the snapshot it was matched with.
  const named = useMemo(
    () => pinned.map(id => taskList.find(t => t.id === id)).filter((t): t is NonNullable<typeof t> => !!t),
    [pinned, taskList])

  // A spoken turn can CREATE the task it then describes, and a pool fetched when the
  // overlay opened cannot contain it. Re-read when Oscar starts speaking.
  useEffect(() => {
    if (v.phase === 'speaking') reloadTasks()
  }, [v.phase, reloadTasks])

  const onOrbTap = useCallback(() => {
    // One control, three meanings in priority order: interrupt a reply, else start
    // a call, else do nothing — the call is live and listening, and a tap should
    // not hang up mid-sentence by accident.
    if (v.speaking) { v.interrupt(); return }
    if (!v.running) v.openVoice()
  }, [v])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return
      if (e.key === 'Escape') v.closeVoice()
      if (e.code === 'Space') { e.preventDefault(); onOrbTap() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [v, onOrbTap])

  const base = PHASE_COPY[v.phase]
  // Only claim to be reading their data when a tool is genuinely running.
  const copy = v.phase === 'thinking' && v.working
    ? { ...base, hint: 'Checking your workspace' }
    : base
  // Space is the in-overlay control: no modifier needed once you are already here,
  // and it is the key your thumb is on. The global Alt+V still works too.
  // Capped, so a loud room cannot inflate the orb off the screen.
  const scale = v.phase === 'listening' ? 1 + Math.min(v.level * 5.5, 0.4) : 1

  return (
    <Portal>
      <div className="fade fixed inset-0 z-[60] flex"
           style={{ background: 'var(--bg)' }}
           role="dialog" aria-modal="true" aria-label="Talk to Oscar">
        {/* The voice screen keeps its own full-height column; the panel is a sibling,
            so adding it cannot shift the orb or the footer. */}
        <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Mic className="size-4" style={{ color: 'var(--accent)' }} /> Voice
            {v.ambient && (
              <span className="ml-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5
                               text-[10px] font-semibold"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                <Radio className="size-2.5" /> Always listening
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setShowSettings(s => !s)} aria-label="Voice settings"
                    className="grid size-9 place-items-center rounded-lg"
                    style={{ color: 'var(--text-muted)' }}>
              <Settings2 className="size-4" />
            </button>
            <button onClick={v.closeVoice}
                    aria-label={v.ambient ? 'Hide (keeps listening)' : 'Close voice'}
                    className="grid size-9 place-items-center rounded-lg"
                    style={{ color: 'var(--text-muted)' }}>
              <X className="size-5" />
            </button>
          </div>
        </header>

        {showSettings && (
          <div className="fade mx-auto w-full max-w-md space-y-2 px-4 pb-2 sm:px-6">
            <label className="flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5"
                   style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}>
              <span className="text-[13px] font-medium">Oscar's voice</span>
              {/* 🔴 VOICE_OPTIONS, never SPEAKERS. This offered the bulbul list on a
                  Gemini build, and toGeminiVoice() maps every unrecognised name to
                  Puck — so all nine choices did the same thing. Settings already
                  guarded this; the overlay was missed when the engine changed. */}
              <select value={validVoice(v.speaker)} disabled={v.running}
                      onChange={e => v.setSpeaker(e.target.value)}
                      className="rounded-lg border px-2 py-1 text-[13px]"
                      style={{ background: 'var(--bg)', borderColor: 'var(--border)',
                               color: 'var(--text)' }}>
                {VOICE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            {v.running && (
              <p className="px-1 text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                End the call to change voice — the speech socket is configured once
                when it connects.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-1 flex-col items-center justify-center gap-7 px-6">
          <button onClick={onOrbTap}
                  aria-label={v.speaking ? 'Interrupt Oscar'
                            : v.running ? 'Listening' : 'Start talking'}
                  className="relative grid size-52 place-items-center rounded-full sm:size-60">
            <span className={cx('absolute inset-0 rounded-full transition-opacity duration-500',
                                v.phase === 'listening' && 'animate-ping',
                                v.phase === 'thinking' && 'breathe',
                                v.phase === 'speaking' && 'animate-pulse',
                                v.phase === 'idle' && 'opacity-0')}
                  style={{
                    background:
                      v.phase === 'thinking' ? 'rgba(245,158,11,.18)'
                      : v.phase === 'speaking' ? 'rgba(34,197,94,.18)'
                      : 'color-mix(in srgb, var(--accent) 18%, transparent)',
                  }} />
            <span style={{
                    transform: `scale(${scale})`,
                    background:
                      v.phase === 'idle' ? 'var(--bg-sunken)'
                      : v.phase === 'thinking' ? 'rgba(245,158,11,.22)'
                      : v.phase === 'speaking' ? 'rgba(34,197,94,.22)'
                      : 'color-mix(in srgb, var(--accent) 22%, transparent)',
                  }}
                  className="grid size-44 place-items-center rounded-full
                             transition-[transform,background-color] duration-100 sm:size-52">
              <Mic className="size-11"
                   style={{ color: v.running ? 'var(--accent)' : 'var(--text-subtle)' }} />
            </span>
          </button>

          <div className="text-center">
            <div className="text-lg font-semibold">{copy.title}</div>
            <div className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>{copy.hint}</div>
          </div>

          {/* Reserved height, so the orb does not jump every time a partial arrives
              and disappears. */}
          <div className="min-h-[4.5rem] w-full max-w-xl text-center">
            {v.partial && (
              <p className="text-[15px] italic" style={{ color: 'var(--text-subtle)' }}>
                {v.partial}
              </p>
            )}
            {!v.partial && v.heard && <p className="text-[15px] font-medium">{v.heard}</p>}
            {v.reply && (
              <p className="mt-2.5 text-[15px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {v.reply}
              </p>
            )}
          </div>

          {v.error && (
            <div className="w-full max-w-md rounded-xl px-4 py-3 text-center text-[13px]"
                 style={{ background: 'rgba(239,68,68,.1)', color: '#DC2626' }}>
              {v.error}
            </div>
          )}
        </div>

        <footer className="px-6 pb-8 pt-2 text-center"
                style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 2rem)' }}>
          {!v.running
            ? <Button variant="primary" onClick={v.openVoice}>Start talking</Button>
            : <Button onClick={v.end}>End call</Button>}
          <p className="mx-auto mt-4 max-w-sm text-[11px] leading-relaxed"
             style={{ color: 'var(--text-subtle)' }}>
            {v.ambient
              ? `Oscar is listening in the background. It only acts on what is
                 addressed to it — start with "${wakeWord()}", or just answer when it
                 asks you something.`
              : `The microphone is open while this is on screen. Start with
                 "${wakeWord()}", or just answer when it asks you something.`}
          </p>
          <p className="mx-auto mt-2 flex flex-wrap items-center justify-center gap-x-3
                        gap-y-1 text-[11px]"
             style={{ color: 'var(--text-subtle)' }}>
            <span><Kbd>Space</Kbd> start or interrupt</span>
            <span><Kbd>Esc</Kbd> close</span>
            {/* One global shortcut shown, not both. VOICE_HOTKEY still works — it is
                registered in hotkeys.ts and unchanged — but a four-chip hint row
                reads as a keyboard reference rather than a nudge, and the
                double-tap is the more memorable of the two. */}
            <span><Kbd>{VOICE_TAP_LABEL}</Kbd> from anywhere</span>
          </p>
        </footer>
        </div>

        {/* ── what Oscar just mentioned, on the right ─────────────────── */}
        <VoicePanel tasks={named} onToggle={tk => void toggle(tk)}
                    busyId={busyId} onChanged={reloadTasks}
                    onDismiss={() => setPinned([])}
                    onEditStart={v.end} />
      </div>
    </Portal>
  )
}
