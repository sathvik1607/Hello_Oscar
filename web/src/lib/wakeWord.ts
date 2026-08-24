/**
 * The wake word — shared by BOTH voice engines.
 *
 * Extracted from `liveVoice.ts` when `geminiVoice.ts` needed it. A value import
 * across engines would have bundled the whole ~1,000-line Sarvam engine into the
 * Gemini chunk, and copy-pasting it would have forked logic that already cost real
 * debugging to get right — `"send hello oscar poster to sriram"` passed a naive
 * substring test and was answered as a greeting.
 *
 * Moved VERBATIM. No behaviour change to either engine.
 */

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
export const WAKE_WORD = ((import.meta.env.VITE_WAKE_WORD as string) ?? 'oscar').toLowerCase()

const WAKE_VARIANTS = [WAKE_WORD, 'oskar', 'osker', 'ascar', 'askar', 'auscar', 'ossca']

/** Words allowed BEFORE the name while still counting as addressing it. Anything else
 *  in front means the name is being used as a noun, not as a summons. */
const WAKE_FILLER = ['hey', 'hi', 'hello', 'ok', 'okay', 'yo', 'um', 'uh', 'so', 'excuse', 'me']

export function wakeStrip(text: string): string | null {
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
