import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { ApiError, tasks as tasksApi, team as teamApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { getUser } from '../../lib/session'
import { istDateKey, istNow } from '../../lib/format'
import { Button, Field, IconButton, Portal, cx, inputCls, inputStyle } from '../../ui'
import type { Task } from '../../lib/types'

/**
 * Create OR EDIT a task by hand.
 *
 * Oscar is the better path for most of these ("remind me to call the supplier at
 * 4"), and this exists for the case Oscar is worse at: you already know exactly
 * what you want and typing it is faster than saying it. So it is deliberately
 * small — title, when, priority — rather than a mirror of every field the API
 * accepts.
 *
 * ONE FORM, TWO MODES. Editing reuses this rather than getting its own sheet,
 * because the interesting part is the date/time handling below — duplicating it
 * would mean two places to get IST wrong, and only one of them would be tested.
 *
 * 🔴 `due_at` is sent IST-NAIVE. The backend stores these digits verbatim with no
 * timezone, so sending an ISO string with a Z would land the task hours off — and
 * a due time in the past is born overdue, which fires a reminder immediately.
 */
export function NewTaskSheet({ onClose, onCreated, task }: {
  onClose: () => void
  onCreated: () => void
  /** Present = edit that task. Absent = create a new one. */
  task?: Task | null
}) {
  const editing = Boolean(task)
  // Seeded from the task when editing. `due_at` arrives IST-naive
  // ("2026-08-24 18:30:00"), so it is SPLIT on the literal characters rather than
  // parsed into a Date — new Date(...) would apply the browser's offset and shift
  // the time the user sees by hours.
  const seededDate = task?.due_at ? task.due_at.slice(0, 10) : null
  const seededTime = task?.due_at ? task.due_at.slice(11, 16) : null
  const me = getUser()
  /**
   * Who the task is FOR. The form had no such field, so every task created from
   * the web was silently self-assigned — while `POST /items` has always accepted
   * `assigned_to_user_ids`. A lead could not hand work to anyone without asking
   * Oscar to do it in words.
   *
   * 🔴 PICKED FROM THE TEAM, never typed. Task assignee resolution is team-scoped,
   * but the agent's MEETING invitee resolution is not, and this project already has
   * a wrong-person incident from loose name matching. Sending ids from a list of
   * actual members removes the question entirely.
   *
   * Multi-select because `pa_item_assignees` exists precisely for shared work —
   * each assignee carries their own status, and `is_mine` is true for any of them.
   * Empty means self-assigned, which is what happens today.
   */
  const members = useApi(s => (me?.team_id ? teamApi.members(me.team_id, s) : Promise.resolve([])),
                         [me?.team_id])
  const [assignees, setAssignees] = useState<number[]>(() => {
    // Seeded from the roster when editing, so saving a retitle cannot drop who is
    // on it. Falls back to the primary for a task with no roster rows.
    const roster = (task?.assignees ?? []).map(a => a.user_id).filter(Boolean)
    if (roster.length) return roster
    return task?.assigned_to_user_id ? [task.assigned_to_user_id] : []
  })
  /**
   * Project task (default) vs personal — the same switch the Flutter sheet has, and
   * the web form simply never sent the field, so every task created here was a
   * PROJECT task whether you wanted it or not. `is_project=0` hides it from
   * `GET /teams/{id}/tasks?project=true`, which is My Team.
   */
  const [isProject, setIsProject] = useState(task?.is_project !== 0 && task?.is_project !== false)
  const [title, setTitle] = useState(task?.title ?? '')
  const [date, setDate] = useState(seededDate ?? istDateKey(istNow()))
  const [time, setTime] = useState(seededTime ?? defaultTime())
  // TWO tiers on the wire. The legacy words are still ACCEPTED by the backend
  // (services/priority.py aliases high→critical, medium/low→normal), which is what
  // lets an old build keep working — but a current build should send the honest
  // names, and an existing task may still carry a legacy one, so normalise on read.
  const [priority, setPriority] = useState<'normal' | 'critical'>(
    task?.priority === 'critical' || task?.priority === 'high' ? 'critical' : 'normal')
  // An "anytime" task: due on a DAY, at no particular time. This is the real
  // representation — a null due_at is NOT (POST /items rejects it, and a dateless
  // task falls out of every date-grouped view including Today).
  const [allDay, setAllDay] = useState<boolean>(!!task?.is_all_day)
  const [description, setDescription] = useState(task?.description ?? '')
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
    if (!t || busy) return
    setBusy(true); setErr(null)
    try {
      // Built from the date/time PARTS rather than parsed out of a Date, so the
      // browser's timezone never enters the value.
      // Built from the date/time PARTS, so the browser's timezone never enters
      // the value. IST-naive is what the backend stores.
      // An anytime task still carries a due_at — it names the day. 23:59 matches the
      // sentinel the rest of the product already uses for "end of this day", and
      // is_all_day is what tells the client (and the scheduler) that the time is a
      // placeholder rather than a deadline somebody chose.
      const due_at = allDay ? `${date}T23:59:00` : `${date}T${time}:00`
      if (task) {
        // Description is sent even when EMPTY, unlike on create: clearing a
        // description is a legitimate edit, and omitting the key would silently
        // leave the old text in place.
        await tasksApi.update(task.id, {
          title: t, due_at, priority, is_all_day: allDay,
          description: description.trim(),
          // 🔴 Singular, not the list. PATCH /items {assigned_to_user_id} is the
          // path that reconciles pa_item_assignees through set_assignees — sending
          // the plural here would move the legacy column and leave the roster
          // stale, which is the documented "reassignment did nothing" bug.
          ...(assignees.length === 1 ? { assigned_to_user_id: assignees[0] } : {}),
        })
      } else {
        await tasksApi.create({
          title: t,
          ...(description.trim() ? { description: description.trim() } : {}),
          due_at,
          priority,
          is_all_day: allDay,
          // Omitted when empty so the backend's own self-assign default applies,
          // rather than this client deciding what "nobody" means.
          ...(assignees.length ? { assigned_to_user_ids: assignees } : {}),
          // 🔴 DELEGATED ⇒ ALWAYS A PROJECT TASK, mirroring the Flutter sheet
          // (`_assigneeId == null ? _isProject : true`). Handing work to a teammate is
          // team work by definition, and a personal task assigned to someone else
          // would be invisible to the lead who has to track it.
          is_project: assignees.length ? true : isProject,
        })
      }
      onCreated()
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
        role="dialog" aria-modal="true" aria-label={editing ? 'Edit task' : 'New task'}
        className="rise fixed inset-x-0 bottom-0 z-[71] rounded-t-3xl border-t p-5
                   sm:inset-0 sm:m-auto sm:h-fit sm:max-w-md sm:rounded-2xl sm:border"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)',
                 paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">{editing ? 'Edit task' : 'New task'}</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label="Title">
            <input ref={titleRef} value={title} onChange={e => setTitle(e.target.value)}
                   className={inputCls} style={inputStyle}
                   placeholder="What needs to be done?" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Date">
              <input type="date" value={date} required
                     onChange={e => setDate(e.target.value)}
                     className={inputCls} style={inputStyle} />
            </Field>
            <Field label="Time">
              <input type="time" value={time} required={!allDay} disabled={allDay}
                     onChange={e => setTime(e.target.value)}
                     className={inputCls}
                     style={{ ...inputStyle, ...(allDay ? { opacity: .45 } : {}) }} />
            </Field>
          </div>

          {/* "Anytime" — the DATE stays required, only the clock time goes away.
              `due_at` itself is still always sent (POST /items rejects null), so
              this is not the "no time" option that used to fail: the day is carried
              as 23:59 and `is_all_day` marks that as a placeholder. */}
          <label className="flex cursor-pointer items-center gap-2.5 text-[13px]">
            <input type="checkbox" checked={allDay}
                   onChange={e => setAllDay(e.target.checked)}
                   className="size-4 shrink-0 accent-[var(--accent)]" />
            <span style={{ color: 'var(--text-muted)' }}>
              Anytime that day — no particular time
            </span>
          </label>

          {/* The hint is the literal scheduler behaviour, and it was wrong before:
              it promised a reminder 30 minutes ahead and another once overdue.
              Neither exists — the advance ping is T-15, and BOTH overdue checks are
              commented out of the scheduler loop, so nothing fires after a due time
              at any priority. Critical is also the only tier that alerts at all. */}
          <Field label="Priority"
                 hint={allDay
                   ? 'An anytime task gets no reminder — there is no time to remind you at.'
                   : 'Critical gets one reminder 15 minutes ahead. Normal gets none.'}>
            <div className="flex gap-1.5">
              {(['normal', 'critical'] as const).map(p => (
                <button key={p} type="button" onClick={() => setPriority(p)}
                        className="flex-1 rounded-lg border py-2 text-[13px] font-medium capitalize transition"
                        style={priority === p
                          ? { background: 'var(--accent-soft)', borderColor: 'var(--accent)',
                              color: 'var(--accent)' }
                          : { background: 'var(--bg)', borderColor: 'var(--border)',
                              color: 'var(--text-muted)' }}>
                  {p}
                </button>
              ))}
            </div>
          </Field>

          {/* `description` — the real column on pa_items, the one the agent writes
              and PATCH /items reads. Never required: the title IS the task. This is
              for when a title alone loses something — an address, a spec, what
              "follow up" actually meant. Same wording and shape as the Flutter
              sheet, so the two clients do not name one field two ways. */}
          <Field label="Assign to" hint="Leave empty to keep it yourself">
            <div className="flex flex-wrap gap-1.5">
              {(members.data ?? [])
                .filter(mm => mm.is_active)
                .map(mm => {
                  const on = assignees.includes(mm.user_id)
                  return (
                    <button key={mm.user_id} type="button"
                            onClick={() => setAssignees(v => on
                              ? v.filter(x => x !== mm.user_id)
                              : [...v, mm.user_id])}
                            className="rounded-full border px-3 py-1.5 text-[12.5px]
                                       transition hover:brightness-95"
                            style={on
                              ? { background: 'var(--accent)', color: '#fff',
                                  borderColor: 'var(--accent)' }
                              : { background: 'var(--bg)', borderColor: 'var(--border)',
                                  color: 'var(--text-muted)' }}>
                      {on && '✓ '}{mm.user_id === me?.id ? 'Me' : mm.name}
                    </button>
                  )
                })}
              {(members.data ?? []).length === 0 && (
                <span className="text-[12.5px]" style={{ color: 'var(--text-subtle)' }}>
                  No team — this task will be yours.
                </span>
              )}
            </div>
          </Field>

          {/* Hidden once the task is delegated — the choice is irrelevant there, and
              offering a switch that cannot change the outcome is worse than none.
              Flutter hides it on the same condition. */}
          {assignees.length === 0 && (
            <button type="button" onClick={() => setIsProject(v => !v)}
                    className="flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition"
                    style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">
                  {isProject ? 'Project task' : 'Personal task'}
                </span>
                <span className="block text-[12px]" style={{ color: 'var(--text-subtle)' }}>
                  {isProject ? 'Shared with your team' : 'Only for you'}
                </span>
              </span>
              {/* A switch, not a checkbox: it is two named states, not an option you
                  tick. Same reading as the mobile SwitchListTile. */}
              <span className="relative h-[22px] w-[38px] shrink-0 rounded-full transition"
                    style={{ background: isProject ? 'var(--accent)' : 'var(--border-strong)' }}>
                <span className="absolute top-[3px] size-4 rounded-full bg-white transition-all"
                      style={{ left: isProject ? '19px' : '3px' }} />
              </span>
            </button>
          )}

          <Field label="Description">
            <textarea value={description} onChange={e => setDescription(e.target.value)}
                      rows={3} placeholder="Add details (optional)"
                      className={cx(inputCls, 'resize-none leading-relaxed')}
                      style={inputStyle} />
          </Field>

          {err && <p className="text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}

          <div className="flex gap-2 pt-1">
            <Button type="submit" variant="primary" loading={busy}
                    disabled={!title.trim()} className="flex-1">
              {editing ? 'Save changes' : 'Create task'}
            </Button>
            <Button type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </div>
    </Portal>
  )
}

/** The next round half-hour, in IST. A default of "now" produces a task that is
 *  overdue the moment it is created and fires a reminder immediately. */
function defaultTime(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  }).format(new Date())
  const [h, m] = parts.split(':').map(Number)
  const bumped = m < 30 ? { h, m: 30 } : { h: (h + 1) % 24, m: 0 }
  return `${String(bumped.h).padStart(2, '0')}:${String(bumped.m).padStart(2, '0')}`
}
