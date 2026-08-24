import { useCallback, useEffect, useState } from 'react'
import {
  ExternalLink, FileSpreadsheet, FileText, File as FileIcon, Image as ImageIcon,
  Loader2, Maximize2, X,
} from 'lucide-react'
import { ApiError, attachmentHref, thumbHref } from '../../lib/api'
import { bytes } from '../../lib/format'
import type { CommentAttachment } from '../../lib/types'
import { Portal } from '../../ui'

/**
 * A file on a comment. Mirrors the Flutter `AttachmentChip` and its entity rules,
 * so the same file reads the same way on both clients.
 *
 * Three of those rules are load-bearing and were taken from the Flutter entity
 * rather than re-derived:
 *
 *  · **Trust `is_image`, never sniff `mime_type`.** The server already decided, and
 *    it is what governs whether a thumbnail was generated at all.
 *
 *  · **Never guess a thumbnail URL.** A document with no preview and an image whose
 *    thumbnail FAILED look identical from here; a guessed URL is broken rather than
 *    merely slow. `thumb_key` being NULL is a normal, expected state.
 *
 *  · **Preference order: direct link, then the permission-checked route.** On the
 *    web that second step needs an authenticated fetch, because markup cannot send
 *    a bearer header — see attachmentHref().
 */
export function AttachmentChip({ attachment: a, onRemove }: {
  attachment: CommentAttachment
  /** Present only while staged in the composer, before the comment is posted. */
  onRemove?: () => void
}) {
  const [opening, setOpening] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  /** The lightbox href, plus the revoke that frees it. Null when closed. */
  const [lightbox, setLightbox] = useState<{ href: string; revoke?: () => void } | null>(null)
  const preview = a.is_image || a.page_count ? thumbHref(a) : null

  /**
   * 🔴 IMAGES OPEN IN PLACE, DOCUMENTS OPEN IN A TAB — and the split is not a
   * preference, it is what each format can actually do here.
   *
   * An image is one `<img>`; showing it inline keeps you in the thread you were
   * reading, and a new tab for a screenshot someone pasted is a context switch for
   * nothing. A PDF is not renderable without a viewer — the browser's own is in the
   * tab chrome, and embedding one (pdf.js is ~350 kB) to duplicate something every
   * browser already ships would be the wrong trade. So a document keeps the tab.
   */
  const openInTab = useCallback(async () => {
    if (opening) return
    setOpening(true); setErr(null)
    let revoke: (() => void) | undefined
    try {
      const r = await attachmentHref(a)
      revoke = r.revoke
      window.open(r.href, '_blank', 'noopener')
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not open that file.')
    } finally {
      setOpening(false)
      // A blob URL pins the whole file in memory until the document is discarded.
      // Revoked on a delay because revoking before the new tab has read it yields
      // a blank tab — 60s is far longer than a read and still bounded.
      if (revoke) setTimeout(revoke, 60_000)
    }
  }, [a, opening])

  const openImage = useCallback(async () => {
    if (opening) return
    setOpening(true); setErr(null)
    try {
      // The FULL file, not the thumbnail. `thumbHref` is a 256px render — fine in the
      // chip, unreadable blown up to the viewport.
      const r = await attachmentHref(a)
      setLightbox(r)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not open that image.')
    } finally {
      setOpening(false)
    }
  }, [a, opening])

  const open = a.is_image ? openImage : openInTab

  // "4 pages · PDF · 719 KB" — each part dropped when unknown, so a backend that
  // reports no page count reads correctly instead of showing "null pages".
  const subtitle = [
    a.page_count && a.page_count > 0
      ? `${a.page_count} page${a.page_count === 1 ? '' : 's'}` : null,
    extension(a.file_name),
    bytes(a.byte_size),
  ].filter(Boolean).join(' · ')

  return (
    /**
     * 🔴 A HARD WIDTH CAP, not `max-w-full`.
     *
     * `max-w-full` resolves against a parent that is itself content-sized, so it
     * imposes nothing — a long filename (and the backend keeps the original, e.g.
     * "quotation-3742-drivetech-engineering-egg-way-international-asia-pvt-ltd (2).pdf")
     * stretched the chip straight out of the sheet with `truncate` never firing.
     * 320px is a bound the text has to obey.
     */
    <div className="min-w-0 max-w-[320px]">
      <div className="overflow-hidden rounded-xl border transition hover:brightness-[.98]"
           style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}>
        {/* A REAL preview when the server rendered one — page 1 of the PDF, or the
            image itself. The 40px square it used to get was too small to recognise a
            document by, which is the only thing a preview is for. Whether one exists
            is the server's answer (`thumb_key`), never guessed here. */}
        {preview && (
          <button onClick={() => void open()} disabled={opening}
                  className="block w-full" aria-label={`Open ${a.file_name ?? 'file'}`}>
            <img src={preview} alt="" loading="lazy"
                 // object-top, not center: a document's identity is its letterhead
                 // and title, which are at the TOP of page one. Centring crops to
                 // the middle of a paragraph and every PDF looks alike.
                 className="block max-h-52 w-full object-cover object-top"
                 style={{ background: 'var(--bg-sunken)' }} />
          </button>
        )}
        <div className="flex items-center gap-2.5 p-2">
          <button onClick={() => void open()} disabled={opening}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
            {/* The icon square is dropped once a preview is showing — it would be a
                second, smaller thumbnail of the same file directly beneath it. */}
            {!preview && (
              <span className="grid size-10 shrink-0 place-items-center rounded-lg"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                {opening ? <Loader2 className="size-4 animate-spin" /> : icon(a)}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">
                {a.file_name ?? 'Attachment'}
              </span>
              <span className="block truncate text-[11px]" style={{ color: 'var(--text-subtle)' }}>
                {opening ? 'Opening…' : subtitle}
              </span>
            </span>
            {/* Says where the tap goes BEFORE you take it. A new tab that arrives
                unannounced reads as the app having navigated away from you. */}
            {preview && (
              <span className="shrink-0" style={{ color: 'var(--text-subtle)' }}>
                {opening ? <Loader2 className="size-4 animate-spin" />
                         : a.is_image ? <Maximize2 className="size-3.5" />
                                      : <ExternalLink className="size-3.5" />}
              </span>
            )}
          </button>
          {onRemove && (
            <button onClick={onRemove} aria-label={`Remove ${a.file_name ?? 'file'}`}
                    className="grid size-6 shrink-0 place-items-center rounded-md"
                    style={{ color: 'var(--text-subtle)' }}>
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      {err && <p className="mt-1 px-1 text-[11px]" style={{ color: '#DC2626' }}>{err}</p>}

      {lightbox && (
        <Lightbox href={lightbox.href} name={a.file_name}
                  onClose={() => {
                    // Revoked on close, not on a timer: the <img> has already decoded
                    // and nothing else holds the blob, so keeping it alive would pin
                    // a full-size image in memory for as long as the tab lives.
                    lightbox.revoke?.()
                    setLightbox(null)
                  }} />
      )}
    </div>
  )
}

/** One image, filling the window. Deliberately not a gallery — a comment carries a
 *  handful of files, not an album, and next/previous would need a shared list this
 *  component has no view of. */
function Lightbox({ href, name, onClose }: {
  href: string; name: string | null; onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <Portal>
      {/* The backdrop is the close button, which is how every image viewer behaves —
          and the × stays for anyone who does not know that. */}
      <div className="fade fixed inset-0 z-[90] grid place-items-center bg-black/80 p-4"
           role="dialog" aria-modal="true" aria-label={name ?? 'Image'}
           onClick={onClose}>
        <img src={href} alt={name ?? ''}
             // Stops a click ON the image from closing it — you click an image to
             // look at it, not to dismiss it.
             onClick={e => e.stopPropagation()}
             className="max-h-full max-w-full rounded-lg object-contain shadow-2xl" />
        <button onClick={onClose} aria-label="Close"
                className="absolute right-4 top-4 grid size-9 place-items-center
                           rounded-full bg-white/10 text-white hover:bg-white/20">
          <X className="size-5" />
        </button>
        {name && (
          <p className="absolute bottom-4 left-1/2 max-w-[80vw] -translate-x-1/2 truncate
                        rounded-full bg-black/50 px-3 py-1 text-[12px] text-white">
            {name}
          </p>
        )}
      </div>
    </Portal>
  )
}

/** Uploading, before the server has given it an id. Shown so a large file on a slow
 *  connection is visibly in progress rather than apparently ignored. */
export function PendingChip({ name, onCancel }: { name: string; onCancel?: () => void }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border p-2"
         style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}>
      <span className="grid size-10 shrink-0 place-items-center rounded-lg"
            style={{ background: 'var(--bg-sunken)', color: 'var(--text-subtle)' }}>
        <Loader2 className="size-4 animate-spin" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{name}</span>
        <span className="block text-[11px]" style={{ color: 'var(--text-subtle)' }}>
          Uploading…
        </span>
      </span>
      {onCancel && (
        <button onClick={onCancel} aria-label="Cancel upload"
                className="grid size-6 shrink-0 place-items-center rounded-md"
                style={{ color: 'var(--text-subtle)' }}>
          <X className="size-3.5" />
        </button>
      )}
    </div>
  )
}

function icon(a: CommentAttachment) {
  if (a.is_image) return <ImageIcon className="size-4" />
  const m = a.mime_type ?? ''
  if (m.includes('pdf')) return <FileText className="size-4" />
  if (m.includes('sheet') || m.includes('excel') || m.includes('csv'))
    return <FileSpreadsheet className="size-4" />
  if (m.includes('word') || m.startsWith('text/')) return <FileText className="size-4" />
  return <FileIcon className="size-4" />
}

function extension(name: string | null): string {
  if (!name) return ''
  const i = name.lastIndexOf('.')
  return i <= 0 || i === name.length - 1 ? '' : name.slice(i + 1).toUpperCase()
}

/** What the client will accept before bothering the server. The server is still the
 *  authority — it magic-byte sniffs and blocks executable signatures even on text
 *  formats — but rejecting an obvious mismatch here saves a 25 MB upload that was
 *  always going to be refused. */
export const ACCEPTED =
  '.pdf,.xls,.xlsx,.csv,.doc,.docx,.ppt,.pptx,.png,.jpg,.jpeg,.webp,.gif'
export const MAX_BYTES = 25 * 1024 * 1024
