import { Radio } from 'lucide-react'
import { useVoice } from './VoiceProvider'
import { cx } from '../../ui'

/**
 * A persistent, always-visible marker that the microphone is live.
 *
 * NOT optional and not decoration. Ambient mode holds the microphone with no
 * overlay on screen, and a page that is listening without saying so is a page
 * nobody should trust — the browser's own recording dot is easy to miss and does not
 * say WHICH tab. Tapping it opens the conversation.
 *
 * It also carries the autoplay warning. A wake can be heard by us and produce no
 * sound for the user: the browser blocks audio until the page has been interacted
 * with, so on a fresh load Oscar answers into a muted speaker. One click fixes it,
 * and the user has to be told that.
 */
export function AmbientIndicator() {
  const v = useVoice()
  if (!v.ambient || v.overlayOpen) return null

  const label =
    v.needsGesture ? 'Click to let Oscar speak'
    : v.phase === 'thinking' ? 'Working on it…'
    : v.phase === 'speaking' ? 'Speaking'
    : v.running ? 'Listening'
    : 'Voice paused'

  return (
    <button
      onClick={v.openVoice}
      className={cx('fixed bottom-[74px] left-4 z-30 flex items-center gap-2 rounded-full',
                    'border px-3 py-2 text-[12px] font-medium shadow-sm lg:bottom-4')}
      style={{
        background: 'var(--bg-elevated)',
        borderColor: v.needsGesture ? '#F59E0B' : 'var(--border)',
        color: v.needsGesture ? '#B45309' : 'var(--text-muted)',
        marginBottom: 'env(safe-area-inset-bottom)',
      }}
      title="Oscar is listening in the background"
    >
      <span className="relative grid size-4 place-items-center">
        <Radio className="size-3.5"
               style={{ color: v.running ? 'var(--accent)' : 'var(--text-subtle)' }} />
        {v.running && !v.needsGesture && (
          <span className="absolute inset-0 animate-ping rounded-full"
                style={{ background: 'color-mix(in srgb, var(--accent) 35%, transparent)' }} />
        )}
      </span>
      {label}
      {/* The live level, so "listening" is visibly true rather than a claim. */}
      {v.phase === 'listening' && (
        <span className="h-3 w-px overflow-hidden rounded-full"
              style={{ background: 'var(--border-strong)' }}>
          <span className="block w-px rounded-full"
                style={{
                  height: `${Math.min(100, v.level * 700)}%`,
                  background: 'var(--accent)',
                }} />
        </span>
      )}
    </button>
  )
}
