import { useMemo, useState } from 'react'
import {
  closestCenter, DndContext, DragOverlay, PointerSensor, useDraggable, useDroppable,
  useSensor, useSensors, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core'
import { GripVertical } from 'lucide-react'
import { tasks as tasksApi, ApiError } from '../../lib/api'
import { isReallyOverdue, istDateKey, istNow } from '../../lib/format'
import type { Task } from '../../lib/types'
import { Badge, cx, STATUS_LABEL } from '../../ui'

/**
 * Today's "Edit mode" — a day-view time axis, mirroring the mobile app's own
 * hold-and-drag reschedule (`Edit mode · Hold and drag a task to change…`).
 *
 * A ROW PER HALF-HOUR, 6 AM–10 PM by default — but that is an OUTER bound, not
 * a fixed range shown regardless of what's on the day. See buildSlots for the
 * actual rule: leading empty rows before the first task are trimmed (a day
 * whose first task is at 10 AM starts the grid at 10 AM, not 6), and a task
 * genuinely after 10 PM extends the grid rather than being clipped.
 *
 * Multiple tasks landing in the same slot sit in one HORIZONTALLY SCROLLING
 * row rather than stacking taller — a bucket is a fixed-height lane on
 * purpose, so the grid's vertical rhythm (one row = one half hour) never
 * distorts around a busy slot. `overflow-x-auto` is new to this codebase
 * (grepped: no precedent existed), so it stays local to the row rather than
 * introducing a pattern elsewhere.
 *
 * Dragging changes ONLY the time-of-day, never the day — a slot is `HH:MM`
 * and the drop handler keeps the task's existing due DATE, splicing in just
 * the new time. Moving a task to a different day is what the full edit form
 * (date field) is for.
 */
export function TimelineEditor({ tasks, anytimeTasks, day, onChanged }: {
  /** The day's TIMED tasks only — same list `TodayScreen` already computes as
   *  `shownTimed`. */
  tasks: Task[]
  /**
   * The day's ANYTIME tasks (`shownAnytime`) — rendered as their own
   * horizontal strip ABOVE the grid, draggable into a time row exactly like a
   * timed task is draggable between rows. Dropping one here is a real state
   * change, not just a reschedule: an anytime task has no time BECAUSE it is
   * `normal` priority (the only tier the backend allows to go dateless), so
   * landing it on a slot also raises it to `critical` — the one tier that can
   * actually hold a time — in the same PATCH. See handleDragEnd.
   */
  anytimeTasks: Task[]
  /** "YYYY-MM-DD" — the day being edited, so a drop can rebuild `due_at` from
   *  this DATE plus the target slot's TIME. */
  day: string
  onChanged: () => void
}) {
  const [busyId, setBusyId] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  // Optimistic local override: which slot a just-dropped task is shown in
  // BEFORE the reload confirms it. Keyed by task id → "HH:MM". Cleared once
  // `tasks` itself reflects the move (the parent's reload lands) or on
  // rollback.
  const [pending, setPending] = useState<Map<number, string>>(new Map())
  /**
   * 🔴 THE ROW BEING DRAGGED, RENDERED IN A SEPARATE OVERLAY — not moved via
   * CSS transform in place. Every slot row scrolls horizontally
   * (`overflow-x-auto`), which clips anything a plain transform pushes past
   * its own bounds — dragging DOWN into a different row made the chip
   * disappear the instant it crossed that boundary, because the browser was
   * still clipping it to the row it started in. `DragOverlay` renders through
   * a portal at the document root, so the chip that follows the pointer is
   * never a child of any row's scroll container in the first place.
   */
  const [draggingTask, setDraggingTask] = useState<Task | null>(null)
  /** Anytime task ids just dropped into the grid — optimistically pulled out
   *  of the anytime bar and shown in their new slot immediately, same
   *  reasoning as `pending` for a timed task's reschedule. Cleared once
   *  `anytimeTasks` itself no longer contains the id (the parent's reload
   *  landed — the row really did become `critical` and left that list) or on
   *  rollback. */
  const [promoted, setPromoted] = useState<Set<number>>(new Set())

  const slotOf = (t: Task) => pending.get(t.id) ?? (t.due_at ? t.due_at.slice(11, 16) : null)
  const allDraggable = useMemo(
    () => [...tasks, ...anytimeTasks.filter(t => !promoted.has(t.id))],
    [tasks, anytimeTasks, promoted])

  /** A slot in the PAST — only meaningful when `day` IS today; a future day
   *  being edited has no "past" hours relative to right now. `istNow()` is a
   *  real Date pointing at the current instant, but `.getHours()`/
   *  `.getMinutes()` on it read the BROWSER's own local clock, not IST — the
   *  same trap this whole codebase's naive-IST convention exists to avoid —
   *  so the hour/minute come from the same `Intl.DateTimeFormat(..., {
   *  timeZone: 'Asia/Kolkata' })` extraction every other IST-naive read in
   *  this app uses. Re-evaluated on every render (no memo), so a row crossing
   *  into the past while the screen sits open still gets caught. */
  const isToday = day === istDateKey(istNow())
  const isPastSlot = (hhmm: string) => {
    if (!isToday) return false
    const [h, m] = hhmm.split(':').map(Number)
    const [nowH, nowM] = new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
    }).format(new Date()).split(':').map(Number)
    return h * 60 + m < nowH * 60 + nowM
  }

  // The grid shows every TIMED task, plus any anytime task just promoted into
  // it (optimistically, before the reload confirms the priority change).
  const gridTasks = useMemo(
    () => [...tasks, ...anytimeTasks.filter(t => promoted.has(t.id))],
    [tasks, anytimeTasks, promoted])
  const slots = useMemo(() => buildSlots(gridTasks, slotOf), [gridTasks, pending])
  // The bar shows every anytime task NOT yet promoted.
  const barTasks = anytimeTasks.filter(t => !promoted.has(t.id))

  const sensors = useSensors(useSensor(PointerSensor, {
    // A small hold-and-move threshold, not an instant drag — matches the
    // mobile gesture ("hold and drag") closely enough that a stray tap while
    // scrolling the page doesn't accidentally pick a task up.
    activationConstraint: { distance: 8 },
  }))

  function handleDragStart(e: DragStartEvent) {
    setDraggingTask(allDraggable.find(t => t.id === Number(e.active.id)) ?? null)
  }

  async function handleDragEnd(e: DragEndEvent) {
    setDraggingTask(null)
    const taskId = Number(e.active.id)
    const targetSlot = e.over?.id ? String(e.over.id) : null
    if (!targetSlot) return
    // 🔴 A HARD BLOCK, not just a greyed-out row — a drop onto a past slot on
    // TODAY would create a task born overdue, firing its reminder the instant
    // it lands. The row's own disabled styling is a visual hint; this is the
    // actual guard, since a fast drag can still release over a row before its
    // disabled state visually registers.
    if (isPastSlot(targetSlot)) {
      setErr("Can't move a task to a time that's already passed.")
      return
    }
    const task = allDraggable.find(t => t.id === taskId)
    if (!task) return
    // Coming from the anytime bar: it has no slot to compare against, so
    // there is no "unchanged, skip" case the way a timed reschedule has.
    const fromAnytime = anytimeTasks.some(t => t.id === taskId) && !promoted.has(taskId)
    if (!fromAnytime && slotOf(task) === targetSlot) return

    setPending(prev => new Map(prev).set(taskId, targetSlot))
    if (fromAnytime) setPromoted(prev => new Set(prev).add(taskId))
    setBusyId(taskId)
    setErr(null)
    try {
      await tasksApi.update(taskId, {
        due_at: `${day}T${targetSlot}:00`,
        // 🔴 ONLY THE TIER PROMOTION CARRIES A PRIORITY FIELD. An ordinary
        // timed-to-timed drag never sends `priority` — it is already
        // critical (the only tier with a clock position at all), and resending
        // it would be a no-op at best. Only a task ARRIVING from the anytime
        // bar needs the tier actually raised, since `normal` has nowhere on
        // the wire to hold this new due_at — the backend clears is_all_day
        // itself the moment priority becomes critical (see update_item_direct).
        ...(fromAnytime ? { priority: 'critical' } : {}),
      })
      onChanged()
    } catch (e2) {
      // Roll the optimistic slot/promotion back — the reload from onChanged
      // (called only on success) is what would otherwise fix a wrong local
      // guess, so a failed write needs its OWN undo.
      setPending(prev => { const m = new Map(prev); m.delete(taskId); return m })
      if (fromAnytime) setPromoted(prev => { const s = new Set(prev); s.delete(taskId); return s })
      setErr(e2 instanceof ApiError ? e2.message : String(e2))
    } finally {
      setBusyId(null)
    }
  }

  if (slots.length === 0) return null

  return (
    <DndContext sensors={sensors}
                // 🔴 EXPLICIT, NOT THE DEFAULT. dnd-kit's own default
                // (rectIntersection) compares the DRAGGED ELEMENT's whole
                // bounding box against each row's box — and the dragged chip
                // is taller than one row, so it can overlap two or three rows
                // at once and hand the drop to whichever the algorithm found
                // first, not the one actually under the pointer. Confirmed
                // live: two separate drags, dropped at two different rows,
                // both landed on the same wrong slot. closestCenter instead
                // measures from a single point (the pointer/drag origin) to
                // each row's centre, which is unambiguous for a vertical list
                // of rows exactly like this one.
                collisionDetection={closestCenter}
                onDragStart={handleDragStart}
                onDragEnd={e => void handleDragEnd(e)}
                onDragCancel={() => setDraggingTask(null)}>
      {barTasks.length > 0 && (
        <div className="mb-3">
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider"
               style={{ color: 'var(--text-subtle)' }}>
            Anytime · drag onto a time to set one
          </div>
          {/* Not a droppable zone itself — this is a SOURCE only. Dropping
              back onto it isn't wired up, so an anytime task dragged out and
              released elsewhere with no valid target just snaps back via
              dnd-kit's own default (no onDragEnd match, no state change). */}
          <div className="flex gap-2 overflow-x-auto rounded-xl border p-2"
               style={{ borderColor: 'var(--border)', background: 'var(--bg-sunken)' }}>
            {barTasks.map(t => (
              <DraggableTaskChip key={t.id} task={t} busy={busyId === t.id}
                                 hidden={draggingTask?.id === t.id} />
            ))}
          </div>
        </div>
      )}
      <div className="overflow-hidden rounded-xl border" style={{ borderColor: 'var(--border)' }}>
        {slots.map(({ key, label, items }, i) => (
          <SlotRow key={key} slotKey={key} label={label} tasks={items}
                   busyId={busyId} draggingId={draggingTask?.id ?? null}
                   past={isPastSlot(key)} isLast={i === slots.length - 1} />
        ))}
      </div>
      {/* Renders through a portal at the document root — never a descendant
          of any row's `overflow-x-auto` box, so it can move freely across row
          boundaries instead of being clipped by whichever row it started in. */}
      <DragOverlay>
        {draggingTask && <TaskChipContent task={draggingTask} overlay />}
      </DragOverlay>
      {err && <p className="mt-2 text-[13px]" style={{ color: '#DC2626' }}>{err}</p>}
    </DndContext>
  )
}

function SlotRow({ slotKey, label, tasks, busyId, draggingId, past, isLast }: {
  slotKey: string; label: string; tasks: Task[]
  busyId: number | null; draggingId: number | null; past: boolean; isLast: boolean
}) {
  // `disabled` is a REAL guarantee from the library — over this row never
  // fires, so a fast release can't land here even a frame before the
  // handleDragEnd check would catch it. The dimmed styling below is the
  // visible half of the same rule, not a separate one.
  const { setNodeRef, isOver } = useDroppable({ id: slotKey, disabled: past })
  return (
    <div ref={setNodeRef}
         className={cx('flex items-stretch', !isLast && 'border-b')}
         style={{ borderColor: 'var(--border)',
                  background: isOver ? 'var(--accent-soft)' : undefined,
                  opacity: past ? 0.45 : 1 }}>
      <div className="w-16 shrink-0 border-r px-2 py-2.5 text-right text-[11.5px]
                      font-semibold tabular-nums"
           style={{ borderColor: 'var(--border)', color: 'var(--text-subtle)' }}>
        {label}
      </div>
      {/* min-h keeps an empty slot a real, droppable target — a zero-height
          row cannot be dropped onto. */}
      <div className="flex min-h-[52px] flex-1 items-center gap-2 overflow-x-auto p-2">
        {tasks.map(t => (
          <DraggableTaskChip key={t.id} task={t} busy={busyId === t.id}
                             hidden={draggingId === t.id} />
        ))}
        {tasks.length === 0 && (
          <span className="text-[12px]" style={{ color: 'var(--text-subtle)' }}>
            &nbsp;
          </span>
        )}
      </div>
    </div>
  )
}

/** A compact card, not the full TaskCard — a busy slot scrolling five
 *  full-width cards sideways would show a sliver of each rather than a row of
 *  readable ones. Deliberately narrower and shorter; opening the full detail
 *  is what tapping OUTSIDE edit mode is for.
 *
 * 🔴 NO `transform` HERE ANY MORE. The chip that visibly follows the pointer
 * is the separate `DragOverlay` copy (see TimelineEditor); this one just fades
 * out (`hidden`) the moment its drag starts, rather than sliding along a CSS
 * transform that a scrolling row would clip the instant it crossed that row's
 * own edge. */
function DraggableTaskChip({ task, busy, hidden }: {
  task: Task; busy: boolean; hidden: boolean
}) {
  const { attributes, listeners, setNodeRef } = useDraggable({ id: task.id })
  return (
    <div ref={setNodeRef} {...listeners} {...attributes}
         style={{ opacity: hidden ? 0.15 : busy ? 0.5 : 1 }}
         className="cursor-grab active:cursor-grabbing">
      <TaskChipContent task={task} />
    </div>
  )
}

function TaskChipContent({ task, overlay }: { task: Task; overlay?: boolean }) {
  const terminal = task.status === 'completed' || task.status === 'cancelled'
  const overdue = isReallyOverdue(task) && !terminal
  return (
    <div style={{
           borderColor: overdue ? '#DC2626' : 'var(--border)',
           background: 'var(--bg-elevated)',
           boxShadow: overlay ? '0 8px 24px rgba(0,0,0,.25)' : undefined,
         }}
         className={cx('flex w-[168px] shrink-0 items-start gap-1.5 rounded-lg border p-2',
                       terminal && 'opacity-60')}>
      <GripVertical className="mt-0.5 size-3.5 shrink-0" style={{ color: 'var(--text-subtle)' }} />
      <div className="min-w-0 flex-1">
        <div className={cx('truncate text-[12.5px] font-medium leading-snug',
                           terminal && 'line-through')}>
          {task.title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5">
          <Badge tone={task.status}>{STATUS_LABEL[task.status] ?? task.status}</Badge>
        </div>
      </div>
    </div>
  )
}

/** 6 AM–10 PM is the OUTER bound, not a fixed range shown regardless of what's
 *  on the day — the grid still trims LEADING empty rows when the first task
 *  starts later than 6 AM (first task at 10 AM ⇒ the grid starts at 10 AM, not
 *  32 rows of nothing), and it EXTENDS past 10 PM rather than clip a genuine
 *  late task — real data is never dropped to keep the window tidy. So the
 *  actual rule is: start at the LATER of 6 AM and the first task's slot; end
 *  at the LATER of 10 PM and the last task's slot. */
function buildSlots(tasks: Task[], slotOf: (t: Task) => string | null) {
  const DAY_START = 6 * 60   // 6:00 AM
  const DAY_END = 22 * 60    // 10:00 PM

  const withSlot = tasks
    .map(t => ({ task: t, slot: slotOf(t) }))
    .filter((x): x is { task: Task; slot: string } => !!x.slot)

  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return h * 60 + m
  }
  const roundDown = (mins: number) => Math.floor(mins / 30) * 30
  const roundUp = (mins: number) => Math.ceil(mins / 30) * 30

  const allMinutes = withSlot.map(x => toMinutes(x.slot))
  const start = allMinutes.length
    ? Math.max(DAY_START, roundDown(Math.min(...allMinutes)))
    : DAY_START
  const end = allMinutes.length
    ? Math.max(DAY_END, roundUp(Math.max(...allMinutes)))
    : DAY_END

  const byMinute = new Map<number, Task[]>()
  for (const { task, slot } of withSlot) {
    const mins = roundDown(toMinutes(slot))
    const bucket = byMinute.get(mins) ?? []
    bucket.push(task)
    byMinute.set(mins, bucket)
  }

  const out: { key: string; label: string; items: Task[] }[] = []
  for (let mins = start; mins <= end; mins += 30) {
    const hh = String(Math.floor(mins / 60)).padStart(2, '0')
    const mm = String(mins % 60).padStart(2, '0')
    const key = `${hh}:${mm}`
    out.push({ key, label: slotLabel(mins), items: byMinute.get(mins) ?? [] })
  }
  return out
}

/** "9:30", "10 AM", "10:30" — matching the mobile grid's own label style
 *  (the top-of-hour drops the ":00", a half-past keeps it). */
function slotLabel(mins: number): string {
  const h24 = Math.floor(mins / 60)
  const m = mins % 60
  const period = h24 < 12 ? 'AM' : 'PM'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return m === 0 ? `${h12} ${period}` : `${h12}:${String(m).padStart(2, '0')}`
}
