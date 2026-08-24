/**
 * bulbul:v3 speaker names, VERIFIED against the live API — every name here returned
 * audio.
 *
 * 🔴 Seven v2 names (karun, hitesh, abhilash, anushka, manisha, vidya, arya) were
 * removed because they did not fail loudly: the TTS config frame was rejected and
 * the turn produced SILENCE, which is indistinguishable from a broken microphone, a
 * dead socket or a hung backend. A picker must never offer a choice that quietly
 * does nothing. Re-verify this list when the model version changes — the names are
 * not stable across bulbul versions, which is exactly how the dead ones got in.
 *
 * Its own module so Settings can render the picker without importing the voice
 * engine, which would pull ~1,000 lines of audio code into a chunk that never
 * touches a microphone.
 */
export const SPEAKERS = [
  'dev', 'shubh', 'rahul', 'amit', 'varun',      // male
  'priya', 'neha', 'kavya', 'shreya',            // female
] as const

/** 🔴 Sarvam-only, and NOT the app default. Kept as its own export so the name
 *  cannot be mistaken for engine-agnostic — see DEFAULT_VOICE below. */
export const DEFAULT_SARVAM_SPEAKER =
  (import.meta.env.VITE_SARVAM_SPEAKER as string | undefined) ?? 'dev'

/** Kept under the old name because `liveVoice.ts` — the shipping Sarvam engine — imports
 *  it, and that file is deliberately untouched. It is the correct default THERE; the
 *  bug was the app as a whole using it regardless of which engine was compiled in. */
export const DEFAULT_SPEAKER = DEFAULT_SARVAM_SPEAKER


/**
 * Gemini Live voice names. 30 HD voices exist; these are the eight the relay
 * accepts — it allowlists them because an unknown `voiceName` is rejected during
 * setup and the session then produces SILENCE, the same quiet failure the removed
 * bulbul v2 names caused above.
 */
export const GEMINI_VOICES = [
  'Puck', 'Charon', 'Kore', 'Fenrir', 'Aoede', 'Leda', 'Orus', 'Zephyr',
] as const

/** Which engine is compiled in. Build-time: Vite inlines this and tree-shakes the
 *  loser, so it cannot change at runtime. */
export const VOICE_ENGINE =
  (import.meta.env.VITE_VOICE_ENGINE as string) === 'sarvam' ? 'sarvam' : 'gemini'

/**
 * 🔴 The picker MUST follow the engine. With Gemini compiled in, the Sarvam list
 * was still being offered — and `toGeminiVoice()` maps every unrecognised name to
 * Puck, so all nine options did exactly the same thing. A control that appears to
 * change something and does not is worse than no control.
 */
export const VOICE_OPTIONS: readonly string[] =
  VOICE_ENGINE === 'sarvam' ? SPEAKERS : GEMINI_VOICES

/** Describes the voices, never the vendor. Which speech provider is in use is an
 *  implementation detail a user cannot act on, and naming it in Settings meant the
 *  copy had to be re-edited every time the engine changed — and was wrong in
 *  between. */
/**
 * The starting selection, FOR THE COMPILED ENGINE.
 *
 * 🔴 This used to be the Sarvam default unconditionally, so a Gemini build opened
 * with "dev" selected — a bulbul speaker name Gemini has never heard of. It still
 * produced audio, because toGeminiVoice() maps anything unrecognised to Puck, which
 * is exactly what made it hard to notice: the voice worked while the control
 * reported a voice that was not being used.
 *
 * Validated against the live list rather than trusted, so a stale VITE_GEMINI_VOICE
 * or a value left in localStorage by an earlier build cannot reintroduce it.
 */
export const DEFAULT_VOICE: string = (() => {
  const wanted = VOICE_ENGINE === 'sarvam'
    ? DEFAULT_SARVAM_SPEAKER
    : ((import.meta.env.VITE_GEMINI_VOICE as string | undefined) ?? 'Puck')
  return VOICE_OPTIONS.includes(wanted) ? wanted : VOICE_OPTIONS[0]
})()

/** Coerces any stored value onto the current engine's list. localStorage survives a
 *  rebuild, so a name saved while the other engine was compiled in would otherwise
 *  sit in the picker forever. */
export function validVoice(v: string | null | undefined): string {
  return v && VOICE_OPTIONS.includes(v) ? v : DEFAULT_VOICE
}

export const VOICE_HINT = VOICE_ENGINE === 'sarvam'
  ? 'The first five are male voices, the rest female.'
  : 'Puck and Fenrir are warmer; Kore and Charon are flatter.'
