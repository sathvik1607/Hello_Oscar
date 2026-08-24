import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { ApiError, meetings as meetingsApi, tasks as tasksApi, team as teamApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { getUser } from '../../lib/session'
import { Button, Field, IconButton, Portal, inputCls, inputStyle } from '../../ui'
import type { Meeting } from '../../lib/types'

/**
 * Create or edit a meeting.
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
 * ATTENDEES ARE PICKED FROM THE TEAM, never typed.
 *
 * 🔴 That is the whole safety of it. Meeting invitee resolution in the AGENT falls
 * back beyond the caller's team, and this project has a live example — `Anil Kumar
 * Nallamula` (id 52), outside team 2 — where a bare first name would book an
 * unrelated real person and push a notification at them. A picker over
 * `GET /teams/{id}/members` cannot produce a stranger: every option is somebody
 * already on the team, and it sends IDS rather than a name to be resolved.
 *
 * The backend fans `attendee_user_ids` out so every invitee sees the meeting on
 * their own schedule, and derives `assigned_to_user_id` (the primary) from the
 * first — so this sends the list and lets the server own that rule rather than
 * duplicating it here.
 */
export function EditMeetingSheet({ meeting, onClose, onSaved, defaultDate }: {
  /** Omitted to CREATE. Same shape as NewTaskSheet, and for the same reason: one
   *  form, so the create and edit paths cannot drift on validation, on the
   *  IST-naive time handling, or on which fields exist. */
  meeting?: Meeting
  onClose: () => void
  onSaved: () => void
  /** Seeds the date when creating. The calendar passes the day you are LOOKING at —
   *  tapping + on Thursday and getting a form set to today is a small thing that
   *  makes you re-pick the date every time. */
  defaultDate?: string
}) {
  const creating = !meeting
  const startDate = meeting?.scheduled_at?.slice(0, 10) ?? defaultDate ?? ''
  const startTime = meeting?.scheduled_at?.slice(11, 16) ?? '09:00'
  const endTime = meeting?.ends_at?.slice(11, 16) ?? ''

  const [title, setTitle] = useState(meeting?.title ?? '')
  const [date, setDate] = useState(startDate)
  const [from, setFrom] = useState(startTime)
  const [to, setTo] = useState(endTime)
  const [location, setLocation] = useState(meeting?.location ?? '')
  const [description, setDescription] = useState(meeting?.description ?? '')
  const me = getUser()
  const members = useApi(s => (me?.team_id ? teamApi.members(me.team_id, s) : Promise.resolve([])),
                         [me?.team_id])
  // Seeded from the meeting being edited, so saving a reschedule cannot silently
  // drop the guest list — the failure the read-only version was avoiding.
  const [invitees, setInvitees] = useState<number[]>(
    () => (meeting?.attendee_user_ids ?? []).filter(Boolean))
  // Guests who are NOT user accounts — a customer, someone from another company.
  // One comma-separated field rather than a tag editor: the backend stores them as a
  // single joined string, so a richer widget here would only be re-splitting its own
  // output. Seeded from what is already on the meeting so an edit cannot drop them.
  const [guests, setGuests] = useState((meeting?.attendees ?? []).filter(Boolean).join(', '))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => { titleRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** "Anil, Priya from Sharma Traders" → ["Anil", "Priya from Sharma Traders"].
   *  Blank entries dropped, so a trailing comma does not create an empty guest. */
  const guestList = () => guests.split(',').map(g => g.trim()).filter(Boolean)

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
      if (creating) {
        // POST /meetings, the endpoint that has existed all along with no UI behind
        // it. Times assembled from the PARTS, exactly as the edit path does.
        await meetingsApi.create({
          title: t,
          scheduled_at: `${date}T${from}:00`,
          ...(to ? { ends_at: `${date}T${to}:00` } : {}),
          location: location.trim(),
          description: description.trim(),
          ...(invitees.length ? { attendee_user_ids: invitees } : {}),
          ...(guestList().length ? { attendees: guestList() } : {}),
        })
        onSaved()
        return
      }
      await tasksApi.update(meeting.id, {
        // Sent on every save, including when unchanged: PATCH /items replaces the
        // field, so omitting it on an edit that changed only the time would be read
        // as "no invitees" by any future handler that treats absent as empty.
        attendee_user_ids: invitees,
        // Sent on every save for the same reason as the ids: PATCH replaces, so
        // omitting it on a reschedule would read as "no guests".
        attendees: guestList(),
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


  return (
    <Portal>
      <button aria-label="Close" onClick={onClose}
              className="fade fixed inset-0 z-[70] bg-black/30" />
      <div
        role="dialog" aria-modal="true" aria-label={creating ? "New meeting" : "Edit meeting"}
        className="rise fixed inset-x-0 bottom-0 z-[71] max-h-[92dvh] overflow-y-auto
                   rounded-t-3xl border-t p-5
                   sm:inset-0 sm:m-auto sm:h-fit sm:max-w-2xl sm:rounded-2xl sm:border sm:p-6"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)',
                 paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">{creating ? 'New meeting' : 'Edit meeting'}</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </div>

        <form onSubmit={submit} className="space-y-4">
          {/* A GRID, not a stack. Eight stacked fields made the sheet taller than
              most laptop screens — the Create button sat below the fold, so the last
              thing you did was scroll to find it. Grouped the way the sentence works
              instead: what, when, where, who. */}
          <Field label="Title">
            <input ref={titleRef} value={title} onChange={e => setTitle(e.target.value)}
                   className={inputCls} style={inputStyle} placeholder="Meeting title" />
          </Field>

          {/* Date, from and to on one line — they are one thought. */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="col-span-2">
              <Field label="Date">
                <input type="date" value={date} onChange={e => setDate(e.target.value)}
                       className={inputCls} style={inputStyle} />
              </Field>
            </div>
            <Field label="From">
              <input type="time" value={from} onChange={e => setFrom(e.target.value)}
                     className={inputCls} style={inputStyle} />
            </Field>
            <Field label="To" hint="Optional">
              <input type="time" value={to} onChange={e => setTo(e.target.value)}
                     className={inputCls} style={inputStyle} />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Location" hint="Optional">
              <input value={location} onChange={e => setLocation(e.target.value)}
                     className={inputCls} style={inputStyle}
                     placeholder="Room, or a meeting link" />
            </Field>
            <Field label="Other guests" hint="Comma separated · not notified">
              <input value={guests} onChange={e => setGuests(e.target.value)}
                     className={inputCls} style={inputStyle}
                     // Roles, not names. A placeholder that reads like a real person invites
                     // the guess that it IS one — and these names go nowhere near a
                     // notification, so an example that looks like a contact is misleading
                     // twice over.
                     placeholder="Client name, vendor contact" />
            </Field>
          </div>

          {/* 🔴 "not notified" above is literal. Those names join into one VARCHAR
              that cannot be FK'd to a user, so there is nobody to push to and no
              calendar to add it to — the meeting lands on TEAM members' schedules
              only. Saying so is the difference between a record of who is expected
              and a false belief that an invitation went out. */}

          <Field label="Who's coming" hint="Teammates — they get it on their calendar">
            <div className="flex flex-wrap gap-1.5">
              {(members.data ?? [])
                .filter(mm => mm.is_active && mm.user_id !== me?.id)
                .map(mm => {
                  const on = invitees.includes(mm.user_id)
                  return (
                    <button key={mm.user_id} type="button"
                            onClick={() => setInvitees(v => on
                              ? v.filter(x => x !== mm.user_id)
                              : [...v, mm.user_id])}
                            className="rounded-full border px-3 py-1.5 text-[12.5px]
                                       transition hover:brightness-95"
                            style={on
                              ? { background: 'var(--accent)', color: '#fff',
                                  borderColor: 'var(--accent)' }
                              : { background: 'var(--bg)', borderColor: 'var(--border)',
                                  color: 'var(--text-muted)' }}>
                      {on && '✓ '}{mm.name}
                    </button>
                  )
                })}
              {(members.data ?? []).length === 0 && (
                <span className="text-[12.5px]" style={{ color: 'var(--text-subtle)' }}>
                  No teammates to invite.
                </span>
              )}
            </div>
          </Field>

          <Field label="Notes" hint="Optional">
            <textarea value={description} onChange={e => setDescription(e.target.value)}
                      rows={2} className={inputCls}
                      style={{ ...inputStyle, resize: 'none' }}
                      placeholder="Agenda, links, anything to remember" />
          </Field>

          {err && <p className="text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}

          <div className="flex gap-2 pt-1">
            <Button type="submit" variant="primary" loading={busy}
                    disabled={!title.trim() || !date || !from} className="flex-1">
              {creating ? 'Create meeting' : 'Save changes'}
            </Button>
            <Button type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </div>
    </Portal>
  )
}
