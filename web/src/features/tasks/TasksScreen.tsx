import { useMemo, useState } from 'react'
import { CheckSquare, Plus } from 'lucide-react'
import { tasks as tasksApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { ITEM_CACHES, ITEM_FRAMES, useLiveData } from '../../lib/useLiveData'
import type { Task } from '../../lib/types'
import { BUCKET_META, BUCKET_ORDER, completedToday, groupTasks } from './buckets'
import { TaskCard } from './TaskCard'
import { TaskDetail } from './TaskDetail'
import { NewTaskSheet } from './NewTaskSheet'
import { useTaskActions } from './useTaskActions'
import {
  Button, Card, EmptyState, ErrorState, SectionHeading, Skeleton, cx,
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
 * Delegated work is a separate tab rather than mixed in. `is_mine` is the test for
 * "mine" — the legacy `assigned_to_user_id` names only the primary assignee, so on
 * a shared task it answers wrong for everybody else.
 */
type Tab = 'mine' | 'delegated' | 'done'

export function TasksScreen() {
  const [tab, setTab] = useState<Tab>('mine')
  const [openTask, setOpenTask] = useState<Task | null>(null)
  const [creating, setCreating] = useState(false)

  const mine = useApi(s => tasksApi.mine(s), [], 'tasks:mine')
  // Fetched only when its tab is opened. Both are extra round trips against a
  // backend where a cold request can take seconds; loading them eagerly would make
  // the default tab wait for data nobody asked for.
  const delegated = useApi(
    s => tab === 'delegated' ? tasksApi.assignedByMe(s) : Promise.resolve({ count: 0, tasks: [] }),
    [tab])
  const doneAll = useApi(
    s => tab === 'done' ? tasksApi.completed(s) : Promise.resolve({ count: 0, tasks: [] }),
    [tab])

  const source = tab === 'delegated' ? delegated : tab === 'done' ? doneAll : mine
  const { toggle, busyId, error: actionError } = useTaskActions(source.patch, source.reload)

  useLiveData(ITEM_FRAMES, () => { mine.reload(); source.reload() },
              { invalidatePrefixes: ITEM_CACHES })

  // See TodayScreen: `?? []` allocates per render and would defeat this memo.
  const allMine = useMemo(() => mine.data?.tasks ?? [], [mine.data])
  const groups = useMemo(() => groupTasks(allMine), [allMine])
  const openCount = BUCKET_ORDER.reduce((n, k) => n + groups[k].length, 0)

  const delegatedActive = useMemo(
    () => (delegated.data?.tasks ?? []).filter(t => t.status !== 'cancelled'),
    [delegated.data])

  const doneList = useMemo(() => {
    const rows = doneAll.data?.tasks ?? []
    // Newest first — a completed list read chronologically forwards buries today
    // under three months of history.
    return [...rows].sort((a, b) =>
      (b.completed_at ?? '').localeCompare(a.completed_at ?? ''))
  }, [doneAll.data])

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'mine', label: 'Open', count: openCount },
    { id: 'delegated', label: 'Delegated' },
    { id: 'done', label: 'Done', count: completedToday(allMine).length || undefined },
  ]

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div role="tablist" aria-label="Task view"
             className="flex gap-1 rounded-xl p-1" style={{ background: 'var(--bg-sunken)' }}>
          {TABS.map(t => (
            <button
              key={t.id} role="tab" aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={cx('rounded-lg px-3 py-1.5 text-[13px] font-medium transition')}
              style={tab === t.id
                ? { background: 'var(--bg-elevated)', color: 'var(--text)' }
                : { color: 'var(--text-muted)' }}
            >
              {t.label}
              {t.count !== undefined && t.count > 0 && (
                <span className="ml-1.5 tabular-nums opacity-60">{t.count}</span>
              )}
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

      {/* ── open, in bucket order ────────────────────────────────────── */}
      {tab === 'mine' && !!mine.data && (
        openCount === 0 ? (
          <Card>
            <EmptyState
              icon={<CheckSquare className="size-6" />}
              title="Nothing open"
              body="Every task is done or scheduled for later. Add one, or ask Oscar to."
              action={<Button variant="primary" onClick={() => setCreating(true)}>
                <Plus className="size-4" /> New task
              </Button>}
            />
          </Card>
        ) : (
          <div className="space-y-7">
            {BUCKET_ORDER.filter(k => groups[k].length > 0).map(k => (
              <section key={k}>
                <SectionHeading count={groups[k].length}>
                  {BUCKET_META[k].label}
                </SectionHeading>
                <div className="space-y-2">
                  {groups[k].map(t => (
                    <TaskCard key={t.id} task={t} busy={busyId === t.id}
                              onToggle={() => void toggle(t)}
                              onOpen={() => setOpenTask(t)} showAssignee />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )
      )}

      {/* ── delegated ────────────────────────────────────────────────── */}
      {tab === 'delegated' && !!delegated.data && (
        delegatedActive.length === 0 ? (
          <Card>
            <EmptyState
              title="You haven't delegated anything"
              body="Tasks you assign to someone else show up here, with their progress."
            />
          </Card>
        ) : (
          <div className="space-y-2">
            {delegatedActive.map(t => (
              <TaskCard key={t.id} task={t} busy={busyId === t.id}
                        onToggle={() => void toggle(t)}
                        onOpen={() => setOpenTask(t)} showAssignee />
            ))}
          </div>
        )
      )}

      {/* ── done ─────────────────────────────────────────────────────── */}
      {tab === 'done' && !!doneAll.data && (
        doneList.length === 0 ? (
          <Card><EmptyState title="Nothing finished yet" body="Completed tasks collect here." /></Card>
        ) : (
          <div className="space-y-2">
            {doneList.map(t => (
              <TaskCard key={t.id} task={t} busy={busyId === t.id}
                        onToggle={() => void toggle(t)}
                        onOpen={() => setOpenTask(t)} />
            ))}
          </div>
        )
      )}

      {openTask && (
        <TaskDetail task={openTask} onClose={() => setOpenTask(null)}
                    onChanged={() => { mine.reload(); source.reload() }} />
      )}
      {creating && (
        <NewTaskSheet onClose={() => setCreating(false)}
                      onCreated={() => { setCreating(false); mine.reload() }} />
      )}
    </div>
  )
}
