import { ArrowLeft, ListChecks } from 'lucide-react'
import { TaskCard } from '../tasks/TaskCard'
import { TaskDetail } from '../tasks/TaskDetail'
import { Card } from '../../ui'
import type { Task } from '../../lib/types'

/**
 * The side panel: what Oscar's last answer is ABOUT, beside the conversation.
 *
 * Deliberately NOT cards inline in the transcript. Inline, they push the
 * conversation around, they pile up once for every question asked, and old cards
 * from three questions ago stay on screen competing with the current answer. On the
 * side there is exactly one set — the one belonging to the answer just given — and
 * the conversation stays a conversation.
 *
 * Two levels, one column: the list of tasks the reply named, and one task opened.
 * Opening REPLACES the list rather than stacking a sheet on top, because the panel
 * is already the detail surface — a sheet over a panel would be two floating layers
 * for one object.
 */
export function OscarPanel({ tasks, openTask, onOpen, onBack, onToggle, busyId, onChanged }: {
  tasks: Task[]
  openTask: Task | null
  onOpen: (t: Task) => void
  onBack: () => void
  onToggle: (t: Task) => void
  busyId?: number | null
  onChanged: () => void
}) {
  // ── one task, opened ──────────────────────────────────────────────────────
  if (openTask) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* Back, not close: the list is where you came from, and dismissing the
            whole panel would lose the answer's context along with the task. */}
        <button onClick={onBack}
                className="mb-2 flex items-center gap-1.5 self-start rounded-lg px-1 py-1
                           text-[12.5px] font-medium transition hover:brightness-95"
                style={{ color: 'var(--text-muted)' }}>
          <ArrowLeft className="size-3.5" />
          {tasks.length > 1 ? `Back to ${tasks.length} tasks` : 'Back'}
        </button>
        <div className="min-h-0 flex-1">
          <TaskDetail inline task={openTask} onClose={onBack} onChanged={onChanged} />
        </div>
      </div>
    )
  }

  // ── the tasks the answer named ────────────────────────────────────────────
  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b px-4 py-3"
           style={{ borderColor: 'var(--border)' }}>
        <ListChecks className="size-4" style={{ color: 'var(--text-subtle)' }} />
        <span className="text-[13px] font-semibold">
          {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
        </span>
        <span className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>
          from your last question
        </span>
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {tasks.map(t => (
          <TaskCard key={t.id} task={t} busy={busyId === t.id}
                    onToggle={() => onToggle(t)} onOpen={() => onOpen(t)}
                    showAssignee />
        ))}
      </div>
    </Card>
  )
}

/** Kept for the narrow layout, where there is no side to put a panel on. Without
 *  this the feature simply disappears on a phone, which is worse than cards that
 *  live in the transcript. */
export function InlineCards({ tasks, onOpen, onToggle, busyId }: {
  tasks: Task[]
  onOpen: (t: Task) => void
  onToggle: (t: Task) => void
  busyId?: number | null
}) {
  if (tasks.length === 0) return null
  return (
    <div className="mt-2 max-w-[520px] space-y-1.5">
      {tasks.map(t => (
        <TaskCard key={t.id} task={t} busy={busyId === t.id}
                  onToggle={() => onToggle(t)} onOpen={() => onOpen(t)} showAssignee />
      ))}
    </div>
  )
}
