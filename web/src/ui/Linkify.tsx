import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, Copy, ExternalLink } from 'lucide-react'

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
  /** The open menu: which URL, and where the click landed. */
  const [menu, setMenu] = useState<{ href: string; x: number; y: number } | null>(null)

  if (!text) return null
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const { href, tail } = trimTrailing(m[0])
    out.push(
      /**
       * 🔴 STILL A REAL `<a href>` WITH `target="_blank"`, even though the click is
       * intercepted. The element type is what gives you middle-click, ⌘-click, the
       * browser's own "Open in new tab", the status bar preview on hover, and a
       * copyable target for assistive tech. A `<span onClick>` would look identical
       * and quietly take all of that away.
       */
      <a key={`${m.index}-${href}`} href={href} target="_blank" rel="noopener noreferrer"
         onClick={e => {
           // stopPropagation because these sit inside cards and rows that are
           // themselves clickable — acting on a link must not also open the task.
           e.stopPropagation()
           // Let the BROWSER handle its own gestures. ⌘/ctrl-click, shift-click and
           // middle-click already mean "open it, elsewhere" — showing a menu asking
           // what they meant would be second-guessing an explicit instruction.
           if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
           e.preventDefault()
           setMenu({ href, x: e.clientX, y: e.clientY })
         }}
         /**
          * 🔴 INHERITS its colour — it must NOT hardcode --accent.
          *
          * Your own chat and comment bubbles are painted `background: var(--accent)`
          * with `color: #fff`. A link forcing `color: var(--accent)` inside one is
          * therefore indigo text on an indigo ground: present, selectable,
          * clickable, and completely invisible. A URL-only comment rendered as a
          * blank purple bar.
          *
          * `currentColor` is what makes this correct in BOTH places at once —
          * white on an accent bubble, accent-coloured on the page's own
          * background, with no per-caller prop to pass and forget. The underline
          * is what marks it as a link, and that is now doing real work rather
          * than decorating a colour difference.
          */
         className="underline decoration-1 underline-offset-2 hover:opacity-80"
         style={{ color: 'currentColor' }}>
        {href}
      </a>,
    )
    if (tail) out.push(tail)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return (
    <>
      {out}
      {menu && <LinkMenu {...menu} onClose={() => setMenu(null)} />}
    </>
  )
}

/**
 * Open-or-copy, at the point of the click.
 *
 * These URLs come from other people — a teammate's comment, a meeting note, one of
 * Oscar's replies — and the two things you actually want are almost evenly split:
 * join the call now, or paste the link somewhere else. A bare link forced the first
 * and made the second a select-and-drag exercise inside a bubble that is itself a
 * click target.
 *
 * `createPortal` to `document.body` rather than the shared `Portal` helper: that one
 * locks body scroll for full-screen sheets, which is wrong for a two-item popover.
 * A portal is still needed — chat bubbles and cards clip their overflow, so an
 * absolutely-positioned menu would be cut off inside them.
 */
function LinkMenu({ href, x, y, onClose }: {
  href: string; x: number; y: number; onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    /**
     * 🔴 THE MENU IS EXCLUDED BY CONTAINMENT, NOT BY stopPropagation — and getting
     * that wrong is what made both buttons dead on the first version.
     *
     * This listener is `capture` on WINDOW, deliberately, so a click anywhere else
     * dismisses the menu before that element's own handler runs (otherwise
     * dismissing could also open the task behind it). But React attaches its
     * synthetic handlers at the ROOT CONTAINER, which is a descendant of window —
     * so a capture listener here fires FIRST, and the menu's own
     * `onPointerDown={e => e.stopPropagation()}` never gets the chance to run.
     * Result: pointerdown closed the menu, it unmounted, and the click event that
     * would have followed had nothing left to land on. The menu appeared, and
     * nothing you pressed did anything.
     *
     * A ref containment check runs in the same phase as the listener, so it cannot
     * lose that race.
     */
    const onDown = (e: Event) => {
      if (box.current?.contains(e.target as Node)) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown, true)
    // A menu pinned to viewport coordinates is in the wrong place the moment
    // anything scrolls, so it closes rather than drifting. Unconditional — unlike
    // the pointer case there is nothing inside the menu worth scrolling.
    const onGone = () => onClose()
    window.addEventListener('scroll', onGone, true)
    window.addEventListener('resize', onGone)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('scroll', onGone, true)
      window.removeEventListener('resize', onGone)
    }
  }, [onClose])

  const open = () => {
    // noopener is not optional with _blank: without it the new page gets a live
    // handle on this tab and can navigate it away — and these URLs are pasted in by
    // other people, so they are untrusted input.
    window.open(href, '_blank', 'noopener,noreferrer')
    onClose()
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href)
    } catch {
      // navigator.clipboard needs a secure context. localhost and https qualify, a
      // plain-http origin does not — so there is a fallback rather than a silent
      // no-op, because "I clicked Copy and nothing happened" is the worst outcome.
      const ta = document.createElement('textarea')
      ta.value = href
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* nothing left to try */ }
      document.body.removeChild(ta)
    }
    setCopied(true)
    // Confirmation stays visible briefly, THEN closes — a menu that vanishes the
    // instant you click gives no evidence the copy happened.
    setTimeout(onClose, 650)
  }

  // Clamped to the viewport so a link near the right or bottom edge does not open a
  // menu half off-screen. The numbers are the menu's own approximate size.
  const left = Math.min(x, Math.max(8, window.innerWidth - 268))
  const top = Math.min(y + 8, Math.max(8, window.innerHeight - 116))

  return createPortal(
    <div ref={box} role="menu" aria-label="Link actions"
         className="fade fixed z-[95] w-[252px] overflow-hidden rounded-xl border shadow-xl"
         style={{ left, top, background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
         // Still stopped, so a click that DOES land here cannot bubble on to the card
         // or row underneath. The containment check above is what keeps the menu
         // alive long enough for that to happen.
         onClick={e => e.stopPropagation()}>
      {/* The URL itself, because a menu that does not say WHICH link it is about is
          guesswork when a message contains two of them. */}
      <div className="truncate border-b px-3 py-2 text-[11.5px]"
           style={{ borderColor: 'var(--border)', color: 'var(--text-subtle)' }}
           title={href}>
        {href}
      </div>
      <button role="menuitem" onClick={open}
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px]
                         hover:bg-black/5 dark:hover:bg-white/10">
        <ExternalLink className="size-4" style={{ color: 'var(--text-subtle)' }} />
        Open in new tab
      </button>
      <button role="menuitem" onClick={() => void copy()}
              className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px]
                         hover:bg-black/5 dark:hover:bg-white/10">
        {copied
          ? <Check className="size-4" style={{ color: '#15803D' }} />
          : <Copy className="size-4" style={{ color: 'var(--text-subtle)' }} />}
        {copied ? 'Copied' : 'Copy link'}
      </button>
    </div>,
    document.body,
  )
}
