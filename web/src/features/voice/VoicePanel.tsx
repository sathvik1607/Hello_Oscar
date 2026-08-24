import { useState } from 'react'
import { ListChecks, X } from 'lucide-react'
import { TaskCard } from '../tasks/TaskCard'
import { TaskDetail } from '../tasks/TaskDetail'
import { IconButton } from '../../ui'
import type { Task } from '../../lib/types'

/**
 * The tasks Oscar just spoke about, on the right of the voice screen.
 *
 * Voice says "you have one task today: Verify Oscar task cards at six PM" and then
 * the words are gone — there is nothing to tick off and nothing to open. This puts
 * the real card beside the orb while it is still being talked about.
 *
 * 🔴 THE MIC STAYS OPEN AND THE CALL KEEPS RUNNING. Nothing here interrupts
 * playback or navigates: the whole point is acting on what was said WITHOUT
 * dropping the conversation. Tapping a card opens the task in place rather than
 * routing to the Tasks screen, and DISMISSING the panel does not end the call —
 * it is the cards being put away, not the conversation.
 *
 * Renders nothing when the reply named nothing. The panel appearing for a greeting
 * would make an empty column part of the normal voice screen.
 */
export function VoicePanel({ tasks, onToggle, busyId, onChanged, onDismiss, onEditStart }: {
  tasks: Task[]
  onToggle: (t: Task) => void
  busyId?: number | null
  onChanged: () => void
  onDismiss: () => void
  /** Ends the call. Editing needs the keyboard and a quiet mic — see TaskDetail. */
  onEditStart: () => void
}) {
  const [open, setOpen] = useState<Task | null>(null)
  if (tasks.length === 0) return null

  // Re-read the open task from the refreshed list, so completing it in the detail
  // view is reflected here rather than showing the snapshot it opened with.
  const openTask = open ? (tasks.find(t => t.id === open.id) ?? open) : null

  return (
    <aside aria-label="What Oscar mentioned"
           className="fade hidden w-[380px] shrink-0 flex-col gap-2 overflow-hidden
                      border-l p-4 lg:flex xl:w-[420px]"
           style={{ borderColor: 'var(--border)', background: 'var(--bg-elevated)' }}>
      {openTask ? (
        <>
          <button onClick={() => setOpen(null)}
                  className="self-start text-[12.5px] font-medium"
                  style={{ color: 'var(--text-muted)' }}>
            ← {tasks.length > 1 ? `Back to ${tasks.length} tasks` : 'Back'}
          </button>
          <div className="min-h-0 flex-1">
            {/* `inline`, so it is a column in this panel and not a modal sheet
                floating over the voice screen — which would cover the orb and the
                End call button. */}
            <TaskDetail inline task={openTask} onEditStart={onEditStart}
                        onClose={() => setOpen(null)} onChanged={onChanged} />
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-2 px-1 pb-1">
            <ListChecks className="size-4" style={{ color: 'var(--text-subtle)' }} />
            <span className="text-[13px] font-semibold">
              {tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}
            </span>
            <span className="text-[11px]" style={{ color: 'var(--text-subtle)' }}>
              mentioned
            </span>
            <div className="flex-1" />
            {/* Dismisses the CARDS, not the call. The panel stays until asked to go,
                because the reply that produced it is already gone. */}
            <IconButton label="Dismiss" onClick={onDismiss}>
              <X className="size-3.5" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
            {tasks.map(t => (
              <TaskCard key={t.id} task={t} busy={busyId === t.id}
                        onToggle={() => onToggle(t)} onOpen={() => setOpen(t)}
                        showAssignee />
            ))}
          </div>
        </>
      )}
    </aside>
  )
}
