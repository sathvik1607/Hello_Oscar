import { useCallback, useState } from 'react'
import { ApiError, tasks as tasksApi } from '../../lib/api'
import type { Task } from '../../lib/types'

/**
 * Completing and reopening a task, optimistically, with a real rollback.
 *
 * Optimistic because the round trip is 200–400ms and a checkbox that waits for it
 * feels broken. With a rollback because an optimistic update that cannot fail is a
 * lie: the task shows as done, the write 403s, and the truth only reappears on the
 * next refetch — by which point the user has moved on believing it landed.
 *
 * `busyId` exists so the same card cannot be toggled twice while in flight. Two
 * completes on one task is harmless (complete_item is idempotent), but a
 * complete-then-reopen race resolves in arrival order, not click order.
 */
/** `T extends { tasks: Task[] }` rather than the literal shape: the list endpoints
 *  return `{count, tasks}` and a narrower parameter type silently rejects them —
 *  which is a compile error at every call site rather than a runtime bug, but the
 *  fix is the generic, not a cast at each caller. */
export function useTaskActions<T extends { tasks: Task[] }>(
  patch: (fn: (prev: T) => T) => void,
  reload: () => void,
) {
  const [busyId, setBusyId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  const toggle = useCallback(async (task: Task) => {
    if (busyId === task.id) return
    setBusyId(task.id)
    setError(null)

    const done = task.status === 'completed'
    const next: Task['status'] = done ? 'pending' : 'completed'

    patch(prev => ({
      ...prev,
      tasks: prev.tasks.map(t => t.id === task.id
        ? { ...t, status: next,
            // Clear the overdue flag on completion so the card stops shouting
            // before the refetch confirms it. Restored on rollback with the rest.
            is_overdue: next === 'completed' ? false : t.is_overdue,
            completed_at: next === 'completed' ? new Date().toISOString() : null }
        : t),
    }))

    try {
      if (done) {
        // Reopening goes through /status — there is no un-complete endpoint, and
        // this is the path that correctly clears completed_at.
        await tasksApi.setStatus(task.id, 'pending')
      } else {
        // 🔴 The dedicated complete route, never PATCH /items {status:'completed'}.
        // That one setattrs the field and skips completed_at, the timeline row and
        // the notification to whoever assigned it — a completion the assigner is
        // never told about.
        await tasksApi.complete(task.id)
      }
      // Refetch even on success: completing a subtask can change a parent's
      // risk_flag, and completing a shared task moves a counter this client cannot
      // compute. Cheap, and the alternative is a list that is subtly wrong.
      reload()
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e))
      reload()                              // put the truth back
    } finally {
      setBusyId(null)
    }
  }, [busyId, patch, reload])

  return { toggle, busyId, error, clearError: () => setError(null) }
}
