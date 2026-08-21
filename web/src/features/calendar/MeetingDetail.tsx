import { useCallback, useEffect, useState } from 'react'
import { Clock, MapPin, Trash2, Users, X } from 'lucide-react'
import { ApiError, tasks as itemsApi } from '../../lib/api'
import { dayLabel, istNow, parseIstNaive, timeLabel } from '../../lib/format'
import type { Meeting } from '../../lib/types'
import {
  CommentComposer, CommentList, useCommentThread,
} from '../tasks/CommentThread'
import { Badge, Button, IconButton, Portal, STATUS_LABEL, cx } from '../../ui'

/**
 * One meeting, opened.
 *
 * Reuses `CommentThread` because the backend endpoint does: a meeting id goes in
 * the `{task_id}` slot of `/users/{uid}/tasks/{id}/comments` and passes the same
 * permission gate, so meetings get the same thread and the same file attachments
 * tasks do. A separate meeting-comments implementation would be two copies of the
 * upload staging and the access-denied handling, drifting apart.
 *
 * Cancel goes through `/items/{id}` — the same generic write surface — and is SOFT:
 * status becomes 'cancelled' and the row survives, which is why the calendar keeps
 * showing it. `POST /meetings` creates ONE shared row rather than a copy per
 * invitee, so cancelling here is seen by everyone on it.
 */
export function MeetingDetail({ meeting, onClose, onChanged }: {
  meeting: Meeting
  onClose: () => void
  onChanged: () => void
}) {
  const thread = useCommentThread(meeting.id, onChanged)
  const [err, setErr] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)

  const at = parseIstNaive(meeting.scheduled_at)
  const end = parseIstNaive(meeting.ends_at)
  const now = istNow()
  const live = !!at && !!end && at <= now && now <= end
  const past = !!end && end < now

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const cancel = useCallback(async () => {
    setErr(null)
    try {
      await itemsApi.cancel(meeting.id)
      onChanged()
      onClose()
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : String(e))
      setConfirm(false)
    }
  }, [meeting.id, onChanged, onClose])

  return (
    <Portal>
      <button aria-label="Close" onClick={onClose}
              className="fade fixed inset-0 z-[55] bg-black/35" />
      <aside role="dialog" aria-modal="true" aria-label={meeting.title}
             className="fixed inset-y-0 right-0 z-[56] flex w-full flex-col border-l
                        shadow-2xl sm:max-w-[540px]"
             style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}>
        <header className="flex items-start gap-3 border-b px-5 py-4"
                style={{ borderColor: 'var(--border)' }}>
          <div className="min-w-0 flex-1">
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              <Badge tone="brand">Meeting</Badge>
              {live && <Badge tone="completed">Happening now</Badge>}
              {meeting.status !== 'pending' && (
                <Badge tone={meeting.status}>
                  {STATUS_LABEL[meeting.status] ?? meeting.status}
                </Badge>
              )}
            </div>
            <h2 className={cx('text-[17px] font-semibold leading-snug',
                              meeting.status === 'cancelled' && 'line-through')}>
              {meeting.title}
            </h2>
            <div className="mt-1.5 flex items-center gap-1.5 text-[13px]"
                 style={{ color: 'var(--text-muted)' }}>
              <Clock className="size-3.5" />
              {at ? `${dayLabel(at)} · ${timeLabel(at)}` : 'No time set'}
              {end && ` – ${timeLabel(end)}`}
            </div>
          </div>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {meeting.location && (
            <div className="mb-3 flex items-center gap-2 text-sm">
              <MapPin className="size-3.5 shrink-0" style={{ color: 'var(--text-subtle)' }} />
              {meeting.location}
            </div>
          )}

          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[.1em]"
               style={{ color: 'var(--text-subtle)' }}>
            Description
          </div>
          {meeting.description?.trim() ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {meeting.description}
            </p>
          ) : (
            <p className="text-sm italic" style={{ color: 'var(--text-subtle)' }}>
              No description.
            </p>
          )}

          {!!meeting.attendees?.length && (
            <div className="mt-4 rounded-xl p-3.5" style={{ background: 'var(--bg-sunken)' }}>
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold
                              uppercase tracking-[.1em]"
                   style={{ color: 'var(--text-subtle)' }}>
                <Users className="size-3" /> Attendees
              </div>
              <div className="flex flex-wrap gap-1.5">
                {meeting.attendees.map(a => (
                  <span key={a} className="rounded-full px-2 py-1 text-xs"
                        style={{ background: 'var(--bg-elevated)', color: 'var(--text-muted)' }}>
                    {a}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Cancelling something already over would only confuse the record. */}
          {!past && meeting.status !== 'cancelled' && (
            <div className="mt-4 flex items-center gap-2">
              {confirm ? (
                <>
                  <Button size="sm" variant="danger" onClick={() => void cancel()}>
                    Cancel it
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                    Keep
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
                  <Trash2 className="size-3.5" /> Cancel meeting
                </Button>
              )}
            </div>
          )}

          {err && <p className="mt-3 text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}

          <div className="mt-6">
            <CommentList t={thread} />
          </div>
        </div>

        <CommentComposer t={thread} />
      </aside>
    </Portal>
  )
}
