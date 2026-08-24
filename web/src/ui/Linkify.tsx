import type { ReactNode } from 'react'

/**
 * Renders text with any URLs in it as real links.
 *
 * There is no link FIELD anywhere in this schema — `pa_items` has title,
 * description and location and nothing else — so a Meet or Zoom link lives inside
 * the notes or the location as plain text. Until now it rendered as dead text: you
 * had to select it and copy it by hand to join a call you were already looking at.
 *
 * 🔴 `rel="noopener noreferrer"` IS NOT OPTIONAL WITH target="_blank".
 * Without `noopener` the page that opens gets a live `window.opener` handle and can
 * navigate this tab somewhere else — the classic tabnabbing move, and it matters
 * more here than usual because these URLs are pasted in by other people: a teammate's
 * comment or a meeting note is untrusted input. `noreferrer` additionally stops the
 * app's URL leaking in the Referer header.
 *
 * Deliberately NOT a markdown renderer. Oscar's replies and users' notes are plain
 * text, and parsing them as markdown would silently swallow asterisks and
 * underscores that people typed for emphasis.
 */

/**
 * Matched conservatively, and the trailing-punctuation trim is the whole subtlety.
 * A URL at the end of a sentence — "the deck is at https://x.com/a." — must not
 * swallow the full stop, and one inside brackets must not swallow the bracket, or
 * the link 404s and the text looks mangled. Closing brackets are only kept when the
 * URL opened one, which is what makes wiki-style links with parentheses work.
 */
const URL_RE = /\bhttps?:\/\/[^\s<>"']+/gi

function trimTrailing(url: string): { href: string; tail: string } {
  let end = url.length
  for (;;) {
    const ch = url[end - 1]
    if (!ch) break
    if ('.,;:!?'.includes(ch)) { end--; continue }
    if (ch === ')' && (url.slice(0, end).match(/\(/g)?.length ?? 0)
                    < (url.slice(0, end).match(/\)/g)?.length ?? 0)) { end--; continue }
    if (ch === ']' || ch === '}' || ch === '"' || ch === "'") { end--; continue }
    break
  }
  return { href: url.slice(0, end), tail: url.slice(end) }
}

export function Linkify({ text }: { text: string | null | undefined }) {
  if (!text) return null
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const { href, tail } = trimTrailing(m[0])
    out.push(
      <a key={`${m.index}-${href}`} href={href} target="_blank" rel="noopener noreferrer"
         // stopPropagation because these sit inside cards and rows that are
         // themselves clickable — opening a link must not also open the task.
         onClick={e => e.stopPropagation()}
         className="underline decoration-1 underline-offset-2 hover:opacity-80"
         style={{ color: 'var(--accent)' }}>
        {href}
      </a>,
    )
    if (tail) out.push(tail)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return <>{out}</>
}
