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

export type Combo = {
  /**
   * The platform's PRIMARY modifier: ⌘ on macOS, Ctrl everywhere else.
   *
   * 🔴 Use this rather than `meta`. `meta: true` matches metaKey literally, which
   * on Windows is the WINDOWS key — so a combo written as meta+shift+Space rendered
   * as "Shift+Win+Space" and would never have fired, because nothing sends the
   * Windows key to a page. This is the standard "mod" idea and it is the only
   * correct way to express "the Cmd/Ctrl one".
   */
  mod?: boolean
  alt?: boolean
  meta?: boolean
  ctrl?: boolean
  shift?: boolean
  key: string
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
      const want = combo.key === 'Space' ? 'Space' : `Key${combo.key}`
      if (e.code.toLowerCase() !== want.toLowerCase()) return
      // `mod` resolves to the platform's primary modifier; the others are literal.
      const wantMeta = !!combo.meta || (!!combo.mod && IS_MAC)
      const wantCtrl = !!combo.ctrl || (!!combo.mod && !IS_MAC)
      if (!!combo.alt !== e.altKey) return
      if (wantMeta !== e.metaKey) return
      if (wantCtrl !== e.ctrlKey) return
      if (!!combo.shift !== e.shiftKey) return
      e.preventDefault()
      fn.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [combo.mod, combo.alt, combo.meta, combo.ctrl, combo.shift, combo.key, enabled])
}


/** How to WRITE the combo for a human. "⌥V" on a Mac, "Alt+V" elsewhere — showing
 *  the wrong one makes a real shortcut look like it does not exist. */
export function comboLabel(c: Combo): string {
  const parts: string[] = []
  // Order follows each platform's own convention for writing a combo.
  if (c.mod && !IS_MAC) parts.push('Ctrl')
  if (c.ctrl) parts.push(IS_MAC ? '⌃' : 'Ctrl')
  if (c.alt) parts.push(IS_MAC ? '⌥' : 'Alt')
  if (c.shift) parts.push(IS_MAC ? '⇧' : 'Shift')
  if (c.mod && IS_MAC) parts.push('⌘')
  if (c.meta) parts.push('⌘')
  parts.push(c.key === 'Space' ? 'Space' : c.key.toUpperCase())
  return IS_MAC ? parts.join('') : parts.join('+')
}

/**
 * Talk to Oscar from anywhere: tap SHIFT twice.
 *
 * 🔴 THE REASON THIS IS THE RIGHT ONE: Shift on its own has NO default behaviour
 * to intercept. Not in any browser, not on any OS. Every other candidate borrows a
 * key that already does something and then has to fight it:
 *
 *   Space          scrolls the page AND activates the focused control — so a chord
 *                  starting with it can re-fire "Mark complete" or "Cancel task"
 *   /              Firefox Quick Find
 *   ⌘K / Ctrl+K    Chrome — search from the address bar
 *   ⌘⇧O           Chrome — bookmark manager
 *   Ctrl+J         Chrome — downloads
 *   ⌘Space         macOS — Spotlight
 *   Alt+Space      Windows — window menu
 *   Ctrl+Space     macOS — switch input source
 *   Alt+V          Firefox on Windows — View menu
 *
 * It is also the same on every platform, so there is no ⌥-versus-Alt to relabel and
 * no modifier that means a different physical key somewhere else. And a double tap
 * cannot happen by accident the way a single bare letter can, which matters when
 * the action is "open the microphone".
 *
 * Precedent: JetBrains IDEs use Shift-Shift for Search Everywhere.
 */
export const VOICE_TAP = 'ShiftLeft'
export const VOICE_TAP_LABEL = 'Shift Shift'

/** The explicit alternative, for anyone who prefers a held combo.
 *  ⇧⌘Space / Ctrl+Shift+Space — mnemonic "press to talk", free on both platforms. */
export const VOICE_HOTKEY: Combo = { mod: true, shift: true, key: 'Space' }
export const VOICE_HOTKEY_LABEL = comboLabel(VOICE_HOTKEY)

/**
 * Tap a modifier twice.
 *
 * Stricter than "two keydowns close together", because that would fire constantly
 * during ordinary typing. A tap counts only when the key goes down and back up with
 * NO other key pressed in between — so holding Shift to type a capital, or
 * Shift+Tab, or any Shift combination, is not a tap. Two clean taps inside the
 * window fire; anything else resets the count.
 */
export function useDoubleTap(
  code: string,
  handler: () => void,
  { windowMs = 400, enabled = true }: { windowMs?: number; enabled?: boolean } = {},
) {
  const fn = useRef(handler)
  useEffect(() => { fn.current = handler }, [handler])

  useEffect(() => {
    if (!enabled) return
    let lastTapAt = 0
    /** True while the key is down and nothing else has been pressed since. */
    let clean = false

    const onDown = (e: KeyboardEvent) => {
      // Auto-repeat from a held key is not a tap.
      if (e.repeat) return
      if (e.code === code || e.code === code.replace('Left', 'Right')) {
        clean = true
        return
      }
      // Any other key while the modifier is down makes it a COMBINATION, not a tap
      // — and also cancels a half-finished double tap.
      clean = false
      lastTapAt = 0
    }

    const onUp = (e: KeyboardEvent) => {
      if (e.code !== code && e.code !== code.replace('Left', 'Right')) return
      if (!clean) { lastTapAt = 0; return }
      clean = false

      // Guarded on release rather than on press: the target is where focus is, and
      // a shortcut must never fire while someone is typing.
      if (isEditing(e.target)) { lastTapAt = 0; return }

      const now = e.timeStamp
      if (lastTapAt && now - lastTapAt <= windowMs) {
        lastTapAt = 0
        fn.current()
      } else {
        lastTapAt = now
      }
    }

    const clear = () => { clean = false; lastTapAt = 0 }

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', clear)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', clear)
      document.removeEventListener('visibilitychange', clear)
    }
  }, [code, windowMs, enabled])
}

