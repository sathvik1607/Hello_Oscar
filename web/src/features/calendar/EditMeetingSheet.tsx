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
  /**
   * DURATION, not a bare end time — the mobile sheet picks a length (30m/45m/1h/
   * Custom) rather than asking for a second clock reading, and a length is what
   * most meetings actually are ("half an hour with Anil"), not a specific end
   * clock time somebody is choosing on purpose. `custom` is the escape hatch
   * back to a manual end time, which is all the form offered before this.
   *
   * Seeded from the ACTUAL gap when editing, snapped to the nearest quick pick
   * only if it lands exactly on one — an odd 40-minute meeting must not silently
   * relabel itself as 45 the moment you open it to change the title.
   */
  const [duration, setDuration] = useState<'30' | '45' | '60' | 'custom'>(() => {
    if (!startTime || !endTime) return '30'
    const mins = minutesBetween(startTime, endTime)
    return mins === 30 ? '30' : mins === 45 ? '45' : mins === 60 ? '60' : 'custom'
  })
  /** The end time actually SENT — derived from start+duration unless `custom`,
   *  where `to` (the manual field) is the source of truth instead. */
  const effectiveTo = duration === 'custom' ? to : addMinutesTime(from, Number(duration))
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
    // about incorrectly instead of rejecting. Only reachable via Custom now — a
    // quick-pick duration is always computed forward from `from`.
    if (effectiveTo && effectiveTo <= from) {
      setErr('The end time has to be after the start time.')
      return
    }
    setBusy(true); setErr(null)
    try {
      if (creating) {
        // POST /meetings, the endpoint that has existed all along with no UI behind
        // it. Times assembled from the PARTS, exactly as the edit path does.
        // 🔴 NO location/description — this form mirrors mobile's Schedule Meeting
        // screen, which has neither field at all. (An existing meeting created with
        // one some other way, e.g. by the agent, keeps it untouched: this form
        // simply never asks about it.)
        await meetingsApi.create({
          title: t,
          scheduled_at: `${date}T${from}:00`,
          ...(effectiveTo ? { ends_at: `${date}T${effectiveTo}:00` } : {}),
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
        ...(effectiveTo ? { ends_at: `${date}T${effectiveTo}:00` } : {}),
        // 🔴 location/description are NOT sent here either — omitted, not emptied,
        // so editing a meeting that already has one (created some other way) keeps
        // it rather than this form silently blanking it out.
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

          {/* Date and start time on one line — they are one thought. The
              computed range underneath is the same confirmation mobile shows
              in its own header ("Mon, Sep 7" · "5:00 PM – 5:45 PM") — the two
              input boxes are for CHANGING the time, this line is for reading
              back what they currently mean, together with the duration. */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                     className={inputCls} style={inputStyle} />
            </Field>
            <Field label="From">
              <input type="time" value={from} onChange={e => setFrom(e.target.value)}
                     className={inputCls} style={inputStyle} />
            </Field>
          </div>
          {from && effectiveTo && (
            <p className="-mt-2 text-[12.5px]" style={{ color: 'var(--text-subtle)' }}>
              {timeLabel12(from)} – {timeLabel12(effectiveTo)}
            </p>
          )}

          {/* DURATION, not a bare end-time field — mirrors the mobile sheet's
              30m/45m/1h/Custom row. Quick picks compute the end time from `from`
              (see effectiveTo); Custom is the only path that still asks for a
              manual clock reading, and only then does a "To" field appear. The
              computed end time is confirmed by the range line above, not
              repeated here as well. */}
          <Field label="For">
            <div className="flex flex-wrap gap-1.5">
              {(['30', '45', '60'] as const).map(mins => (
                <button key={mins} type="button" onClick={() => setDuration(mins)}
                        className="rounded-full border px-3 py-1.5 text-[12.5px] font-medium
                                   transition hover:brightness-95"
                        style={duration === mins
                          ? { background: 'var(--accent)', color: '#fff',
                              borderColor: 'var(--accent)' }
                          : { background: 'var(--bg)', borderColor: 'var(--border)',
                              color: 'var(--text-muted)' }}>
                  {mins === '60' ? '1h' : `${mins}m`}
                </button>
              ))}
              <button type="button"
                      onClick={() => {
                        // Seeds the manual field from whatever the quick pick was
                        // about to send, so switching to Custom starts from the
                        // same end time rather than snapping back to blank.
                        if (duration !== 'custom') setTo(effectiveTo)
                        setDuration('custom')
                      }}
                      className="rounded-full border px-3 py-1.5 text-[12.5px] font-medium
                                 transition hover:brightness-95"
                      style={duration === 'custom'
                        ? { background: 'var(--accent)', color: '#fff',
                            borderColor: 'var(--accent)' }
                        : { background: 'var(--bg)', borderColor: 'var(--border)',
                            color: 'var(--text-muted)' }}>
                Custom
              </button>
            </div>
          </Field>

          {duration === 'custom' && (
            <Field label="To" hint="Optional">
              <input type="time" value={to} onChange={e => setTo(e.target.value)}
                     className={inputCls} style={inputStyle} />
            </Field>
          )}

          {/* Location was removed here — mobile's Schedule Meeting screen has no
              such field, and this form now mirrors it. An existing meeting with a
              location (set some other way) keeps it; see submit() for why. */}
          <Field label="Other guests" hint="Comma separated · not notified">
            <input value={guests} onChange={e => setGuests(e.target.value)}
                   className={inputCls} style={inputStyle}
                   // Roles, not names. A placeholder that reads like a real person invites
                   // the guess that it IS one — and these names go nowhere near a
                   // notification, so an example that looks like a contact is misleading
                   // twice over.
                   placeholder="Client name, vendor contact" />
          </Field>

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

/** Minutes between two "HH:MM" strings, same-day only (a meeting spanning
 *  midnight isn't a case this form's single date field can express anyway). */
function minutesBetween(from: string, to: string): number {
  const [fh, fm] = from.split(':').map(Number)
  const [th, tm] = to.split(':').map(Number)
  return (th * 60 + tm) - (fh * 60 + fm)
}

/** "HH:MM" + minutes, wrapping past midnight — used to compute a duration
 *  quick-pick's end time from the start time. */
function addMinutesTime(hhmm: string, minutes: number): string {
  const [h, m] = hhmm.split(':').map(Number)
  const total = (h * 60 + m + minutes + 1440) % 1440
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

/** "HH:MM" → "5:00 pm" — a plain string transform, deliberately NOT built on a
 *  Date (this file's own rule: these values are IST-naive parts, and routing
 *  them through `new Date(...)`/timeLabel would risk the browser's own offset
 *  getting applied to a value that never had one). */
function timeLabel12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const period = h < 12 ? 'am' : 'pm'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}
