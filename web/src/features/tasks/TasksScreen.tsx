import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckSquare, Plus } from 'lucide-react'
import { tasks as tasksApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ITEM_CACHES, ITEM_FRAMES, useLiveData } from '../../lib/useLiveData'
import type { Task } from '../../lib/types'
import { groupByDueDate } from './buckets'
import { TaskCard } from './TaskCard'
import { TaskDetail } from './TaskDetail'
import { useUnreadComments } from './useUnreadComments'
import { NewTaskSheet } from './NewTaskSheet'
import { useTaskActions } from './useTaskActions'
import {
  Button, Card, EmptyState, ErrorState, SectionHeading, Skeleton,
} from '../../ui'

/**
 * Everything on your plate, in the product's order:
 *
 *   IN PROGRESS → PREVIOUS (overdue) → UPCOMING (today) → LATER
 *
 * Not a table, and not a single sortable list. The buckets are the value: a flat
 * list sorted by date puts an overdue task from last week above the thing you are
 * actively working on, which is exactly backwards from how anyone triages.
 *
 * 🔴 NO DELEGATED TAB. It was removed because My Team answers the same question
 * better — per person, with presence, grouped by date — and two screens listing the
 * work you handed out is two places for that list to disagree. This screen is now
 * purely YOUR OWN work: every date, filtered by status.
 *
 * `is_mine` is the test for
 * "mine" — the legacy `assigned_to_user_id` names only the primary assignee, so on
 * a shared task it answers wrong for everybody else.
 */

export function TasksScreen({ target }: {
  /** Deep-link from Activity — `{id}` to glow the row, `{id, thread}` to open its
   *  detail (where the comment thread lives). Mirrors the Flutter app's
   *  `?highlight=<item_id>` and `&thread=1`. */
  target?: { id: number; thread?: boolean } | null
} = {}) {
  /**
   * Status is a FILTER, not a section and not a sort key.
   *
   * It used to be both: the `done` tab was a separate view, and `bucketOf` put
   * anything `in_progress` into its own heading — so a task started this morning
   * silently left Today's list. Two different questions ("when is this due", "how far
   * along is it") were being answered on one axis, and the date order lost.
   *
   * 🔴 EACH STATUS IS FETCHED FROM THE SERVER, not filtered client-side out of
   * `mine`. That endpoint caps at 100 rows ordered by created_at DESC and the 100 are
   * shared across every status — measured: 119 completed tasks existed while the
   * plain list carried 73, so 46 were invisible. Filtering in the browser would have
   * silently shown the wrong count.
   */
  const [status, setStatus] = useState<'open' | 'completed'>('open')
  const [openTask, setOpenTask] = useState<Task | null>(null)
  // Unread comments per task — the badge and the glow on each card, and the
  // clear when one is opened. See useUnreadComments: derived from the bell rows
  // because no per-viewer read state exists on pa_task_comments.
  const comments = useUnreadComments()
  /** Which row to glow. Cleared after the glow so it does not re-fire on a refetch. */
  const [glow, setGlow] = useState<number | null>(null)
  /** The one deep-link id we have already switched the filter for, so a target that
   *  genuinely does not exist (item_id is not a FK — rows point at deleted items)
   *  cannot ping-pong the filter forever. */
  const escalated = useRef<number | null>(null)
  /**
   * The target we have already acted on.
   *
   * 🔴 A DEEP LINK IS A ONE-SHOT EVENT, NOT A PERSISTENT SETTING — and treating it
   * as the latter is what made the Open chip stop working. `target` stays set for as
   * long as you remain on the screen, and the effect below lists `status` in its
   * deps, so every click on Open re-ran it, saw the linked task was still completed,
   * and forced the filter straight back to Done. The chip appeared broken; it was
   * being overruled a frame later.
   *
   * Compared by OBJECT IDENTITY, not by id: App mints a fresh target object per
   * navigation, so tapping the same notification twice still re-opens it, while a
   * re-render with the same object does nothing.
   */
  const handled = useRef<object | null>(null)
  const [creating, setCreating] = useState(false)
  const [focusThread, setFocusThread] = useState(false)

  const mine = useApi(s => tasksApi.mine(s), [], 'tasks:mine')
  // Fetched only when its tab is opened. Both are extra round trips against a
  // backend where a cold request can take seconds; loading them eagerly would make
  // the default tab wait for data nobody asked for.
  // One request per selected status, and only when a status is selected. `all` reuses
  // `mine`, which is already loaded.
  const byStatus = useApi(
    s => (status === 'completed')
      ? tasksApi.byStatus('completed', s)
      : Promise.resolve({ count: 0, tasks: [] }),
    [status])

  const source = status === 'completed' ? byStatus : mine
  const { toggle, busyId, error: actionError } = useTaskActions(source.patch, source.reload)

  useLiveData(ITEM_FRAMES, () => { mine.reload(); source.reload() },
              { invalidatePrefixes: ITEM_CACHES })

  // See TodayScreen: `?? []` allocates per render and would defeat this memo.
  const allMine = useMemo(() => mine.data?.tasks ?? [], [mine.data])

  /**
   * Resolve the deep-link once the data it points into has arrived.
   *
   * Searches ALL three loaded lists, not the active tab: a comment can land on a
   * task you delegated or one already finished, and the notification does not say
   * which tab it lives in. Falling back to the tab alone was the old behaviour and
   * is exactly what made Activity useless.
   *
   * 🔴 A MISS IS EXPECTED, NOT AN ERROR. pa_notifications.item_id is a plain int and
   * NOT a foreign key — rows already point at deleted items — so an unresolvable
   * target simply leaves you on the list rather than opening an empty sheet.
   */
  useEffect(() => {
    if (!target) return
    // Acted on already — from here the filter belongs to whoever is clicking.
    if (handled.current === target) return
    const pool = [
      ...(mine.data?.tasks ?? []),
      ...(byStatus.data?.tasks ?? []),
    ]
    const hit = pool.find(t => t.id === target.id)
    /**
     * 🔴 NOT FOUND CAN MEAN "NOT FETCHED YET", AND THAT WAS A REAL DEAD END.
     *
     * `byStatus` resolves to an EMPTY list while the filter is `open` — completed
     * tasks are deliberately not loaded until the Done chip is picked, because
     * `/tasks/{uid}` caps at 100 rows shared across all statuses. So a notification
     * about a task that has since been completed found nothing in either pool, hit
     * the `return` below, and the tap did visibly nothing.
     *
     * One escalation, guarded by a ref so it cannot loop: flip to Done, which
     * triggers the fetch, and this effect runs again with the row present.
     */
    if (!hit) {
      if (status !== 'completed' && escalated.current !== target.id) {
        escalated.current = target.id
        setStatus('completed')
      }
      return
    }
    /**
     * And the mirror case: the row IS loaded (it is inside `mine`, which carries
     * every status) but the ACTIVE FILTER hides it — so the sheet opened over a list
     * that did not contain the task, and closing it left you staring at Open
     * wondering where the thing went. The filter follows the task, not the reverse.
     */
    handled.current = target
    // Comment notifications land ON the comment. Held in state rather than read from
    // `target` at render time, so closing and reopening the task normally shows the
    // task — a deep link is a one-shot event, not a mode the screen stays in.
    setFocusThread(!!target.thread)
    const finished = hit.status === 'completed' || hit.status === 'cancelled'
    if (finished && status !== 'completed') setStatus('completed')
    if (!finished && status !== 'open') setStatus('open')
    // 🔴 OPEN THE SHEET FOR EVERY TYPE, not only comments. A glow on a row was the
    // whole payload for task_assigned / task_reminder / task_updated — so the most
    // common notifications in the product bounced you to a list and made you find
    // the row yourself, which is the same as not routing at all. `thread` no longer
    // decides WHETHER to open, only what you land on inside.
    setOpenTask(hit)
    setGlow(hit.id)
    // Scroll after paint, so the row exists to scroll to.
    requestAnimationFrame(() => {
      document.getElementById(`task-${hit.id}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    // Long enough to notice, short enough not to linger as decoration.
    const t = setTimeout(() => setGlow(null), 2600)
    return () => clearTimeout(t)
  }, [target, mine.data, byStatus.data, status])
  const open = useMemo(
    () => allMine.filter(t => t.status !== 'completed' && t.status !== 'cancelled'),
    [allMine])

  /** Date sections over whatever the status filter selected. `All` shows OPEN work —
   *  a 100-row list that is 73 finished is a log, not a task list; picking Done is
   *  how you ask for those. */
  const listed = useMemo(
    () => (status === 'open' ? open : (byStatus.data?.tasks ?? [])),
    [status, open, byStatus.data])
  const sections = useMemo(() => groupByDueDate(listed), [listed])



  /**
   * TWO chips, because there are only two states worth asking about.
   *
   * It started as All | To do | In progress | Done and each of the middle two had to
   * go for the same reason — a control that cannot change what you see:
   *
   * · IN PROGRESS — a real ENUM value the card even has a badge for, but NOTHING in
   *   this app sets it. There is no "start" action, only complete / reopen / cancel;
   *   only Oscar can via update_task. It returned 0 on every account.
   * · ALL vs TO DO — they differed only by `in_progress` and `blocked`. Nothing sets
   *   the first and this account has 0 of the second, so both chips resolved to the
   *   same 1 task. "All" was also a lie: it sounded like everything INCLUDING
   *   finished work, which is exactly what it excluded.
   *
   * Open and Done partition the list with no overlap and no empty states.
   */
  const STATUSES: { id: typeof status; label: string }[] = [
    { id: 'open', label: 'Open' },
    { id: 'completed', label: 'Done' },
  ]

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        {/* STATUS FILTER. The only control on this screen now that Delegated is gone —
            and it never reorders anything: the date sections and the due-time order
            inside them are identical whichever chip is active. */}
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map(st => (
            <button key={st.id} onClick={() => setStatus(st.id)}
                    aria-pressed={status === st.id}
                    /* Larger than the usual chip. These two are the only control on
                       the screen, so they are the primary way you steer it — not a
                       secondary tag squeezed into a row of them. */
                    className="rounded-full border px-4 py-2 text-[13.5px] font-medium transition"
                    style={status === st.id
                      ? { background: 'var(--accent)', color: '#fff',
                          borderColor: 'var(--accent)' }
                      : { background: 'var(--bg)', borderColor: 'var(--border)',
                          color: 'var(--text-muted)' }}>
              {st.label}
            </button>
          ))}
        </div>
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> <span className="hidden sm:inline">New task</span>
        </Button>
      </div>

      {actionError && <ErrorState error={actionError} onRetry={source.reload} />}

      {source.loading && !source.data && <Skeleton rows={5} />}
      {source.error && !source.data && (
        <ErrorState error={source.error} onRetry={source.reload} />
      )}

      {/* ── the list, in date order ──────────────────────────────────── */}
      {/*
        * 🔴 GATED ON WHAT IS BEING RENDERED, AND ON THE RIGHT REQUEST.
        *
        * This was `!!mine.data && openCount === 0` — two bugs in one line, both from
        * the days when this screen only ever showed open work:
        *
        *  · `openCount` counts OPEN tasks, so once the last one was cleared the
        *    "Nothing open" card appeared on the **Done** filter too — hiding 119
        *    completed tasks behind a message about a different list.
        *  · `mine.data` is the wrong request to wait for on Done, which is served by
        *    `byStatus`. So Done rendered a verdict before its own fetch had landed.
        *
        * Both now follow `source` (the request feeding this filter) and `listed`
        * (the rows actually about to be drawn).
        */}
      {!!source.data && (
        listed.length === 0 ? (
          <Card>
            <EmptyState
              icon={<CheckSquare className="size-6" />}
              title={status === 'open' ? 'Nothing open' : 'Nothing finished yet'}
              body={status === 'open'
                ? 'Every task is done or scheduled for later. Add one, or ask Oscar to.'
                : 'Completed and cancelled tasks will collect here.'}
              action={status === 'open'
                ? <Button variant="primary" onClick={() => setCreating(true)}>
                    <Plus className="size-4" /> New task
                  </Button>
                : undefined}
            />
          </Card>
        ) : (
          <div className="space-y-7">
            {sections.map(sec => (
              <section key={sec.key}>
                {/* Overdue is the only heading that is a problem rather than a fact, so it
                    is the only one coloured. */}
                <SectionHeading count={sec.tasks.length}>
                  <span style={sec.key === 'overdue' ? { color: '#DC2626' } : undefined}>
                    {sec.label}
                  </span>
                </SectionHeading>
                <div className="space-y-2">
                  {sec.tasks.map(t => (
                    <div id={`task-${t.id}`} className="rounded-2xl transition"
                         style={glow === t.id
                           ? { boxShadow: '0 0 0 2px var(--accent)' } : undefined}>
                      <TaskCard key={t.id} task={t} busy={busyId === t.id}
                              onToggle={() => void toggle(t)}
                              onOpen={() => { comments.markSeen(t.id); setOpenTask(t) }}
                        unreadComments={comments.byItem.get(t.id)} showAssignee />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )
      )}

      {openTask && (
        <TaskDetail task={openTask} focusThread={focusThread}
                    onClose={() => { setOpenTask(null); setFocusThread(false) }}
                    onChanged={() => { mine.reload(); source.reload() }} />
      )}
      {creating && (
        <NewTaskSheet onClose={() => setCreating(false)}
                      onCreated={() => { setCreating(false); mine.reload() }} />
      )}
    </div>
  )
}
