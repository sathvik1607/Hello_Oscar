import { useCallback, useState } from 'react'
import {
  FileSpreadsheet, FileText, File as FileIcon, Image as ImageIcon, Loader2, X,
} from 'lucide-react'
import { ApiError, attachmentHref, thumbHref } from '../../lib/api'
import { bytes } from '../../lib/format'
import type { CommentAttachment } from '../../lib/types'
import { cx } from '../../ui'

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
  const preview = a.is_image || a.page_count ? thumbHref(a) : null

  const open = useCallback(async () => {
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

  // "4 pages · PDF · 719 KB" — each part dropped when unknown, so a backend that
  // reports no page count reads correctly instead of showing "null pages".
  const subtitle = [
    a.page_count && a.page_count > 0
      ? `${a.page_count} page${a.page_count === 1 ? '' : 's'}` : null,
    extension(a.file_name),
    bytes(a.byte_size),
  ].filter(Boolean).join(' · ')

  return (
    <div className="min-w-0">
      <div className={cx('flex max-w-full items-center gap-2.5 rounded-xl border p-2 transition',
                         'hover:brightness-[.98]')}
           style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}>
        <button onClick={() => void open()} disabled={opening}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
          {preview ? (
            <img src={preview} alt="" loading="lazy"
                 className="size-10 shrink-0 rounded-lg object-cover"
                 style={{ background: 'var(--bg-sunken)' }} />
          ) : (
            <span className="grid size-10 shrink-0 place-items-center rounded-lg"
                  style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              {opening ? <Loader2 className="size-4 animate-spin" /> : icon(a)}
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-medium">
              {a.file_name ?? 'Attachment'}
            </span>
            <span className="block truncate text-[11px]" style={{ color: 'var(--text-subtle)' }}>
              {subtitle}
            </span>
          </span>
        </button>
        {onRemove && (
          <button onClick={onRemove} aria-label={`Remove ${a.file_name ?? 'file'}`}
                  className="grid size-6 shrink-0 place-items-center rounded-md"
                  style={{ color: 'var(--text-subtle)' }}>
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {err && <p className="mt-1 px-1 text-[11px]" style={{ color: '#DC2626' }}>{err}</p>}
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
