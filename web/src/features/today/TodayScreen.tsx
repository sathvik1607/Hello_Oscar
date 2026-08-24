import { useMemo, useState } from 'react'
import { CalendarClock, CheckCircle2, Clock, Plus, Sun } from 'lucide-react'
import { meetings as meetingsApi, tasks as tasksApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ITEM_CACHES, ITEM_FRAMES, useLiveData } from '../../lib/useLiveData'
import { getUser } from '../../lib/session'
import {
  dueLabel, isToday, istNow, parseIstNaive, timeLabel,
} from '../../lib/format'
import type { Meeting, Task } from '../../lib/types'
import { completedToday, todayTimeline } from '../tasks/buckets'
import { TaskCard } from '../tasks/TaskCard'
import { useTaskActions } from '../tasks/useTaskActions'
import { TaskDetail } from '../tasks/TaskDetail'
import { NewTaskSheet } from '../tasks/NewTaskSheet'
import { MeetingDetail } from '../calendar/MeetingDetail'
import {
  Button, Card, EmptyState, ErrorState, SectionHeading, Skeleton, cx,
} from '../../ui'

/**
 * The primary screen. It answers exactly one question:
 *
 *   "What does Oscar think I need to know or do right now?"
 *
 * Which is why it is a TIMELINE and not a dashboard of counts. A count tells you
 * there are eleven things; a timeline tells you which one is next. The Flutter
 * Today screen made the same call — one flat list scoped to today, no categories —
 * and this mirrors it, including keeping undated items visible so nothing silently
 * disappears.
 *
 * Overdue work is folded INTO today rather than given its own section: an overdue
 * task is today's problem, and a separate "overdue" pile is a place things go to be
 * ignored.
 */
export function TodayScreen() {
  const user = getUser()
  const [openTask, setOpenTask] = useState<Task | null>(null)
  const [openMeeting, setOpenMeeting] = useState<Meeting | null>(null)
  /* Creating a task is the action this screen is missing, and it was the one thing
     the primary button did NOT do — "Ask Oscar" opened a voice call, which is a
     slower and less certain way to add a line to a list you are already looking at.
     Voice is still one keystroke away (Shift Shift, from anywhere). */
  const [creating, setCreating] = useState(false)

  const t = useApi(s => tasksApi.mine(s), [], 'tasks:mine')
  const m = useApi(s => meetingsApi.all(s), [], 'meetings:all')

  const { toggle, busyId, error: actionError } = useTaskActions(t.patch, t.reload)

  // Live task/meeting frames, plus a refetch after any dropped connection —
  // frames sent while the socket was down are never re-sent.
  useLiveData(ITEM_FRAMES, () => { t.reload(); m.reload() },
              { invalidatePrefixes: ITEM_CACHES })

  // Keyed on `t.data`, NOT on `t.data?.tasks ?? []`. That fallback allocates a new
  // array on every render, so the memo below it would recompute every time — and
  // these two run over the whole task list.
  const allTasks = useMemo(() => t.data?.tasks ?? [], [t.data])
  const timeline = useMemo(() => todayTimeline(allTasks), [allTasks])
  const done = useMemo(() => completedToday(allTasks), [allTasks])

  const todaysMeetings = useMemo(() => (m.data?.meetings ?? [])
    .filter(x => {
      const at = parseIstNaive(x.scheduled_at)
      return at && isToday(at) && x.status !== 'cancelled'
    })
    .sort((a, b) =>
      (parseIstNaive(a.scheduled_at)?.getTime() ?? 0) -
      (parseIstNaive(b.scheduled_at)?.getTime() ?? 0)),
  [m.data])

  const nextUp = timeline.find(x => !x.is_overdue) ?? timeline[0]
  const overdueCount = timeline.filter(x => x.is_overdue).length

  if (t.loading && !t.data) {
    return (
      <div className="space-y-6">
        <div className="skeleton h-24 rounded-[var(--radius-card)]" />
        <Skeleton rows={4} />
      </div>
    )
  }
  if (t.error && !t.data) return <ErrorState error={t.error} onRetry={t.reload} />

  return (
    <div className="space-y-7">
      {/* ── the brief ────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <div className="p-5 sm:p-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[.12em]"
                   style={{ color: 'var(--text-subtle)' }}>
                <Sun className="size-3.5" /> {greeting()}
              </div>
              <h2 className="mt-1.5 text-[22px] font-semibold tracking-tight sm:text-2xl">
                {user?.name?.split(' ')[0] ?? 'Hello'}
              </h2>
              {/* One sentence, in plain words, about the actual state of the day.
                  This is the whole screen in a line — everything below is detail. */}
              <p className="mt-2 max-w-lg text-sm leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {brief(timeline.length, overdueCount, todaysMeetings.length, done.length, nextUp)}
              </p>
            </div>
            <div className="hidden shrink-0 sm:block">
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus className="size-4" /> New task
              </Button>
            </div>
          </div>

          {(timeline.length > 0 || done.length > 0 || todaysMeetings.length > 0) && (
            <div className="mt-5 flex flex-wrap gap-2">
              {timeline.length > 0 && (
                <Pill icon={<Clock className="size-3.5" />} label="to do"
                      value={timeline.length} />
              )}
              {overdueCount > 0 && (
                <Pill icon={<Clock className="size-3.5" />} label="overdue"
                      value={overdueCount} tone="danger" />
              )}
              {todaysMeetings.length > 0 && (
                <Pill icon={<CalendarClock className="size-3.5" />} label="meetings"
                      value={todaysMeetings.length} />
              )}
              {done.length > 0 && (
                <Pill icon={<CheckCircle2 className="size-3.5" />} label="done"
                      value={done.length} tone="good" />
              )}
            </div>
          )}
        </div>
      </Card>

      {actionError && <ErrorState error={actionError} onRetry={t.reload} />}

      {/* ── today's meetings ─────────────────────────────────────────── */}
      {todaysMeetings.length > 0 && (
        <section>
          <SectionHeading count={todaysMeetings.length}>Meetings</SectionHeading>
          <div className="space-y-2">
            {todaysMeetings.map(x => (
              <MeetingRow key={x.id} meeting={x} onOpen={() => setOpenMeeting(x)} />
            ))}
          </div>
        </section>
      )}

      {/* ── the timeline ─────────────────────────────────────────────── */}
      <section>
        <SectionHeading count={timeline.length}>Your day</SectionHeading>
        {timeline.length === 0 ? (
          <Card>
            <EmptyState
              icon={<CheckCircle2 className="size-6" />}
              title={done.length > 0 ? "That's everything for today" : 'Nothing scheduled today'}
              body={done.length > 0
                ? `You finished ${done.length} ${done.length === 1 ? 'task' : 'tasks'}. Nothing else is due.`
                : 'Add something you need to do today, or plan your day from your notes.'}
              action={<Button variant="primary" onClick={() => setCreating(true)}>
                <Plus className="size-4" /> New task
              </Button>}
            />
          </Card>
        ) : (
          <div className="space-y-2">
            {timeline.map(task => (
              <TaskCard
                key={task.id} task={task}
                busy={busyId === task.id}
                onToggle={() => void toggle(task)}
                onOpen={() => setOpenTask(task)}
                showAssignee
              />
            ))}
          </div>
        )}
      </section>

      {/* ── what got done ────────────────────────────────────────────── */}
      {done.length > 0 && (
        <section>
          <SectionHeading count={done.length}>Finished today</SectionHeading>
          <div className="space-y-2">
            {done.map(task => (
              <TaskCard
                key={task.id} task={task}
                busy={busyId === task.id}
                onToggle={() => void toggle(task)}
                onOpen={() => setOpenTask(task)}
              />
            ))}
          </div>
        </section>
      )}

      {creating && (

        <NewTaskSheet onClose={() => setCreating(false)}

                      onCreated={() => { setCreating(false); t.reload() }} />

      )}


      {openTask && (
        <TaskDetail
          task={openTask}
          onClose={() => setOpenTask(null)}
          onChanged={t.reload}
        />
      )}
      {openMeeting && (
        <MeetingDetail meeting={openMeeting} onClose={() => setOpenMeeting(null)}
                       onChanged={() => { m.reload(); t.reload() }} />
      )}
    </div>
  )
}

function Pill({ icon, label, value, tone }: {
  icon: React.ReactNode; label: string; value: number
  tone?: 'good' | 'danger'
}) {
  const color = tone === 'danger' ? '#DC2626' : tone === 'good' ? '#15803D' : 'var(--text-muted)'
  const bg = tone === 'danger' ? 'rgba(239,68,68,.1)'
           : tone === 'good' ? 'rgba(34,197,94,.1)' : 'var(--bg-sunken)'
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
          style={{ background: bg, color }}>
      {icon}<span className="tabular-nums font-semibold">{value}</span> {label}
    </span>
  )
}

function MeetingRow({ meeting, onOpen }: { meeting: Meeting; onOpen: () => void }) {
  const at = parseIstNaive(meeting.scheduled_at)
  const ends = parseIstNaive(meeting.ends_at)
  const now = istNow()
  const live = !!at && !!ends && at <= now && now <= ends

  return (
    <Card className={cx(live && 'ring-2')}
          style={live ? { boxShadow: '0 0 0 2px rgba(34,197,94,.35)' } : undefined}>
      <button onClick={onOpen} className="flex w-full items-center gap-3.5 p-3.5 text-left">
        <div className="w-[62px] shrink-0 text-right">
          <div className="text-[13px] font-semibold tabular-nums">
            {at ? timeLabel(at) : '—'}
          </div>
          {ends && (
            <div className="text-[11px] tabular-nums" style={{ color: 'var(--text-subtle)' }}>
              {timeLabel(ends)}
            </div>
          )}
        </div>
        <div className="h-9 w-px shrink-0" style={{ background: 'var(--border)' }} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14.5px] font-medium">{meeting.title}</div>
          <div className="truncate text-xs" style={{ color: 'var(--text-muted)' }}>
            {live ? 'Happening now' : meeting.location || 'No location'}
          </div>
        </div>
      </button>
    </Card>
  )
}

function greeting(): string {
  // Hour in IST, not the browser's — the backend's whole world is IST, and a
  // "Good morning" that disagrees with the timestamps beside it is worse than none.
  const h = Number(new Intl.DateTimeFormat('en-GB',
    { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()))
  if (h < 5) return 'Late night'
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  if (h < 21) return 'Good evening'
  return 'Good evening'
}

/** The one-sentence brief. Written to be true in every branch, including the two
 *  that look the same and are not: nothing due because you finished it, and nothing
 *  due because nothing was planned. */
function brief(open: number, overdue: number, meets: number, done: number,
               next: Task | undefined): string {
  const parts: string[] = []

  if (overdue > 0) {
    parts.push(`${overdue} ${overdue === 1 ? 'task is' : 'tasks are'} overdue`)
  }
  if (open - overdue > 0) {
    const n = open - overdue
    // "more" only reads correctly as a continuation of the overdue clause above.
    // On its own it answers "more than what?" with nothing — which is how the first
    // version produced the sentence "1 more due today." to someone with one task.
    parts.push(overdue > 0
      ? `${n} more due today`
      : `${n} ${n === 1 ? 'task is' : 'tasks are'} due today`)
  }
  if (meets > 0) parts.push(`${meets} ${meets === 1 ? 'meeting' : 'meetings'}`)

  if (parts.length === 0) {
    return done > 0
      ? `Everything due today is done — ${done} ${done === 1 ? 'task' : 'tasks'} cleared.`
      : 'Nothing is due today. A good moment to plan ahead.'
  }

  const head = parts.join(', ').replace(/, ([^,]*)$/, ' and $1')
  const due = next?.due_at ? parseIstNaive(next.due_at) : null
  const tail = next
    ? ` Next up: ${next.title}${due ? ` at ${dueLabel(due)}` : ''}.`
    : ''
  return `${head[0].toUpperCase()}${head.slice(1)}.${tail}`
}
