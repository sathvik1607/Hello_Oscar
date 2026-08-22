import { useCallback, useMemo, useState } from 'react'
import {
  CalendarDays, ChevronLeft, ChevronRight, MapPin, Users,
} from 'lucide-react'
import { meetings as meetingsApi, tasks as tasksApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ITEM_CACHES, ITEM_FRAMES, useLiveData } from '../../lib/useLiveData'
import {
  dayLabel, istDateKey, istNow, monthYearLabel, parseIstNaive, timeLabel,
} from '../../lib/format'
import type { Meeting, Task } from '../../lib/types'
import { TaskDetail } from '../tasks/TaskDetail'
import { MeetingDetail } from './MeetingDetail'
import {
  Badge, Button, Card, EmptyState, ErrorState, Skeleton, cx,
} from '../../ui'

/**
 * A MONTH GRID plus the selected day's agenda — the same shape as the Flutter
 * calendar, because a week strip answered a different question.
 *
 * The grid's job is "which days have anything on them", and the dots answer it at a
 * glance. The rules are lifted from the Flutter `_DayCell` rather than reinvented,
 * because they encode a real decision:
 *
 *   green  — an ACTIVE task
 *   blue   — an ACTIVE meeting
 *   grey   — anything completed or cancelled
 *
 * and only THREE dots are drawn, live ones first, with an overflow count. Ordering
 * matters: a day with six finished items and one live one must not hide the live
 * one behind the grey.
 *
 * Weekday columns start on MONDAY (Mo–Su), matching the app. Sunday-first would put
 * the weekend on both ends of the row.
 */
export function CalendarScreen() {
  // The month being viewed, and the day selected inside it — two separate pieces of
  // state. Collapsing them means paging to another month drags the selection along
  // and the agenda changes under you.
  const [monthAnchor, setMonthAnchor] = useState(() => startOfMonth(istNow()))
  const [selectedKey, setSelectedKey] = useState(() => istDateKey(istNow()))
  // A row on the calendar was previously inert, so there was no way to reach a
  // task's description, comments or files from here at all — the calendar showed
  // that something existed and then refused to open it.
  const [openTask, setOpenTask] = useState<Task | null>(null)
  const [openMeeting, setOpenMeeting] = useState<Meeting | null>(null)

  const m = useApi(s => meetingsApi.all(s), [], 'meetings:all')
  const t = useApi(s => tasksApi.mine(s), [], 'tasks:mine')

  // A meeting scheduled by Oscar mid-conversation lands on the calendar while you
  // are looking at it — and a dropped connection is caught up on reconnect.
  useLiveData(ITEM_FRAMES, () => { m.reload(); t.reload() },
              { invalidatePrefixes: ITEM_CACHES })

  // ── index everything by day, once ────────────────────────────────────────
  const byDay = useMemo(() => {
    const map = new Map<string, { tasks: Task[]; meetings: Meeting[] }>()
    const slot = (k: string) => {
      let v = map.get(k)
      if (!v) { v = { tasks: [], meetings: [] }; map.set(k, v) }
      return v
    }
    for (const x of m.data?.meetings ?? []) {
      const at = parseIstNaive(x.scheduled_at)
      if (at) slot(istDateKey(at)).meetings.push(x)
    }
    for (const x of t.data?.tasks ?? []) {
      const at = parseIstNaive(x.due_at)
      // An undated task has no place on a calendar — it appears on Tasks instead,
      // rather than being filed under an arbitrary day.
      if (at) slot(istDateKey(at)).tasks.push(x)
    }
    return map
  }, [m.data, t.data])

  const cells = useMemo(() => monthCells(monthAnchor), [monthAnchor])

  const selected = useMemo(() => {
    const [y, mo, d] = selectedKey.split('-').map(Number)
    return new Date(Date.UTC(y, mo - 1, d, 12) - 0)   // noon, so no TZ edge flips it
  }, [selectedKey])

  const dayRows = useMemo(() => {
    const bag = byDay.get(selectedKey)
    if (!bag) return [] as Row[]
    // Cancelled items are NOT filtered out. `DELETE /items` is a soft delete —
    // status becomes 'cancelled' and the row survives precisely so the calendar
    // can still show that the slot was claimed and then dropped. Hiding them makes
    // a cancelled 3pm meeting indistinguishable from one that never existed, and
    // the Flutter calendar renders them struck through for the same reason.
    const rows: Row[] = [
      ...bag.meetings.map(x => ({
        kind: 'meeting' as const, at: parseIstNaive(x.scheduled_at),
        end: parseIstNaive(x.ends_at), meeting: x })),
      ...bag.tasks.map(x => ({
        kind: 'task' as const, at: parseIstNaive(x.due_at), task: x })),
    ]
    return rows.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))
  }, [byDay, selectedKey])

  const step = useCallback((delta: number) => {
    setMonthAnchor(a => new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + delta, 1, 12)))
  }, [])

  const todayKey = istDateKey(istNow())
  const loading = (m.loading && !m.data) || (t.loading && !t.data)
  const error = m.error ?? t.error
  const viewingThisMonth = istDateKey(monthAnchor).slice(0, 7) === todayKey.slice(0, 7)

  return (
    <div className="space-y-5">
      {/* ── month grid ───────────────────────────────────────────────── */}
      <Card className="p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <button onClick={() => step(-1)} aria-label="Previous month"
                  className="grid size-9 place-items-center rounded-lg"
                  style={{ color: 'var(--text-muted)' }}>
            <ChevronLeft className="size-4" />
          </button>
          <div className="text-sm font-semibold">{monthYearLabel(monthAnchor)}</div>
          <button onClick={() => step(1)} aria-label="Next month"
                  className="grid size-9 place-items-center rounded-lg"
                  style={{ color: 'var(--text-muted)' }}>
            <ChevronRight className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-px">
          {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(l => (
            <div key={l} className="pb-1.5 text-center text-[11px] font-semibold"
                 style={{ color: 'var(--text-subtle)' }}>{l}</div>
          ))}

          {cells.map((cell, i) => {
            if (!cell) {
              // Leading/trailing blanks keep the grid rectangular. Rendering the
              // neighbouring month's numbers here instead invites taps on days the
              // agenda below is not showing.
              return <div key={`b${i}`} className="h-[54px]" />
            }
            const key = cell.key
            const bag = byDay.get(key)
            const isSel = key === selectedKey
            const isToday = key === todayKey
            return (
              <button
                key={key}
                onClick={() => setSelectedKey(key)}
                aria-current={isToday ? 'date' : undefined}
                aria-pressed={isSel}
                className="flex h-[54px] flex-col items-center gap-1 rounded-xl pt-1.5 transition"
                style={isSel
                  ? { background: 'var(--accent)', color: '#fff' }
                  : isToday
                    ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                    : { color: 'var(--text)' }}
              >
                <span className={cx('text-[13px] tabular-nums',
                                    (isSel || isToday) ? 'font-bold' : 'font-medium')}>
                  {cell.day}
                </span>
                <Dots bag={bag} inverted={isSel} />
              </button>
            )
          })}
        </div>

        {!viewingThisMonth && (
          <div className="mt-2 flex justify-center">
            <Button size="sm" variant="ghost"
                    onClick={() => {
                      setMonthAnchor(startOfMonth(istNow()))
                      setSelectedKey(todayKey)
                    }}>
              Back to today
            </Button>
          </div>
        )}
      </Card>

      {/* ── the selected day ─────────────────────────────────────────── */}
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-[15px] font-semibold">
          {selectedKey === todayKey ? 'Today' : dayLabel(selected)}
        </h2>
        {dayRows.length > 0 && (
          <span className="text-xs tabular-nums" style={{ color: 'var(--text-subtle)' }}>
            {dayRows.length} {dayRows.length === 1 ? 'item' : 'items'}
          </span>
        )}
      </div>

      {loading && <Skeleton rows={3} />}
      {error && !m.data && !t.data && (
        <ErrorState error={error} onRetry={() => { m.reload(); t.reload() }} />
      )}

      {!loading && dayRows.length === 0 && (
        <Card>
          <EmptyState
            icon={<CalendarDays className="size-6" />}
            title={selectedKey === todayKey ? 'Nothing scheduled today' : 'Nothing on this day'}
            body="Meetings and anything with a deadline appear here, in time order."
          />
        </Card>
      )}

      <div className="space-y-2">
        {dayRows.map(row => row.kind === 'meeting'
          ? <MeetingCard key={`m${row.meeting.id}`} meeting={row.meeting}
                         at={row.at} end={row.end}
                         onOpen={() => setOpenMeeting(row.meeting)} />
          : <TaskRow key={`t${row.task.id}`} task={row.task} at={row.at}
                     onOpen={() => setOpenTask(row.task)} />)}
      </div>

      {openTask && (
        <TaskDetail task={openTask} onClose={() => setOpenTask(null)}
                    onChanged={() => { t.reload(); m.reload() }} />
      )}
      {openMeeting && (
        <MeetingDetail meeting={openMeeting} onClose={() => setOpenMeeting(null)}
                       onChanged={() => { m.reload(); t.reload() }} />
      )}
    </div>
  )
}

type Row =
  | { kind: 'meeting'; at: Date | null; end: Date | null; meeting: Meeting }
  | { kind: 'task'; at: Date | null; task: Task }

/** At most three dots, live ones first, then an overflow count — the Flutter rule.
 *  A day of finished work must not push its one live item out of view. */
function Dots({ bag, inverted }: {
  bag: { tasks: Task[]; meetings: Meeting[] } | undefined
  inverted: boolean
}) {
  if (!bag) return <span className="h-1.5" />
  const isDone = (s: string) => s === 'completed' || s === 'cancelled'
  const activeTasks = bag.tasks.filter(x => !isDone(x.status)).length
  const activeMeetings = bag.meetings.filter(x => !isDone(x.status)).length
  const doneCount = bag.tasks.filter(x => isDone(x.status)).length +
                    bag.meetings.filter(x => isDone(x.status)).length

  const colours = [
    ...Array<string>(activeTasks).fill('#22C55E'),
    ...Array<string>(activeMeetings).fill('#4F46E5'),
    ...Array<string>(doneCount).fill('#94A3B8'),
  ]
  const shown = colours.slice(0, 3)
  const overflow = colours.length - shown.length

  return (
    <span className="flex items-center gap-[3px]">
      {shown.map((c, i) => (
        <span key={i} className="size-1.5 rounded-full"
              style={{ background: inverted ? 'rgba(255,255,255,.9)' : c }} />
      ))}
      {overflow > 0 && (
        <span className="text-[9px] font-bold leading-none"
              style={{ color: inverted ? 'rgba(255,255,255,.9)' : 'var(--text-subtle)' }}>
          +{overflow}
        </span>
      )}
    </span>
  )
}

function MeetingCard({ meeting, at, end, onOpen }: {
  meeting: Meeting; at: Date | null; end: Date | null; onOpen: () => void
}) {
  const now = istNow()
  const live = !!at && !!end && at <= now && now <= end
  const past = !!end && end < now
  /**
   * 🔴 On a CALENDAR, strikethrough means "this did not happen" — so it is for
   * `cancelled` only. A completed meeting genuinely took place; striking it out
   * claims the opposite about your own history. Both closed states are dimmed, so
   * neither reads as a live commitment.
   *
   * A task LIST uses the other rule — there, a ticked-off task is struck through,
   * because that is what ticking something off looks like. Two surfaces, two
   * meanings, and the Flutter app draws the same distinction.
   */
  const cancelled = meeting.status === 'cancelled'
  const closed = cancelled || meeting.status === 'completed'
  return (
    <Card className={cx('transition hover:brightness-[.98]',
                        (past || closed) && 'opacity-60')}>
      <button onClick={onOpen} className="flex w-full gap-3.5 p-3.5 text-left">
        <div className="w-[64px] shrink-0 text-right">
          <div className="text-[13px] font-semibold tabular-nums">{at ? timeLabel(at) : '—'}</div>
          {end && (
            <div className="text-[11px] tabular-nums" style={{ color: 'var(--text-subtle)' }}>
              {timeLabel(end)}
            </div>
          )}
        </div>
        <div className="w-[3px] shrink-0 rounded-full"
             style={{ background: cancelled ? '#94A3B8' : live ? '#22C55E' : '#4F46E5' }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className={cx('text-[14.5px] font-medium leading-snug',
                               cancelled && 'line-through')}>
              {meeting.title}
            </div>
            {live && !closed && <Badge tone="completed">Now</Badge>}
            {cancelled && <Badge tone="cancelled">Cancelled</Badge>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
               style={{ color: 'var(--text-muted)' }}>
            {meeting.location && (
              <span className="flex items-center gap-1">
                <MapPin className="size-3" /> {meeting.location}
              </span>
            )}
            {!!meeting.attendees?.length && (
              <span className="flex items-center gap-1">
                <Users className="size-3" /> {meeting.attendees.join(', ')}
              </span>
            )}
          </div>
        </div>
      </button>
    </Card>
  )
}

function TaskRow({ task, at, onOpen }: {
  task: Task; at: Date | null; onOpen: () => void
}) {
  // Same rule as the meeting above: struck through only when cancelled, dimmed
  // when closed either way. See the comment on MeetingCard.
  const cancelled = task.status === 'cancelled'
  const done = task.status === 'completed'
  const closed = cancelled || done
  return (
    <Card className={cx('transition hover:brightness-[.98]', closed && 'opacity-55')}>
      <button onClick={onOpen} className="flex w-full gap-3.5 p-3.5 text-left">
        <div className="w-[64px] shrink-0 text-right text-[13px] font-semibold tabular-nums">
          {at ? timeLabel(at) : '—'}
        </div>
        <div className="w-[3px] shrink-0 rounded-full"
             style={{
               background: cancelled ? '#94A3B8'
                 : done ? '#94A3B8'
                 : task.is_overdue ? '#EF4444' : '#22C55E',
             }} />
        <div className="min-w-0 flex-1">
          <div className={cx('text-[14.5px] font-medium leading-snug',
                             cancelled && 'line-through')}>
            {task.title}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            {/* A finished deadline says "Done", not "Deadline" — the label should
                describe the state, not repeat the row type on every line. */}
            {done ? <Badge tone="completed">Done</Badge>
              : cancelled ? <Badge tone="cancelled">Cancelled</Badge>
              : <Badge tone="neutral">Deadline</Badge>}
            {/* Overdue is irrelevant once a task is closed — the Flutter card
                suppresses it the same way. */}
            {task.is_overdue && !closed && <Badge tone="overdue">Overdue</Badge>}
          </div>
        </div>
      </button>
    </Card>
  )
}

// ── grid maths ──────────────────────────────────────────────────────────────
// Done in UTC at noon throughout. Midday means no arithmetic here can be pushed
// into the neighbouring day by an offset, and IST has no DST to complicate it.

function startOfMonth(d: Date): Date {
  const key = istDateKey(d)          // the IST calendar day, not the browser's
  const [y, m] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1, 12))
}

/** Blanks for the days before the 1st, then one cell per day. Monday-first, so the
 *  offset is `(weekday + 6) % 7` — JS weekdays are Sunday-based. */
function monthCells(anchor: Date): ({ key: string; day: number } | null)[] {
  const y = anchor.getUTCFullYear()
  const mo = anchor.getUTCMonth()
  const first = new Date(Date.UTC(y, mo, 1, 12))
  const offset = (first.getUTCDay() + 6) % 7
  const daysInMonth = new Date(Date.UTC(y, mo + 1, 0, 12)).getUTCDate()

  const out: ({ key: string; day: number } | null)[] = Array(offset).fill(null)
  for (let d = 1; d <= daysInMonth; d++) {
    const p = (n: number) => String(n).padStart(2, '0')
    out.push({ key: `${y}-${p(mo + 1)}-${p(d)}`, day: d })
  }
  // Pad to a whole number of rows so the card does not change height month to month.
  while (out.length % 7 !== 0) out.push(null)
  return out
}
