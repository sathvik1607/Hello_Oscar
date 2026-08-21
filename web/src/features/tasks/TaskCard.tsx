import { AlertCircle, Check, MessageSquare, Users } from 'lucide-react'
import type { Task } from '../../lib/types'
import { dueLabel, parseIstNaive, relative } from '../../lib/format'
import { Badge, Card, cx } from '../../ui'

/**
 * One task, everywhere. Today, Tasks and Team all render this — three
 * near-identical cards is how a status colour ends up meaning two different things
 * on two screens.
 *
 * The checkbox is the primary action and it is on the card, not behind a detail
 * screen. Completing a task is the most common thing anyone does here, and making
 * it a two-navigation operation is the difference between a tool and a form.
 */
export function TaskCard({ task, onToggle, onOpen, busy, showAssignee }: {
  task: Task
  onToggle: () => void
  onOpen: () => void
  busy?: boolean
  showAssignee?: boolean
}) {
  const due = parseIstNaive(task.due_at)
  const done = task.status === 'completed'
  const terminal = done || task.status === 'cancelled'
  const shared = (task.assignee_count ?? task.assignees.length) > 1

  return (
    <Card className={cx('group transition', terminal && 'opacity-60')}>
      <div className="flex items-start gap-3 p-3.5">
        {/* Its own button, not a click on the row: a row that both opens and
            completes means every mis-tap either loses your place or marks work
            done that is not. */}
        <button
          onClick={onToggle}
          disabled={busy || task.status === 'cancelled'}
          aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
          className={cx('mt-px grid size-5 shrink-0 place-items-center rounded-md border-2',
                        'transition disabled:opacity-40')}
          style={done
            ? { background: '#22C55E', borderColor: '#22C55E' }
            : { borderColor: 'var(--border-strong)' }}
        >
          {done && <Check className="size-3 text-white" strokeWidth={3.5} />}
        </button>

        <button onClick={onOpen} className="min-w-0 flex-1 text-left">
          <div className={cx('text-[14.5px] font-medium leading-snug',
                             done && 'line-through')}>
            {task.title}
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {/* Overdue replaces the plain due time rather than sitting beside it —
                two time labels on one row is noise, and "3h overdue" already
                contains everything "6:30 pm" said. */}
            {task.is_overdue && !terminal ? (
              <Badge tone="overdue">
                <AlertCircle className="size-3" /> {relative(due)}
              </Badge>
            ) : due ? (
              <span className="text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>
                {dueLabel(due)}
              </span>
            ) : (
              <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>No time set</span>
            )}

            {task.priority === 'high' && !terminal && <Badge tone="high">High</Badge>}
            {task.status === 'in_progress' && <Badge tone="in_progress">In progress</Badge>}
            {task.status === 'blocked' && <Badge tone="blocked">Blocked</Badge>}

            {shared && (
              <Badge tone="neutral">
                <Users className="size-3" />
                {task.assignees_done ?? 0}/{task.assignee_count ?? task.assignees.length}
              </Badge>
            )}

            {/* Shown only when it is somebody ELSE's — on your own list, "assigned
                to you" on every row is a column of noise. */}
            {showAssignee && !task.is_mine && task.assigned_to_name && (
              <span className="text-xs" style={{ color: 'var(--text-subtle)' }}>
                {task.assigned_to_name}
              </span>
            )}

            {!!task.subtask_count && (
              <span className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-subtle)' }}>
                <MessageSquare className="size-3" /> {task.subtask_count}
              </span>
            )}
          </div>
        </button>
      </div>
    </Card>
  )
}
