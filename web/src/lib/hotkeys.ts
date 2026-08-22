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
 * Talk to Oscar from anywhere: hold V, tap SPACE.
 *
 * Two plain keys, identical on macOS and Windows — no ⌥-versus-Alt to relabel, and
 * neither key is claimed by a browser or an OS.
 *
 * 🔴 THE ORDER IS THE WHOLE DESIGN. Space-then-V was tried first and is wrong,
 * for two reasons:
 *
 *  1. Space scrolls the page. Survivable — the position can be restored.
 *  2. **Space activates the focused element.** After any click, focus stays on that
 *     control, so the chord would first re-click it — "Mark complete", "Send",
 *     "Cancel task". A shortcut that can fire a destructive action is not a
 *     shortcut. And it cannot be suppressed: preventDefault on Space is exactly how
 *     keyboard users activate buttons, so blocking it breaks accessibility.
 *
 * Flipping it removes both. Holding a letter outside a text field does nothing
 * whatsoever, and Space is now the SECOND key — so it can be preventDefault'd
 * safely, because that only happens while V is already held. Space on its own still
 * scrolls and still activates buttons, completely untouched.
 */
export const VOICE_CHORD = { hold: 'KeyV', key: 'Space' } as const
export const VOICE_CHORD_LABEL = 'V + Space'

/** The modifier alternative, for anyone who prefers one.
 *
 *  ⌘⇧Space / Ctrl+Shift+Space — mnemonic "press to talk", and free on both
 *  platforms. Alt+V was the first choice and was dropped: on Windows, Firefox binds
 *  Alt+V to the View menu, so it would have silently done nothing there. */
export const VOICE_HOTKEY: Combo = { mod: true, shift: true, key: 'Space' }
export const VOICE_HOTKEY_LABEL = comboLabel(VOICE_HOTKEY)

/**
 * Hold one key, press another.
 *
 * Deliberately NOT symmetric: `hold` must already be down when `key` arrives.
 * Accepting either order would make a fast "v" then "space" while typing a
 * sentence — which is a real sequence in ordinary prose — fire the shortcut.
 */
export function useChord(
  /** `hold` and `key` are both KeyboardEvent.code values ('KeyV', 'Space'). Code
   *  rather than key, because with a modifier down macOS reports the alternate
   *  character and layouts differ. */
  chord: { hold: string; key: string },
  handler: () => void,
  enabled = true,
) {
  const fn = useRef(handler)
  useEffect(() => { fn.current = handler }, [handler])

  useEffect(() => {
    if (!enabled) return
    let holding = false

    const onDown = (e: KeyboardEvent) => {
      // Never in a text field: Space and V are both ordinary typing there, and
      // firing would eat the keystroke AND open the microphone mid-sentence.
      if (isEditing(e.target)) return

      if (e.code === chord.hold) {
        // Held, not consumed: a bare letter keypress outside a text field has no
        // default behaviour to suppress.
        holding = true
        return
      }
      if (!holding) return
      if (e.code !== chord.key) return
      // A modifier held alongside means the user meant something else.
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Safe to suppress: this only runs while the hold key is already down, so
      // Space pressed on its own keeps scrolling and keeps activating buttons.
      e.preventDefault()
      fn.current()
    }

    const onUp = (e: KeyboardEvent) => {
      if (e.code === chord.hold) holding = false
    }
    // A lost keyup — tab switch, window blur — would leave `holding` stuck true,
    // and then a bare "v" would open the microphone.
    const clear = () => { holding = false }

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
  }, [chord.hold, chord.key, enabled])
}
