import { useEffect, useRef } from 'react'

/**
 * Global keyboard shortcuts.
 *
 * 🔴 The whole difficulty is knowing when NOT to fire. This app has a chat
 * composer, a comment box, a message input and several text fields; a shortcut that
 * triggers while someone is typing eats their keystroke and — for voice — opens the
 * microphone mid-sentence. So every handler is suppressed inside an editable field,
 * and that check has to include contenteditable, not just INPUT and TEXTAREA.
 *
 * Modifier choice is also not free. Browsers and both desktop OSes have claimed
 * most of the obvious combinations:
 *
 *   ⌘K / Ctrl+K   Chrome — search from the address bar
 *   ⌘⇧O          Chrome — bookmark manager
 *   Ctrl+J        Chrome — downloads
 *   ⌘Space        macOS  — Spotlight
 *   Alt+Space     Windows — window menu
 *   Ctrl+Space    macOS  — switch input source (common for multilingual users)
 *
 * A page cannot reliably override any of those, and a shortcut that works on one
 * machine and silently does nothing on another is worse than none. `Alt`+letter is
 * claimed by neither browser nor OS on macOS or Windows, so that is what this uses.
 */

export type Combo = { alt?: boolean; meta?: boolean; ctrl?: boolean; shift?: boolean; key: string }

/** True when the keystroke belongs to whatever the user is typing into. */
function isEditing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el) return false
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true
  // A rich-text surface is editable without being an <input>. Missing this is how a
  // shortcut ends up swallowing a character mid-word.
  return el.isContentEditable === true
}

export function useHotkey(combo: Combo, handler: () => void, enabled = true) {
  // Held in a ref so an inline arrow does not re-bind the listener every render —
  // rebinding drops any keystroke landing in the gap.
  const fn = useRef(handler)
  useEffect(() => { fn.current = handler }, [handler])

  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (isEditing(e.target)) return
      // Compared case-insensitively: with Alt held, macOS reports the ALTERNATE
      // character for e.key ("√" for Alt+V), so matching on e.key would never fire.
      // e.code is the physical key and is stable across layouts and modifiers.
      if (e.code.toLowerCase() !== `key${combo.key}`.toLowerCase()) return
      if (!!combo.alt !== e.altKey) return
      if (!!combo.meta !== e.metaKey) return
      if (!!combo.ctrl !== e.ctrlKey) return
      if (!!combo.shift !== e.shiftKey) return
      e.preventDefault()
      fn.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [combo.alt, combo.meta, combo.ctrl, combo.shift, combo.key, enabled])
}

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false
  // userAgentData is the non-deprecated source; navigator.platform still works
  // everywhere and is the fallback. userAgent last, because it is the least
  // reliable of the three.
  const uaPlatform =
    (navigator as unknown as { userAgentData?: { platform?: string } })
      .userAgentData?.platform
  return /mac/i.test(uaPlatform || navigator.platform || navigator.userAgent)
}

const IS_MAC = detectMac()

/** How to WRITE the combo for a human. "⌥V" on a Mac, "Alt+V" elsewhere — showing
 *  the wrong one makes a real shortcut look like it does not exist. */
export function comboLabel(c: Combo): string {
  const parts: string[] = []
  if (c.ctrl) parts.push(IS_MAC ? '⌃' : 'Ctrl')
  if (c.alt) parts.push(IS_MAC ? '⌥' : 'Alt')
  if (c.shift) parts.push(IS_MAC ? '⇧' : 'Shift')
  if (c.meta) parts.push(IS_MAC ? '⌘' : 'Win')
  parts.push(c.key.toUpperCase())
  return IS_MAC ? parts.join('') : parts.join('+')
}

/** Talk to Oscar from anywhere. `V` for voice; Alt is unclaimed on both platforms. */
export const VOICE_HOTKEY: Combo = { alt: true, key: 'v' }
export const VOICE_HOTKEY_LABEL = comboLabel(VOICE_HOTKEY)
