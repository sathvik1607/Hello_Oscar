import { useMemo, useState } from 'react'
import { CalendarClock, CheckCircle2, Clock, Plus } from 'lucide-react'
import { meetings as meetingsApi, tasks as tasksApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ITEM_CACHES, ITEM_FRAMES, useLiveData } from '../../lib/useLiveData'
import {
  dueLabel, isToday, istNow, parseIstNaive, timeLabel,
} from '../../lib/format'
import type { Meeting, Task } from '../../lib/types'
import { completedToday, todayTimeline } from '../tasks/buckets'
import { TaskCard } from '../tasks/TaskCard'
import { useTaskActions } from '../tasks/useTaskActions'
import { TaskDetail } from '../tasks/TaskDetail'
import { useUnreadComments } from '../tasks/useUnreadComments'
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
  const [openTask, setOpenTask] = useState<Task | null>(null)
  // Unread comments per task — the badge and the glow on each card, and the
  // clear when one is opened. See useUnreadComments: derived from the bell rows
  // because no per-viewer read state exists on pa_task_comments.
  const comments = useUnreadComments()
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
  const nextDue = nextUp?.due_at ? parseIstNaive(nextUp.due_at) : null
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
              {/* 🔴 NO GREETING AND NO NAME. The shell header above already says
                  "Today · What needs you right now", so a "Good morning, Sathvik"
                  underneath it spent the largest type on the screen restating the
                  page and telling you your own name. The state of the day gets that
                  type instead — this is a console, not a personal dashboard. */}
              <p className="text-[19px] font-semibold leading-snug tracking-tight sm:text-[21px]">
                {headline(timeline.length, overdueCount, todaysMeetings.length, done.length)}
              </p>
              {/* Next up is the ONE actionable fact, so it gets its own line and its
                  time sits under the title rather than trailing it in prose — a time
                  buried mid-sentence has to be read, where this can be glanced at. */}
              {nextUp && (
                <p className="mt-2 max-w-lg text-sm leading-relaxed"
                   style={{ color: 'var(--text-muted)' }}>
                  <span style={{ color: 'var(--text-subtle)' }}>Next up: </span>
                  <span style={{ color: 'var(--text)' }}>{nextUp.title}</span>
                  {nextDue && (
                    <>
                      <br />
                      <span className="tabular-nums">{dueLabel(nextDue)}</span>
                    </>
                  )}
                </p>
              )}
            </div>
            {/* Desktop only — the mobile copy lives below the pills, because a
                button beside the headline squeezes it on a narrow screen. */}
            <div className="hidden shrink-0 sm:block">
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus className="size-4" /> New task
              </Button>
            </div>
          </div>

          {/* 🔴 THE ONLY WAY TO ADD A TASK FROM TODAY ON A PHONE.
              The header button is `hidden sm:block`, so below 640px it did not
              exist — and the empty-state button only renders when the timeline is
              EMPTY. So the moment you had a single task, Today offered no way to
              create another: you had to go to Tasks. The bottom-right FAB slot is
              taken by floating Oscar (AppShell), so this goes inline rather than
              becoming a second FAB competing for the same thumb position. */}
          <div className="mt-5 sm:hidden">
            <Button variant="primary" onClick={() => setCreating(true)}
                    className="w-full">
              <Plus className="size-4" /> New task
            </Button>
          </div>

          {(timeline.length > 0 || done.length > 0 || todaysMeetings.length > 0) && (
            <div className="mt-4 flex flex-wrap gap-2 sm:mt-5">
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
              /* Desktop only. On a phone the card's own New task button sits a
                 couple of hundred pixels above this one, so rendering both put two
                 identical full-width buttons on the same screen. On desktop they
                 are far apart — header top-right versus the middle of an empty
                 card — so both reading as calls to action is fine. */
              action={<div className="hidden sm:block">
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus className="size-4" /> New task
                </Button>
              </div>}
            />
          </Card>
        ) : (
          <div className="space-y-2">
            {timeline.map(task => (
              <TaskCard
                key={task.id} task={task}
                busy={busyId === task.id}
                onToggle={() => void toggle(task)}
                onOpen={() => { comments.markSeen(task.id); setOpenTask(task) }}
                        unreadComments={comments.byItem.get(task.id)}
                showAssignee
              />
            ))}
          </div>
        )}
      </section>

      {/* ── what got done ────────────────────────────────────────────── */}
      {done.length > 0 && (
        <section>
          <SectionHeading count={done.length}>Completed today</SectionHeading>
          <div className="space-y-2">
            {done.map(task => (
              <TaskCard
                key={task.id} task={task}
                busy={busyId === task.id}
                onToggle={() => void toggle(task)}
                onOpen={() => { comments.markSeen(task.id); setOpenTask(task) }}
                        unreadComments={comments.byItem.get(task.id)}
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

/** The state of the day in one clause. Written to be true in every branch,
 *  including the two that look the same and are not: nothing due because you
 *  finished it, and nothing due because nothing was planned.
 *
 *  Next-up used to be appended here as a second sentence. It moved into the JSX so
 *  the title and its time can be styled and put on separate lines — a function that
 *  returns a string can only ever produce prose. */
function headline(open: number, overdue: number, meets: number, done: number): string {
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
      ? `Everything due today is done — ${done} ${done === 1 ? 'task' : 'tasks'} cleared`
      : 'Nothing is due today'
  }

  const head = parts.join(', ').replace(/, ([^,]*)$/, ' and $1')
  return `${head[0].toUpperCase()}${head.slice(1)}`
}
