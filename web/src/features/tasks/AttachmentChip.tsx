import { useCallback, useEffect, useState } from 'react'
import {
  Download, ExternalLink, FileSpreadsheet, FileText, File as FileIcon,
  Image as ImageIcon, Loader2, X,
} from 'lucide-react'
import { ApiError, attachmentBlob, attachmentHref, attachmentText, thumbHref } from '../../lib/api'
import { bytes } from '../../lib/format'
import type { CommentAttachment } from '../../lib/types'
import { Portal } from '../../ui'

/** How many AttachmentViewer instances are currently mounted — read by
 *  TaskDetail's own Escape handler so one Escape closes only the FRONT-MOST
 *  layer (the file preview) rather than both it and the task sheet underneath
 *  at once. See AttachmentViewer's own Escape-handling comment for why this
 *  exists instead of stopPropagation/preventDefault between the two
 *  independent window-level listeners. */
export let _openViewerCount = 0

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

  const [downloading, setDownloading] = useState(false)

  /**
   * One click, saves under the ORIGINAL uploaded filename — no rename prompt.
   * The browser's own Save-As dialog already lets someone pick a different
   * name at save time, which is the standard way to rename a download; a
   * custom rename step here would add a modal in front of EVERY download to
   * serve the rare case instead of the common one.
   *
   * Uses attachmentBlob, NOT attachmentHref — attachmentHref takes the
   * direct_url shortcut when one exists (the common case for task
   * attachments, which are public), and the `download` attribute is IGNORED
   * by every browser on that cross-origin S3 link, so the save would fall
   * back to the random uuid-based storage key as the filename instead of the
   * real one. attachmentBlob always fetches real bytes into a same-origin
   * blob: URL, where `download` reliably works.
   */
  const download = useCallback(async () => {
    if (downloading) return
    setDownloading(true); setErr(null)
    try {
      const r = await attachmentBlob(a)
      const link = document.createElement('a')
      link.href = r.href
      link.download = a.file_name ?? 'download'
      document.body.appendChild(link)
      link.click()
      link.remove()
      r.revoke()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not download that file.')
    } finally {
      setDownloading(false)
    }
  }, [a, downloading])

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
          {/* Not shown while onRemove is present — that's the composer's staged-
              file state, before the comment is posted, and there is nothing on
              the server yet to download. */}
          {!onRemove && (
            <button onClick={() => void download()} disabled={downloading}
                    aria-label={`Download ${a.file_name ?? 'file'}`}
                    className="grid size-6 shrink-0 place-items-center rounded-md"
                    style={{ color: 'var(--text-subtle)' }}>
              {downloading ? <Loader2 className="size-3.5 animate-spin" />
                           : <Download className="size-3.5" />}
            </button>
          )}
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
  //
  // 🔴 Registers into the shared `_openViewerCount` below, which TaskDetail's
  // OWN Escape handler checks before closing itself. Two independent
  // `window.addEventListener('keydown', …)` calls on the same target (this
  // one and TaskDetail's, since this viewer opens ON TOP of the task sheet)
  // fire in REGISTRATION order for ONE keypress, and TaskDetail mounted first
  // — confirmed live via a console trace: neither `capture: true` nor
  // `e.preventDefault()`/`e.stopPropagation()` can reorder or be checked
  // reliably across two listeners on the SAME target when the one that needs
  // to act SECOND (TaskDetail, checking a flag) runs FIRST in wall-clock time.
  // A shared counter sidesteps the ordering problem entirely: TaskDetail reads
  // a plain value instead of inferring "is a viewer open" from event timing.
  useEffect(() => {
    _openViewerCount++
    return () => { _openViewerCount-- }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const isPdf = a.mime_type.includes('pdf')
  // CSV is plain text — unlike Excel/Word/PPT, no binary format to decode, so a
  // real table render is cheap and worth it. Matched on mime type AND the file
  // extension: some browsers/OSes hand a CSV upload a generic
  // application/vnd.ms-excel mime type, which the extension disambiguates.
  const isCsv = a.mime_type.includes('csv') ||
    (a.file_name ?? '').toLowerCase().endsWith('.csv')
  // Neither an image, a PDF, nor CSV has a reliable in-browser preview for the
  // REST of Office/document formats (Excel/Word/PPT render via whatever's
  // installed locally, not the browser itself), so the modal still opens for
  // those — same close button, same place — but its body is a single
  // external-open action instead of an embedded preview.
  const previewable = a.is_image || isPdf || isCsv

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
          {!a.is_image && !isPdf && isCsv && <CsvTable attachment={a} />}
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

/** Row count above which the table shows a truncation note rather than
 *  rendering every row — the point where a real spreadsheet import (thousands
 *  of rows) would otherwise freeze the tab laying out one giant DOM table for
 *  a document nobody is going to read cell-by-cell in a modal anyway. */
const _CSV_MAX_ROWS = 500

/**
 * A minimal but CORRECT CSV parser — handles quoted fields (so a comma or a
 * newline INSIDE a quoted value doesn't split the row wrong) and "" as an
 * escaped quote inside a quoted field, per the format every spreadsheet
 * export actually uses. A naive `line.split(',')` looks fine on a toy example
 * and silently misparses the first real export with a quoted address or note
 * field containing a comma.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\r') { i++; continue } // normalize CRLF — the \n below ends the row
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c; i++
  }
  // Trailing field/row with no final newline — the common case for a file
  // that doesn't end with a blank line.
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows
}

/** Fetches and renders a CSV's actual content as a table, inside the existing
 *  attachment viewer modal. Goes through attachmentText — NOT the href already
 *  resolved for the image/PDF branches, which may be a direct S3 link with no
 *  CORS policy for fetch() (see attachmentText's own comment). */
function CsvTable({ attachment: a }: { attachment: CommentAttachment }) {
  const [state, setState] = useState<
    { rows: string[][] } | { error: string } | null>(null)

  useEffect(() => {
    let alive = true
    attachmentText(a).then(text => {
      if (!alive) return
      const rows = parseCsv(text).filter(r => r.some(cell => cell.trim() !== ''))
      setState({ rows })
    }).catch(() => { if (alive) setState({ error: 'Could not read this file.' }) })
    return () => { alive = false }
  }, [a])

  if (!state) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin" style={{ color: 'rgba(255,255,255,.6)' }} />
      </div>
    )
  }
  if ('error' in state) {
    return (
      <p className="p-4 text-center text-[13px]" style={{ color: 'rgba(255,255,255,.75)' }}>
        {state.error}
      </p>
    )
  }
  if (state.rows.length === 0) {
    return (
      <p className="p-4 text-center text-[13px]" style={{ color: 'rgba(255,255,255,.75)' }}>
        This file is empty.
      </p>
    )
  }

  const [header, ...body] = state.rows
  const truncated = body.length > _CSV_MAX_ROWS
  const shown = truncated ? body.slice(0, _CSV_MAX_ROWS) : body

  return (
    <div className="rounded-lg" style={{ background: '#fff' }}>
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {header.map((cell, i) => (
              <th key={i}
                  className="sticky top-0 whitespace-nowrap border-b-2 px-3 py-2 text-left font-bold"
                  style={{ background: '#e5e7eb', borderColor: '#9ca3af', color: '#111827' }}>
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, ri) => (
            <tr key={ri}>
              {r.map((cell, ci) => (
                <td key={ci} className="whitespace-nowrap border-b px-3 py-1.5"
                    style={{ borderColor: '#e5e7eb', color: '#1f2937' }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p className="px-3 py-2 text-[12px]" style={{ color: '#6b7280' }}>
          Showing the first {_CSV_MAX_ROWS} of {body.length} rows — open in a new tab for the rest.
        </p>
      )}
    </div>
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
