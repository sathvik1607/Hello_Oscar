import { useCallback, useEffect, useState } from 'react'
import {
  ExternalLink, FileSpreadsheet, FileText, File as FileIcon, Image as ImageIcon,
  Loader2, X,
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
  const [viewer, setViewer] = useState<{ href: string; revoke?: () => void } | null>(null)
  const preview = a.is_image || a.page_count ? thumbHref(a) : null

  /**
   * 🔴 AN IN-APP MODAL, NOT A NEW TAB OR A SAME-TAB NAVIGATION. Both of those
   * were tried and both share the same real complaint: once you're looking at
   * the file there is nothing TO close — a new tab has to be switched away
   * from or manually closed, and a same-tab navigation only "closes" via the
   * browser's own back button, which is not a control on the page at all. A
   * modal with its own × puts a close action for THIS specific file right on
   * the screen, and never leaves the comment thread underneath it.
   *
   * A PDF still gets a real in-app preview (the browser's native PDF renderer
   * inside an iframe — no pdf.js needed); an image renders at native size,
   * scrollable if it's taller than the viewer. Anything else (Office/CSV) has
   * no reliable in-browser preview, so the modal still opens for it — same
   * close button, same place — but its body is a single "Open in a new tab"
   * action rather than an embedded preview.
   */
  const open = useCallback(async () => {
    if (opening) return
    setOpening(true); setErr(null)
    try {
      const r = await attachmentHref(a)
      // The blob/direct URL (and its revoke, if any) is now owned by the
      // modal, which revokes it on close — revoking here, before the modal
      // has rendered it, would hand an <img>/<iframe> a URL that's already
      // dead.
      setViewer(r)
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not open that file.')
    } finally {
      setOpening(false)
    }
  }, [a, opening])

  const closeViewer = useCallback(() => {
    setViewer(v => { v?.revoke?.(); return null })
  }, [])

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
            {/* A hint that tapping opens something, rather than promising a
                specific destination — every kind now opens the same in-app
                modal (see `open` above), closable without leaving the thread. */}
            {preview && (
              <span className="shrink-0" style={{ color: 'var(--text-subtle)' }}>
                {opening ? <Loader2 className="size-4 animate-spin" />
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
      {viewer && <AttachmentViewer attachment={a} href={viewer.href} onClose={closeViewer} />}
    </div>
  )
}

/**
 * The in-app viewer — one modal shared by every kind of attachment, so there is
 * always exactly one specific thing being looked at and exactly one close
 * button for it. Rendered through `Portal` so it sits at the document root,
 * above everything (a sheet, another modal, the thread's own scroll region)
 * rather than being clipped or scrolled by whatever the chip happens to be
 * inside.
 */
function AttachmentViewer({ attachment: a, href, onClose }: {
  attachment: CommentAttachment; href: string; onClose: () => void
}) {
  // Esc closes it — the keyboard equivalent of the × for anyone not reaching
  // for the mouse, and the behaviour every native viewer already has.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const isPdf = a.mime_type.includes('pdf')
  // Neither an image nor a PDF has a reliable in-browser preview (Office/CSV
  // formats render via whatever's installed locally, not the browser itself),
  // so the modal still opens for these — same close button, same place — but
  // its body is a single external-open action instead of an embedded preview.
  const previewable = a.is_image || isPdf

  return (
    <Portal>
      <div className="fixed inset-0 z-[80] flex flex-col"
           style={{ background: 'rgba(0,0,0,.85)' }}>
        <div className="flex items-center justify-between gap-3 p-3">
          <span className="min-w-0 truncate text-[13px] font-medium text-white">
            {a.file_name ?? 'Attachment'}
          </span>
          <button onClick={onClose} aria-label="Close"
                  className="grid size-8 shrink-0 place-items-center rounded-full"
                  style={{ background: 'rgba(255,255,255,.12)', color: '#fff' }}>
            <X className="size-4" />
          </button>
        </div>
        {/* The backdrop itself also closes — clicking outside the file is the
            same gesture as the × on every viewer like this. The content area
            below stops that click from bubbling, so tapping the image/PDF
            itself does not close it. */}
        <button aria-label="Close" onClick={onClose}
                className="absolute inset-0 -z-10 cursor-default" />
        <div className="min-h-0 flex-1 overflow-auto p-3 pt-0"
             onClick={e => e.stopPropagation()}>
          {a.is_image && (
            <img src={href} alt={a.file_name ?? ''}
                 className="mx-auto block max-w-full" />
          )}
          {!a.is_image && isPdf && (
            <iframe src={href} title={a.file_name ?? 'PDF'}
                    className="h-full w-full rounded-lg border-0 bg-white" />
          )}
          {!previewable && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <p className="text-[13px]" style={{ color: 'rgba(255,255,255,.75)' }}>
                No preview for this file type.
              </p>
              <a href={href} target="_blank" rel="noopener noreferrer"
                 className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium"
                 style={{ background: 'rgba(255,255,255,.12)', color: '#fff' }}>
                <ExternalLink className="size-3.5" /> Open in a new tab
              </a>
            </div>
          )}
        </div>
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
