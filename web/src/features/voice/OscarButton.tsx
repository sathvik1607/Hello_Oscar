import { Mic } from 'lucide-react'
import { useVoice } from './VoiceProvider'
import { cx } from '../../ui'

/**
 * The way into voice. Prominent, and deliberately not a novelty: no pulsing, no
 * gradient sweep, no "AI" sparkle. It is the primary action on the page and looks
 * like a button that does something.
 */
export function OscarButton({ floating }: { floating?: boolean }) {
  const { openVoice } = useVoice()

  if (floating) {
    return (
      <button
        onClick={openVoice}
        aria-label="Talk to Oscar"
        className="grid size-14 place-items-center rounded-full text-white shadow-lg
                   transition active:scale-95"
        style={{ background: 'linear-gradient(135deg,#8B7CFF,#6D5EF6)' }}
      >
        <Mic className="size-6" />
      </button>
    )
  }

  return (
    <button
      onClick={openVoice}
      className={cx('inline-flex h-10 items-center gap-2 rounded-full px-4',
                    'text-sm font-semibold text-white shadow-sm transition',
                    'hover:brightness-105 active:scale-[.98]')}
      style={{ background: 'linear-gradient(135deg,#8B7CFF,#6D5EF6)' }}
    >
      <Mic className="size-4" />
      Talk to Oscar
    </button>
  )
}
