import { useMemo, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, MapPin, Users } from 'lucide-react'
import { meetings as meetingsApi, tasks as tasksApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import {
  dayLabel, fullDayLabel, istDateKey, istNow, parseIstNaive, timeLabel,
} from '../../lib/format'
import type { Meeting, Task } from '../../lib/types'
import {
  Badge, Button, Card, EmptyState, ErrorState, Skeleton, cx,
} from '../../ui'

/**
 * Meetings and scheduled time.
 *
 * An AGENDA, not a month grid. A month grid is the right shape when you are
 * scanning for free space, and this backend cannot answer that question —
 * `/calendar/free-slots` is a hardcoded `[]` stub. What it can answer is "what is
 * happening, in order", so that is what this shows: a week strip to move between
 * days, and one day's items in time order.
 *
 * Tasks appear alongside meetings because a 4pm deadline and a 4pm meeting compete
 * for the same 4pm, and a calendar that shows only one of them is lying about the
 * day.
 */
export function CalendarScreen() {
  const [offset, setOffset] = useState(0)     // days from today
  const m = useApi(s => meetingsApi.all(s))
  const t = useApi(s => tasksApi.mine(s))

  const selected = useMemo(
    () => new Date(istNow().getTime() + offset * 86_400_000), [offset])
  const selectedKey = istDateKey(selected)

  // The week strip is anchored on the SELECTED day, not on a calendar week, so
  // paging never lands on an empty stretch you have to page past.
  const strip = useMemo(
    () => Array.from({ length: 7 },
      (_, i) => new Date(istNow().getTime() + (offset - 3 + i) * 86_400_000)),
    [offset])

  const byDay = useMemo(() => {
    const meetings = (m.data?.meetings ?? []).filter(x => x.status !== 'cancelled')
    const tasks = (t.data?.tasks ?? [])
      .filter(x => x.status !== 'cancelled' && x.due_at)

    const counts = new Map<string, number>()
    for (const x of meetings) {
      const at = parseIstNaive(x.scheduled_at)
      if (at) counts.set(istDateKey(at), (counts.get(istDateKey(at)) ?? 0) + 1)
    }
    for (const x of tasks) {
      const at = parseIstNaive(x.due_at)
      if (at) counts.set(istDateKey(at), (counts.get(istDateKey(at)) ?? 0) + 1)
    }
    return counts
  }, [m.data, t.data])

  const dayItems = useMemo(() => {
    type Row =
      | { kind: 'meeting'; at: Date | null; end: Date | null; meeting: Meeting }
      | { kind: 'task'; at: Date | null; task: Task }

    const rows: Row[] = []
    for (const x of m.data?.meetings ?? []) {
      if (x.status === 'cancelled') continue
      const at = parseIstNaive(x.scheduled_at)
      if (at && istDateKey(at) === selectedKey) {
        rows.push({ kind: 'meeting', at, end: parseIstNaive(x.ends_at), meeting: x })
      }
    }
    for (const x of t.data?.tasks ?? []) {
      if (x.status === 'cancelled') continue
      const at = parseIstNaive(x.due_at)
      if (at && istDateKey(at) === selectedKey) rows.push({ kind: 'task', at, task: x })
    }
    return rows.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0))
  }, [m.data, t.data, selectedKey])

  const loading = (m.loading && !m.data) || (t.loading && !t.data)
  const error = m.error ?? t.error

  return (
    <div className="space-y-5">
      {/* ── week strip ───────────────────────────────────────────────── */}
      <Card className="p-3">
        <div className="mb-2.5 flex items-center justify-between gap-2 px-1">
          <button onClick={() => setOffset(o => o - 7)} aria-label="Previous week"
                  className="grid size-8 place-items-center rounded-lg"
                  style={{ color: 'var(--text-muted)' }}>
            <ChevronLeft className="size-4" />
          </button>
          <div className="text-[13px] font-semibold">{fullDayLabel(selected)}</div>
          <button onClick={() => setOffset(o => o + 7)} aria-label="Next week"
                  className="grid size-8 place-items-center rounded-lg"
                  style={{ color: 'var(--text-muted)' }}>
            <ChevronRight className="size-4" />
          </button>
        </div>

        <div className="grid grid-cols-7 gap-1">
          {strip.map(d => {
            const key = istDateKey(d)
            const isSel = key === selectedKey
            const isToday = key === istDateKey(istNow())
            const n = byDay.get(key) ?? 0
            return (
              <button
                key={key}
                onClick={() => setOffset(Math.round(
                  (d.getTime() - istNow().getTime()) / 86_400_000))}
                aria-current={isSel ? 'date' : undefined}
                className="flex flex-col items-center gap-1 rounded-xl py-2 transition"
                style={isSel
                  ? { background: 'var(--accent)', color: '#fff' }
                  : { color: 'var(--text-muted)' }}
              >
                <span className="text-[10px] font-medium uppercase opacity-70">
                  {dayLabel(d).split(' ')[0]}
                </span>
                <span className={cx('text-[15px] font-semibold tabular-nums',
                                    isToday && !isSel && 'underline decoration-2 underline-offset-4')}>
                  {Number(key.slice(-2))}
                </span>
                {/* A dot, not a count. The number is meaningless at this size and
                    the presence of anything at all is the useful signal. */}
                <span className="h-1 w-1 rounded-full"
                      style={{ background: n > 0
                        ? (isSel ? 'rgba(255,255,255,.85)' : 'var(--accent)')
                        : 'transparent' }} />
              </button>
            )
          })}
        </div>

        {offset !== 0 && (
          <div className="mt-2.5 flex justify-center">
            <Button size="sm" variant="ghost" onClick={() => setOffset(0)}>Back to today</Button>
          </div>
        )}
      </Card>

      {/* ── the day ──────────────────────────────────────────────────── */}
      {loading && <Skeleton rows={3} />}
      {error && !m.data && !t.data && (
        <ErrorState error={error} onRetry={() => { m.reload(); t.reload() }} />
      )}

      {!loading && dayItems.length === 0 && (
        <Card>
          <EmptyState
            icon={<CalendarDays className="size-6" />}
            title={offset === 0 ? 'Nothing scheduled today' : `Nothing on ${dayLabel(selected)}`}
            body="Meetings and anything with a deadline will show up here in time order."
          />
        </Card>
      )}

      <div className="space-y-2">
        {dayItems.map(row => row.kind === 'meeting'
          ? <MeetingCard key={`m${row.meeting.id}`} meeting={row.meeting}
                         at={row.at} end={row.end} />
          : <TaskRow key={`t${row.task.id}`} task={row.task} at={row.at} />)}
      </div>
    </div>
  )
}

function MeetingCard({ meeting, at, end }: {
  meeting: Meeting; at: Date | null; end: Date | null
}) {
  const now = istNow()
  const live = !!at && !!end && at <= now && now <= end
  const past = !!end && end < now

  return (
    <Card className={cx(past && 'opacity-60')}>
      <div className="flex gap-3.5 p-3.5">
        <div className="w-[64px] shrink-0 text-right">
          <div className="text-[13px] font-semibold tabular-nums">{at ? timeLabel(at) : '—'}</div>
          {end && (
            <div className="text-[11px] tabular-nums" style={{ color: 'var(--text-subtle)' }}>
              {timeLabel(end)}
            </div>
          )}
        </div>
        <div className="w-[3px] shrink-0 rounded-full"
             style={{ background: live ? '#22C55E' : 'var(--accent)' }} />
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div className="text-[14.5px] font-medium leading-snug">{meeting.title}</div>
            {live && <Badge tone="completed">Now</Badge>}
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
          {meeting.description && (
            <p className="mt-1.5 line-clamp-2 text-xs" style={{ color: 'var(--text-subtle)' }}>
              {meeting.description}
            </p>
          )}
        </div>
      </div>
    </Card>
  )
}

function TaskRow({ task, at }: { task: Task; at: Date | null }) {
  const done = task.status === 'completed'
  return (
    <Card className={cx(done && 'opacity-55')}>
      <div className="flex gap-3.5 p-3.5">
        <div className="w-[64px] shrink-0 text-right text-[13px] font-semibold tabular-nums">
          {at ? timeLabel(at) : '—'}
        </div>
        <div className="w-[3px] shrink-0 rounded-full"
             style={{ background: task.is_overdue ? '#EF4444' : 'var(--border-strong)' }} />
        <div className="min-w-0 flex-1">
          <div className={cx('text-[14.5px] font-medium leading-snug', done && 'line-through')}>
            {task.title}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <Badge tone="neutral">Deadline</Badge>
            {task.is_overdue && <Badge tone="overdue">Overdue</Badge>}
          </div>
        </div>
      </div>
    </Card>
  )
}
