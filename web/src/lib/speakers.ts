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
