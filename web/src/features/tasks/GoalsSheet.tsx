import { useState } from 'react'
import { ArrowLeft, Hash, Target, X } from 'lucide-react'
import { goals as goalsApi, type GoalTasks } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { getUser } from '../../lib/session'
import { dueLabel, parseIstNaive } from '../../lib/format'
import type { Task } from '../../lib/types'
import { TaskCard } from './TaskCard'
import { TaskDetail } from './TaskDetail'
import { useTaskActions } from './useTaskActions'
import { Card, EmptyState, ErrorState, IconButton, Portal, Skeleton } from '../../ui'

/**
 * BRD P0.7/P0.8 — browse Goals and drill into one's tasks.
 *
 * Deliberately a SEPARATE sheet from the Open/Done filter on TasksScreen, not
 * a third chip there — Goal membership is a different axis from status (which
 * goal a task belongs to, not whether it's done), and that screen's own
 * history already explains why extra status chips didn't earn their place.
 * This is opened from its own button instead.
 *
 * Two levels in one component, like TaskDetail's own two-mode shape (create
 * vs edit) — a goal LIST, then that goal's TASK list — because the interesting
 * state (which goal is picked) lives here and splitting it into two sheets
 * would mean passing it back up just to pass it back down.
 */
export function GoalsSheet({ onClose, onOpenTask }: {
  onClose: () => void
  /** A task picked from a goal's list opens the SAME TaskDetail the rest of the
   *  app uses, layered over this sheet — not a second, goal-scoped detail view. */
  onOpenTask?: (task: Task) => void
}) {
  const me = getUser()
  const teamId = me?.team_id
  const [pickedGoal, setPickedGoal] = useState<Task | null>(null)
  const [openTask, setOpenTask] = useState<Task | null>(null)

  const goalsList = useApi(
    s => teamId ? goalsApi.forTeam(teamId, s) : Promise.resolve({ count: 0, goals: [] }),
    [teamId])

  const goalTasks = useApi(
    s => pickedGoal ? goalsApi.tasks(pickedGoal.id, s) : Promise.resolve<GoalTasks | null>(null),
    [pickedGoal?.id])
  // useTaskActions needs `{ tasks: Task[] }`, not the nullable wrapper
  // useApi's `data` can be before the first fetch resolves — patch/reload are
  // no-ops while no goal is picked, which matches the JSX below never
  // reading goalTasks in that state anyway.
  const { toggle, busyId } = useTaskActions<GoalTasks>(
    fn => goalTasks.patch(prev => (prev ? fn(prev) : prev)),
    goalTasks.reload)

  return (
    <Portal>
      <button aria-label="Close" onClick={onClose}
              className="fade fixed inset-0 z-[70] bg-black/30" />
      <div
        role="dialog" aria-modal="true" aria-label={pickedGoal ? pickedGoal.title : 'Goals'}
        className="rise fixed inset-x-0 bottom-0 z-[71] max-h-[90vh] overflow-y-auto
                   rounded-t-3xl border-t p-4
                   sm:inset-0 sm:m-auto sm:h-fit sm:max-w-md sm:rounded-2xl sm:border"
        style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)',
                 paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)' }}
      >
        <div className="mb-3.5 flex items-center gap-2">
          {pickedGoal && (
            <IconButton label="Back to goals" onClick={() => setPickedGoal(null)}>
              <ArrowLeft className="size-5" />
            </IconButton>
          )}
          <h2 className="flex-1 truncate text-[15px] font-semibold">
            {pickedGoal ? pickedGoal.title : 'Goals'}
          </h2>
          <IconButton label="Close" onClick={onClose}><X className="size-5" /></IconButton>
        </div>

        {!pickedGoal && (
          <>
            {goalsList.loading && !goalsList.data && <Skeleton rows={5} />}
            {goalsList.error && !goalsList.data && (
              <ErrorState error={goalsList.error} onRetry={goalsList.reload} />
            )}
            {!teamId && !goalsList.loading && (
              <EmptyState
                icon={<Target className="size-6" />}
                title="No goals yet"
                body="Goals belong to a team. Join or create one to start using them."
              />
            )}
            {!!goalsList.data && teamId && (
              goalsList.data.goals.length === 0 ? (
                <EmptyState
                  icon={<Target className="size-6" />}
                  title="No goals yet"
                  body="Ask Oscar to create one, or add a #tag to a task to make a new one automatically."
                />
              ) : (
                <div className="space-y-2">
                  {goalsList.data.goals.map(g => (
                    <button key={g.id} onClick={() => setPickedGoal(g)}
                            className="flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left transition hover:opacity-90"
                            style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}>
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-full"
                           style={{ background: 'var(--accent-subtle)' }}>
                        <Target className="size-4" style={{ color: 'var(--accent)' }} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px] font-medium">{g.title}</div>
                        <div className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--text-subtle)' }}>
                          {g.tag && (
                            <span className="inline-flex items-center gap-0.5">
                              <Hash className="size-3" />{g.tag.replace(/^#/, '')}
                            </span>
                          )}
                          {g.due_at && <span>{dueLabel(parseIstNaive(g.due_at))}</span>}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )
            )}
          </>
        )}

        {pickedGoal && (
          <>
            {goalTasks.loading && !goalTasks.data && <Skeleton rows={4} />}
            {goalTasks.error && !goalTasks.data && (
              <ErrorState error={goalTasks.error} onRetry={goalTasks.reload} />
            )}
            {!!goalTasks.data && (
              goalTasks.data.tasks.length === 0 ? (
                <Card>
                  <EmptyState
                    icon={<Target className="size-6" />}
                    title="No tasks yet"
                    body={`Nothing is under "${pickedGoal.title}" yet.`}
                  />
                </Card>
              ) : (
                <div className="space-y-2">
                  {goalTasks.data.tasks.map(t => (
                    <TaskCard key={t.id} task={t} busy={busyId === t.id}
                              onToggle={() => void toggle(t)}
                              onOpen={() => (onOpenTask ? onOpenTask(t) : setOpenTask(t))} />
                  ))}
                </div>
              )
            )}
          </>
        )}
      </div>

      {/* Only used when the caller doesn't handle task-open itself (onOpenTask
          absent) — TasksScreen passes its own handler so a picked task opens
          the SAME detail sheet/state the rest of that screen already manages,
          rather than this component owning a second copy of that state. */}
      {!onOpenTask && openTask && (
        <TaskDetail task={openTask} onClose={() => setOpenTask(null)}
                    onChanged={() => goalTasks.reload()} />
      )}
    </Portal>
  )
}
