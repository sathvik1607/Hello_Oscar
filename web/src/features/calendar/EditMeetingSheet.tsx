import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { ApiError, tasks as tasksApi } from '../../lib/api'
import { Button, Field, IconButton, Portal, inputCls, inputStyle } from '../../ui'
import type { Meeting } from '../../lib/types'

/**
 * Edit a meeting.
 *
 * There was no way to change a meeting at all — MeetingDetail offered Cancel and
 * nothing else, so moving one by half an hour meant cancelling it and asking Oscar
 * to make a new one, which loses the comment thread and re-notifies every invitee.
 *
 * Writes through `PATCH /items/{id}`, the same generic surface Cancel already uses,
 * so there is no new endpoint and no new permission path.
 *
 * 🔴 TIMES ARE IST-NAIVE, AND ARE SPLIT ON CHARACTERS RATHER THAN PARSED.
 * `scheduled_at` arrives as "2026-08-24 18:30:00" with no timezone; the backend
 * stores those digits verbatim. `new Date(...)` would apply the browser's offset
 * and show a time hours away from the one that is stored — the same trap the task
 * sheet documents.
 *
 * ⚠️ ATTENDEES ARE NOT EDITABLE HERE, deliberately. `pa_items.attendee_user_ids` is
 * a comma-separated VARCHAR and the invitee also lives in `assigned_to_user_id`, so
 * changing who is coming means reconciling two columns AND deciding who gets
 * notified about being added or dropped. Meeting invitee resolution also falls back
 * BEYOND the caller's team, so a mistyped name can invite an unrelated real account
 * and push a notification at them. That belongs in its own change with its own
 * tests, not bolted onto a reschedule form. The current attendees are shown
 * read-only so it is clear they are unchanged rather than lost.
 */
export function EditMeetingSheet({ meeting, onClose, onSaved }: {
  meeting: Meeting
  onClose: () => void
  onSaved: () => void
}) {
  const startDate = meeting.scheduled_at?.slice(0, 10) ?? ''
  const startTime = meeting.scheduled_at?.slice(11, 16) ?? '09:00'
  const endTime = meeting.ends_at?.slice(11, 16) ?? ''

  const [title, setTitle] = useState(meeting.title ?? '')
  const [date, setDate] = useState(startDate)
  const [from, setFrom] = useState(startTime)
  const [to, setTo] = useState(endTime)
  const [location, setLocation] = useState(meeting.location ?? '')
  const [description, setDescription] = useState(meeting.description ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => { titleRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const t = title.trim()
    if (!t || !date || !from || busy) return
    // Caught here rather than by the backend: an end before the start produces a
    // meeting with a negative duration, which the conflict checker then reasons
    // about incorrectly instead of rejecting.
    if (to && to <= from) {
      setErr('The end time has to be after the start time.')
      return
    }
    setBusy(true); setErr(null)
    try {
      await tasksApi.update(meeting.id, {
        title: t,
        // Assembled from the PARTS, so the browser's timezone never enters it.
        scheduled_at: `${date}T${from}:00`,
        // Omitted when blank rather than sent empty — the backend derives a default
        // duration, and an empty string would fail to parse.
        ...(to ? { ends_at: `${date}T${to}:00` } : {}),
        location: location.trim(),
        description: description.trim(),
      })
      onSaved()
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2))
      setBusy(false)
    }
  }

  const attendees = (meeting.attendees ?? []).filter(Boolean)

  return (
    <Portal>
      <button aria-label="Close" onClick={onClose}
              className="fade fixed inset-0 z-40 bg-black/30" />
      <div
        role="dialog" aria-modal="true" aria-label="Edit meeting"
        className="rise fixed inset-x-0 bottom-0 z-50 rounded-t-3xl border-t p-5
                   sm:inset-0 sm:m-auto sm:h-fit sm:max-w-md sm:rounded-2xl sm:border"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)',
                 paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">Edit meeting</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label="Title">
            <input ref={titleRef} value={title} onChange={e => setTitle(e.target.value)}
                   className={inputCls} style={inputStyle} placeholder="Meeting title" />
          </Field>

          <Field label="Date">
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
                   className={inputCls} style={inputStyle} />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <input type="time" value={from} onChange={e => setFrom(e.target.value)}
                     className={inputCls} style={inputStyle} />
            </Field>
            <Field label="To" hint="Optional">
              <input type="time" value={to} onChange={e => setTo(e.target.value)}
                     className={inputCls} style={inputStyle} />
            </Field>
          </div>

          <Field label="Location" hint="Optional">
            <input value={location} onChange={e => setLocation(e.target.value)}
                   className={inputCls} style={inputStyle} placeholder="Where" />
          </Field>

          <Field label="Notes" hint="Optional">
            <textarea value={description} onChange={e => setDescription(e.target.value)}
                      rows={2} className={inputCls}
                      style={{ ...inputStyle, resize: 'none' }} />
          </Field>

          {attendees.length > 0 && (
            /* Read-only, and labelled as such. Showing them makes it obvious the
               guest list is being preserved; leaving them out would read as though
               saving might drop it. */
            <div className="rounded-xl border px-3.5 py-2.5"
                 style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
              <div className="text-[11px] font-medium" style={{ color: 'var(--text-subtle)' }}>
                Attendees — unchanged
              </div>
              <div className="mt-0.5 text-[13px]">{attendees.join(', ')}</div>
            </div>
          )}

          {err && <p className="text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}

          <div className="flex gap-2 pt-1">
            <Button type="submit" variant="primary" loading={busy}
                    disabled={!title.trim() || !date || !from} className="flex-1">
              Save changes
            </Button>
            <Button type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </div>
    </Portal>
  )
}
