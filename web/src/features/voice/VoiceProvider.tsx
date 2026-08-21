import {
  createContext, lazy, Suspense, useCallback, useContext, useMemo, useState,
} from 'react'

/** Lazy: the overlay pulls in the ~1,000-line voice engine, and most sessions never
 *  open the microphone. Loading it on the first tap costs one small chunk fetch at a
 *  moment the user is already waiting for a permission prompt. */
const VoiceOverlay = lazy(() => import('./VoiceOverlay')
  .then(m => ({ default: m.VoiceOverlay })))

/**
 * Whether the voice overlay is open, held above every screen.
 *
 * A context rather than local state because Oscar is reachable from the header, the
 * floating mobile button, the Today screen's empty state and a keyboard shortcut —
 * four places that must open ONE overlay. Two overlays would mean two LiveVoice
 * engines, two microphone streams and two STT sockets billing in parallel.
 */
type Ctx = { open: boolean; openVoice: () => void; closeVoice: () => void }
const VoiceCtx = createContext<Ctx>({ open: false, openVoice: () => {}, closeVoice: () => {} })

export const useVoice = () => useContext(VoiceCtx)

export function VoiceProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const openVoice = useCallback(() => setOpen(true), [])
  const closeVoice = useCallback(() => setOpen(false), [])
  const value = useMemo(() => ({ open, openVoice, closeVoice }), [open, openVoice, closeVoice])

  return (
    <VoiceCtx.Provider value={value}>
      {children}
      {/* Mounted only while open. The engine acquires the microphone in its
          constructor path, so keeping it alive behind a hidden overlay would hold
          the mic — and the browser's recording indicator — for the whole session. */}
      {open && (
        <Suspense fallback={null}>
          <VoiceOverlay onClose={closeVoice} />
        </Suspense>
      )}
    </VoiceCtx.Provider>
  )
}
