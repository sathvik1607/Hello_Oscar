import { useEffect, useRef, useState } from 'react'
import { Users, X } from 'lucide-react'
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
export function NewTaskSheet({
  onClose, onCreated, task, seedDate, seedTime, seedAssignee, everyone, personalWhenSelf,
}: {
  onClose: () => void
  onCreated: () => void
  /** Present = edit that task. Absent = create a new one. */
  task?: Task | null
  /** Who to pre-select, when the opening screen already has a person in view — My
   *  Team with a member picked. Same reasoning as `seedDate`: the filter you are
   *  looking at IS the intent, and making you re-pick it is a step that can only go
   *  wrong. Ignored when editing, which seeds from the task's own assignee. */
  seedAssignee?: number | null
  /** "YYYY-MM-DD" (IST) to open the date field on. Passed by a screen that already
   *  has a day in view — Today, or a picked day on the calendar — so a task created
   *  from there lands on the day the user was looking at rather than silently on
   *  whatever today happens to be. Ignored when editing, which carries its own. */
  seedDate?: string | null
  /** "HH:MM" (IST) to open the time field on, and to force priority to `critical` —
   *  a normal task has no time field at all, so a seeded time with no matching
   *  priority would be silently invisible. Only meaningful together with `seedDate`;
   *  passed by Today when the user has actually touched its own time box, not on
   *  its unset default (see TodayScreen). Ignored when editing. */
  seedTime?: string | null
  /**
   * The ids an "Everyone" chip would reach, if offered at all. Present only for a
   * team lead looking at the whole workspace (My Team, nobody narrowed) — everyone
   * else never sees the chip, so this is `null`/absent for them rather than a
   * permission check inside this form. Absent, empty, or editing an existing task
   * ⇒ no chip, ordinary single-assignee picker only.
   *
   * 🔴 PICKING IT DOES NOT ASSIGN A SHARED TASK — it is a switch, not a selection.
   * `broadcasting` (below) is what the picker and submit actually key off; see
   * there for why a task addressed to everyone becomes N individual tasks.
   */
  everyone?: number[] | null
  /**
   * 🔴 TODAY ONLY — a self-assigned task created here is PERSONAL (`is_project:
   * false`), not the usual "every new task is a team task" default. Today is where
   * you jot down your own next thing, not where you publish to the team board, and
   * the two screens disagreeing on this is deliberate: My Team is never opened to
   * create work for yourself in the first place, so it keeps the old default
   * unconditionally. Has no effect once `delegated` is true (self-assigned is the
   * only case this changes) or while editing (an existing task keeps its own
   * value, same as `isProject` below).
   */
  personalWhenSelf?: boolean
}) {
  const editing = Boolean(task)
  // Seeded from the task when editing. `due_at` arrives IST-naive
  // ("2026-08-24 18:30:00"), so it is SPLIT on the literal characters rather than
  // parsed into a Date — new Date(...) would apply the browser's offset and shift
  // the time the user sees by hours.
  const seededDate = task?.due_at ? task.due_at.slice(0, 10) : (seedDate ?? null)
  const seededTime = task?.due_at ? task.due_at.slice(11, 16) : (seedTime ?? null)
  const me = getUser()
  /**
   * Who the task is FOR — exactly one person, never a shared roster, UNLESS
   * "Everyone" is picked (see `broadcasting`). The form had no assignee field at
   * all once, so every task created from the web was silently self-assigned; a
   * lead could not hand work to anyone without asking Oscar to do it in words.
   * `pa_item_assignees` can hold more than one person per task, but a task shared
   * across several people is not what a normal pick builds any more — "Everyone"
   * reaches several people by creating several ordinary single-assignee tasks
   * instead, not one shared one (see submit()).
   *
   * 🔴 PICKED FROM THE TEAM, never typed. Task assignee resolution is team-scoped,
   * but the agent's MEETING invitee resolution is not, and this project already has
   * a wrong-person incident from loose name matching. Sending an id from a list of
   * actual members removes the question entirely.
   */
  const members = useApi(s => (me?.team_id ? teamApi.members(me.team_id, s) : Promise.resolve([])),
                         [me?.team_id])
  /** Is "Everyone" the current pick? A chip like any other in the picker, not a
   *  separate mode the caller has to reach for — toggling it just replaces
   *  `assignee` the same way picking a person does. */
  const [broadcasting, setBroadcasting] = useState(false)
  const [assignee, setAssignee] = useState<number | null>(() => {
    // Seeded from the task's own assignee when editing.
    if (task) return task.assigned_to_user_id ?? null
    // A screen that already has somebody selected passes them, and that wins over
    // the self default — on My Team with a member picked, the task is for THEM.
    if (seedAssignee != null) return seedAssignee
    // 🔴 A NEW TASK STARTS ASSIGNED TO YOU, VISIBLY. `null` already MEANT
    // self-assigned — create_item self-assigns when no assignee is given — but
    // nothing on the form said so: every teammate chip sat unselected, so the
    // honest reading was "assigned to nobody", and the most common action (a task
    // for yourself) was the one with no visible state. Pre-selecting says what will
    // happen, and deselecting yourself still resolves to you server-side.
    return me?.id ?? null
  })
  /** Is this task going to someone OTHER than me? Yourself-only is not delegation,
   *  and conflating the two is what would silently turn every personal task into a
   *  team one now that you are pre-selected. "Everyone" is always delegation —
   *  it is, by definition, work for people other than just you. */
  const delegated = broadcasting || (assignee != null && assignee !== me?.id)
  /**
   * Project task (default) vs personal — the same switch the Flutter sheet has, and
   * the web form simply never sent the field, so every task created here was a
   * PROJECT task whether you wanted it or not. `is_project=0` hides it from
   * `GET /teams/{id}/tasks?project=true`, which is My Team.
   */
  /**
   * A project (team) task by default. The form no longer offers the choice — see
   * the "Team task" row below — so this is a derived constant rather than state.
   *
   * 🔴 EDITING KEEPS THE TASK'S OWN VALUE. A personal task created before this
   * change, or by Flutter (which still has the switch), must not be silently
   * published to the team board just because someone fixed its title here.
   *
   * A NEW task defaults to true UNLESS `personalWhenSelf` opted in (Today) and
   * this particular new task is self-assigned — see that prop's own comment for
   * why My Team never takes this branch.
   */
  const isProject = task
    ? (task.is_project !== 0 && task.is_project !== false)
    : !(personalWhenSelf && !delegated)
  const [title, setTitle] = useState(task?.title ?? '')
  const [date, setDate] = useState(seededDate ?? istDateKey(istNow()))
  const [time, setTime] = useState(seededTime ?? defaultTime())
  // TWO tiers on the wire. The legacy words are still ACCEPTED by the backend
  // (services/priority.py aliases high→critical, medium/low→normal), which is what
  // lets an old build keep working — but a current build should send the honest
  // names, and an existing task may still carry a legacy one, so normalise on read.
  const [priority, setPriority] = useState<'normal' | 'critical'>(() => {
    if (task) return task.priority === 'critical' || task.priority === 'high' ? 'critical' : 'normal'
    // A seeded time has nowhere to show on a `normal` task (no time field at all),
    // so a time the user actually picked on Today must switch the form to the one
    // tier that keeps it.
    return seedTime ? 'critical' : 'normal'
  })
  // An "anytime" task: due on a DAY, at no particular time. This is the real
  // representation — a null due_at is NOT (POST /items rejects it, and a dateless
  // task falls out of every date-grouped view including Today).
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
      // 🔴 NORMAL ⇒ ALL-DAY, derived rather than asked. There is no time field on a
      // normal task any more, so there is no hour to store — 23:59 is the
      // placeholder that records the DAY, and is_all_day is what marks it as a
      // placeholder rather than a deadline. Critical is the inverse: it always
      // carries the real time, and is_all_day on it is impossible (the backend
      // coerces the pair, because a critical task with no hour has nothing to
      // remind against).
      const isAnytime = priority !== 'critical'
      const due_at = isAnytime ? `${date}T23:59:00` : `${date}T${time}:00`
      if (task) {
        // Description is sent even when EMPTY, unlike on create: clearing a
        // description is a legitimate edit, and omitting the key would silently
        // leave the old text in place.
        await tasksApi.update(task.id, {
          title: t, due_at, priority, is_all_day: isAnytime,
          description: description.trim(),
          // 🔴 Singular, not the list. PATCH /items {assigned_to_user_id} is the
          // path that reconciles pa_item_assignees through set_assignees — sending
          // the plural here would move the legacy column and leave the roster
          // stale, which is the documented "reassignment did nothing" bug.
          ...(assignee != null ? { assigned_to_user_id: assignee } : {}),
        })
      } else {
        const base = {
          title: t,
          ...(description.trim() ? { description: description.trim() } : {}),
          due_at,
          priority,
          is_all_day: isAnytime,
          // 🔴 DELEGATED ⇒ ALWAYS A PROJECT TASK. Handing work to a teammate is
          // team work by definition, and a personal task assigned to someone else
          // would be invisible to the lead who has to track it.
          is_project: delegated ? true : isProject,
        }
        if (broadcasting && everyone?.length) {
          // 🔴 N SEPARATE CREATES, SEQUENTIAL — not one call with every id, and not
          // Promise.all. Each is a real write against a shared backend, and firing
          // them in parallel is how you get a handful of silent timeouts on a cold
          // instance with no way to tell which member never got their task. One
          // failure is surfaced and stops the loop rather than being swallowed —
          // a lead who asked for "everyone" needs to know if only six of nine
          // actually got a task, not a generic success toast.
          for (const id of everyone) {
            await tasksApi.create({ ...base, assigned_to_user_id: id })
          }
        } else {
          await tasksApi.create({
            ...base,
            // Omitted when unset so the backend's own self-assign default applies,
            // rather than this client deciding what "nobody" means.
            ...(assignee != null ? { assigned_to_user_id: assignee } : {}),
          })
        }
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
        className="rise fixed inset-x-0 bottom-0 z-[71] rounded-t-3xl border-t p-4
                   sm:inset-0 sm:m-auto sm:h-fit sm:max-w-md sm:rounded-2xl sm:border"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)',
                 paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
      >
        <div className="mb-3.5 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">{editing ? 'Edit task' : 'New task'}</h2>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </div>

        {/* space-y-3, not 4. Eight stacked fields multiply a gap: the sheet was
            taller than a phone viewport, so Create sat below the fold on the one
            screen whose entire job is a single button press. Nothing shrank except
            the air between rows. */}
        <form onSubmit={submit} className="space-y-3">
          <Field label="Title">
            <input ref={titleRef} value={title} onChange={e => setTitle(e.target.value)}
                   className={inputCls} style={inputStyle}
                   placeholder="What needs to be done?" />
          </Field>

          {/* SECOND, directly under Title. These are the two fields you TYPE; the
              rest are pickers you tap. Description used to sit last, below the
              Project toggle, so describing the thing you had just named meant
              scrolling past every scheduling control — and on a phone the textarea
              was below the fold entirely, which is why it read as optional in a way
              the label already says better. Date/priority/assignee keep their order
              after it: what the task IS, then when and who. */}
          <Field label="Description">
            <textarea value={description} onChange={e => setDescription(e.target.value)}
                      /* 2 rows, not 3. It is optional and usually a line — an
                         empty box the height of three cost more than it gave, and
                         it grows on focus below. */
                      rows={2} placeholder="Add details (optional)"
                      className={cx(inputCls, 'resize-none leading-relaxed')}
                      style={inputStyle} />
          </Field>

          {/* 🔴 NO TIME FIELD ON A NORMAL TASK. Priority here is scheduler
              BEHAVIOUR, not a label: `critical` gets exactly one reminder at T-15
              and is the only tier that alerts at all, while `normal` gets none,
              ever. So a time on a normal task is a value nothing acts on — it
              cannot produce a reminder, and it makes the row claim an hour the user
              was never going to be held to. Asking for it invited the reasonable
              assumption that setting it would do something.
              Critical keeps the field, and REQUIRES it: the API rejects a critical
              task with no due_at. */}
          {priority === 'critical' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date">
                <input type="date" value={date} required
                       onChange={e => setDate(e.target.value)}
                       className={inputCls} style={inputStyle} />
              </Field>
              <Field label="Time">
                <input type="time" value={time} required
                       onChange={e => setTime(e.target.value)}
                       className={inputCls} style={inputStyle} />
              </Field>
            </div>
          ) : (
            <Field label="Date">
              <input type="date" value={date} required
                     onChange={e => setDate(e.target.value)}
                     className={inputCls} style={inputStyle} />
            </Field>
          )}

          {/* The "Anytime" checkbox is GONE — it is now derived from priority. It
              asked the user to state something the priority already decides: normal
              has no time field, so it is anytime by construction, and critical
              always carries a real hour. Two controls for one fact meant they could
              disagree (critical + anytime is impossible and the backend coerces it),
              and the checkbox was the half with no consequence. */}
          {/* The hint is the literal scheduler behaviour, and it was wrong before:
              it promised a reminder 30 minutes ahead and another once overdue.
              Neither exists — the advance ping is T-15, and BOTH overdue checks are
              commented out of the scheduler loop, so nothing fires after a due time
              at any priority. Critical is also the only tier that alerts at all. */}
          <Field label="Priority"
                 hint={priority === 'critical'
                   ? 'One reminder 15 minutes before the time you set.'
                   : 'No time and no reminder — it just belongs to that day.'}>
            <div className="flex gap-1.5">
              {(['normal', 'critical'] as const).map(p => (
                <button key={p} type="button" onClick={() => setPriority(p)}
                        className="flex-1 rounded-lg border py-1.5 text-[13px] font-medium capitalize transition"
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
          <Field label="Assign to"
                 hint={broadcasting
                   ? `${everyone?.length ?? 0} separate tasks will be created, one per member`
                   : undefined}>
            <div className="flex flex-wrap gap-1.5">
              {/* 🔴 A CHIP, NOT A SEPARATE CONTROL — offered only to a team lead
                  looking at the whole workspace (see `everyone` above), and it sits
                  FIRST so picking the whole team reads as one more option in the
                  same list rather than a special second step. Picking it does not
                  select an assignee; it flips `broadcasting`, which is what submit()
                  actually keys off to loop N individual creates instead of sending
                  one. */}
              {everyone?.length ? (
                <button type="button" title="Everyone"
                        onClick={() => { setBroadcasting(v => !v); setAssignee(null) }}
                        className="rounded-full border px-2.5 py-1 text-[12.5px]
                                   transition hover:brightness-95"
                        style={broadcasting
                          ? { background: 'var(--accent)', color: '#fff',
                              borderColor: 'var(--accent)' }
                          : { background: 'var(--bg)', borderColor: 'var(--border)',
                              color: 'var(--text-muted)' }}>
                  {broadcasting && '✓ '}Everyone
                </button>
              ) : null}
              {(members.data ?? [])
                .filter(mm => mm.is_active)
                .map(mm => {
                  const on = !broadcasting && assignee === mm.user_id
                  return (
                    <button key={mm.user_id} type="button"
                            title={mm.name}
                            // Single-select: picking someone else REPLACES the
                            // current pick rather than adding to it — a task has
                            // one owner. Tapping the already-picked one clears
                            // it back to unassigned rather than being a no-op,
                            // so there is still a way to reach "nobody" without
                            // a separate control for it. Picking a person also
                            // turns "Everyone" back off, same as the reverse.
                            onClick={() => {
                              setBroadcasting(false)
                              setAssignee(v => v === mm.user_id ? null : mm.user_id)
                            }}
                            className="rounded-full border px-2.5 py-1 text-[12.5px]
                                       transition hover:brightness-95"
                            style={on
                              ? { background: 'var(--accent)', color: '#fff',
                                  borderColor: 'var(--accent)' }
                              : { background: 'var(--bg)', borderColor: 'var(--border)',
                                  color: 'var(--text-muted)' }}>
                      {/* FIRST NAME only. "Dushyanth Ammanabrolu" and "Shiva Kumar
                          Karanam" made single chips almost as wide as the sheet, so
                          eight members wrapped to three rows and pushed Create off
                          screen. No ambiguity is introduced: these are picked from a
                          list, not typed, and the id is what gets sent — this is a
                          label, not a lookup key. Full name stays in the title
                          attribute for the duplicate-first-name case. */}
                      {on && '✓ '}
                      {mm.user_id === me?.id ? 'Me' : (mm.name?.split(' ')[0] ?? mm.name)}
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

          {/* A statement, not a switch — the form no longer offers a Project/
              Personal toggle, so this just SAYS what submit's own
              `delegated ? true : isProject` is actually about to send. Shown for
              every combination now, delegated included: picking a teammate on
              Today is exactly the case that needs the confirmation, since a
              self-assigned task there is personal (see `personalWhenSelf`) and
              a silent row would leave "did picking them just make this a team
              task?" unanswered. Only hidden while editing — an existing task's
              own is_project is not something this row should be restating as
              if it were a fresh decision. */}
          {!task && (
            <div className="flex w-full items-center gap-2.5 rounded-xl border px-3 py-2"
                 style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
              <Users className="size-4 shrink-0" style={{ color: 'var(--text-subtle)' }} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13.5px] font-medium">
                  {delegated || isProject ? 'Team task' : 'Personal task'}
                </span>
                <span className="block text-[12px]" style={{ color: 'var(--text-subtle)' }}>
                  {delegated || isProject ? 'Shared with your team' : 'Only visible to you'}
                </span>
              </span>
            </div>
          )}

          {err && <p className="text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}

          <div className="flex gap-2 pt-1">
            <Button type="submit" variant="primary" loading={busy}
                    disabled={!title.trim()} className="flex-1">
              {editing ? 'Save changes'
                : broadcasting ? `Create for everyone (${everyone?.length ?? 0})`
                : 'Create task'}
            </Button>
            <Button type="button" onClick={onClose}>Cancel</Button>
          </div>
        </form>
      </div>
    </Portal>
  )
}

/** The next round half-hour, in IST. A default of "now" produces a task that is
 *  overdue the moment it is created and fires a reminder immediately. Exported so
 *  Today's time box (TodayScreen) can default to the same safe value instead of
 *  duplicating the IST rounding. */
export function defaultTime(): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
  }).format(new Date())
  const [h, m] = parts.split(':').map(Number)
  const bumped = m < 30 ? { h, m: 30 } : { h: (h + 1) % 24, m: 0 }
  return `${String(bumped.h).padStart(2, '0')}:${String(bumped.m).padStart(2, '0')}`
}
