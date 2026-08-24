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

export const DEFAULT_SPEAKER =
  (import.meta.env.VITE_SARVAM_SPEAKER as string | undefined) ?? 'dev'


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
/** 🔴 SARVAM IS THE DEFAULT, so Gemini is OPT-IN via VITE_VOICE_ENGINE=gemini.
 *  Sarvam is the path that has been in production for months; Gemini is faster and
 *  measurably better on latency, but it persists only a lossy transcript and the
 *  fabrication work on it is unfinished. Defaulting to the proven one means a
 *  deployment cannot switch voice engines by accident. */
export const VOICE_ENGINE =
  (import.meta.env.VITE_VOICE_ENGINE as string) === 'gemini' ? 'gemini' : 'sarvam'

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
export const VOICE_HINT = VOICE_ENGINE === 'sarvam'
  ? 'The first five are male voices, the rest female.'
  : 'Puck and Fenrir are warmer; Kore and Charon are flatter.'
