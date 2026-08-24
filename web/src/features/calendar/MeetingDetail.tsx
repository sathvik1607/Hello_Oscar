import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, MapPin, Pencil, Trash2, Users, X } from 'lucide-react'
import { ApiError, tasks as itemsApi } from '../../lib/api'
import { dayLabel, istNow, parseIstNaive, timeLabel } from '../../lib/format'
import type { Meeting } from '../../lib/types'
import { EditMeetingSheet } from './EditMeetingSheet'
import {
  CommentComposer, CommentList, useCommentThread,
} from '../tasks/CommentThread'
import { Badge, Button, IconButton, Portal, STATUS_LABEL, cx, Linkify} from '../../ui'

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
export function MeetingDetail({ meeting, onClose, onChanged, focusThread }: {
  meeting: Meeting
  onClose: () => void
  onChanged: () => void
  /** Opened from a `meeting_comment` notification — same contract as TaskDetail's,
   *  because the same endpoint serves both and a meeting comment is not a lesser
   *  kind of comment. */
  focusThread?: boolean
}) {
  const thread = useCommentThread(meeting.id, onChanged)
  /* Keyed on the rows ARRIVING, not on mount — see TaskDetail. */
  const threadRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!focusThread || thread.loading) return
    requestAnimationFrame(() =>
      threadRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }))
  }, [focusThread, thread.loading])
  const [editing, setEditing] = useState(false)
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

        {/* A flex COLUMN, so the comments block below can push itself to the bottom
            when the thread is short — see the mt-auto on it. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-4">
          {meeting.location && (
            <div className="mb-3 flex items-center gap-2 text-sm">
              <MapPin className="size-3.5 shrink-0" style={{ color: 'var(--text-subtle)' }} />
              <Linkify text={meeting.location} />
            </div>
          )}

          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[.1em]"
               style={{ color: 'var(--text-subtle)' }}>
            Description
          </div>
          {meeting.description?.trim() ? (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              <Linkify text={meeting.description} />
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
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {!confirm && (
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  <Pencil className="size-3.5" /> Edit
                </Button>
              )}
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

          {editing && (
            <EditMeetingSheet
              meeting={meeting}
              onClose={() => setEditing(false)}
              onSaved={() => {
                setEditing(false)
                // Reload rather than patching locally: changing scheduled_at moves
                // the meeting to a different day on the calendar behind this sheet.
                onChanged()
              }}
            />
          )}

          {err && <p className="mt-3 text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}

          {/*
            * `mt-auto` is the fix for a void.
            *
            * With the composer correctly pinned to the bottom of the sheet, a
            * one-comment thread left an enormous gap between the last comment and
            * the input — the content sat at the top and the rest of a full-height
            * sheet was empty. Every chat application solves this the same way: a
            * short thread hugs the composer rather than clinging to the top, so the
            * empty space ends up ABOVE the messages where it reads as headroom
            * instead of as a rendering fault.
            *
            * It only takes effect when there is slack. Once the thread is long
            * enough to overflow, this is inert and the region simply scrolls.
            */}
          <div ref={threadRef} className="mt-auto pt-6">
            <CommentList t={thread} />
          </div>
        </div>

        <CommentComposer t={thread} />
      </aside>
    </Portal>
  )
}
