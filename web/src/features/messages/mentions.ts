/**
 * @mentions for group chat — the parsing half, kept out of the component.
 *
 * The backend has always accepted `mentions: number[]` and `mention_all: boolean`
 * on `POST /teams/{id}/messages`, and gives a mentioned member a distinct
 * "X mentioned you" push instead of the normal group one. This client never sent
 * either field, so every `@` was plain text that tagged nobody — the feature
 * existed on one side only.
 *
 * Names are resolved to IDS AT SEND TIME by matching the text, rather than by
 * tracking offsets as the user types. Offsets look tidier and are wrong the moment
 * someone edits earlier in the line: every stored index shifts and the message
 * tags the wrong person. Matching the final text cannot drift from what was sent.
 */

import type { TeamMember } from '../../lib/types'

/** `@everyone` / `@all` / `@team` — the whole-channel forms. Matched separately
 *  because the backend has its own flag for it, and expanding it into every member
 *  id would lose that distinction and send N individual mention pushes. */
const ALL_TOKENS = ['everyone', 'all', 'team', 'channel']

/** The token being typed right after an `@`, or null.
 *
 *  Only ever looks at the text BEFORE the caret, so typing `@sri` in the middle of
 *  a sentence opens the picker without the rest of the line joining the query.
 *  A space closes it: `"@sri "` is a finished mention, not a search. */
export function activeQuery(text: string, caret: number): string | null {
  const upto = text.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at < 0) return null
  // Must start a word — `email@work` is an address, not a mention.
  if (at > 0 && !/\s/.test(upto[at - 1])) return null
  const q = upto.slice(at + 1)
  if (/\s/.test(q)) return null
  return q
}

/** Replace the token under the caret with a completed `@Name `.
 *  Returns the new text and where the caret should land. */
export function applyPick(text: string, caret: number, name: string): {
  text: string; caret: number
} {
  const upto = text.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at < 0) return { text, caret }
  // A trailing space is deliberate: it closes the token, so `activeQuery` stops
  // matching and the picker does not immediately reopen on the name just chosen.
  const inserted = `@${name} `
  const next = text.slice(0, at) + inserted + text.slice(caret)
  return { text: next, caret: at + inserted.length }
}

export function matches(members: TeamMember[], query: string, meId: number): TeamMember[] {
  const q = query.toLowerCase()
  return members
    // Mentioning yourself is never useful and it would push your own phone.
    .filter(m => m.user_id !== meId && m.is_active)
    .filter(m => !q || m.name.toLowerCase().includes(q))
    .slice(0, 6)      // a picker taller than the composer is worse than scrolling
}

/**
 * Resolve the final text into ids to send.
 *
 * 🔴 LONGEST NAME FIRST. With members "Sri" and "Sriram", checking short-first
 * makes `@Sriram` match "Sri", tag the wrong person, and leave "ram" looking like
 * stray text. This project already has a wrong-recipient incident from loose name
 * matching, so the ordering is the whole correctness of this function.
 */
export function resolve(text: string, members: TeamMember[], meId: number): {
  mentions: number[]; mention_all: boolean
} {
  const lower = text.toLowerCase()
  const mention_all = ALL_TOKENS.some(t => lower.includes(`@${t}`))
  const ids = new Set<number>()
  const byLongest = [...members]
    .filter(m => m.user_id !== meId && m.is_active)
    .sort((a, b) => b.name.length - a.name.length)
  for (const m of byLongest) {
    // Word-boundary-ish: the char after the name must not be a letter, or `@Sri`
    // would match inside `@Sriram` even with longest-first ordering.
    const i = lower.indexOf(`@${m.name.toLowerCase()}`)
    if (i < 0) continue
    const after = text[i + 1 + m.name.length]
    if (after && /[a-z0-9]/i.test(after)) continue
    ids.add(m.user_id)
  }
  // `mention_all` already covers everyone, so individual ids alongside it would
  // send some members two pushes for one message.
  return { mentions: mention_all ? [] : [...ids], mention_all }
}
