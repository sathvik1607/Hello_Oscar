import { useEffect, useRef } from 'react'
import { subscribe } from './appSocket'
import { invalidate } from './cache'

/**
 * Live task and meeting changes.
 *
 * 🔴 THIS WAS MISSING, and it is why a task created on the phone — or by Oscar in
 * chat — did not appear until a manual refresh. The backend has always broadcast
 * `task.{created|updated|completed|deleted}` and `meeting.{…}` over the same socket
 * this app already holds (ws/realtime_service.broadcast_item, to owner + assignee);
 * the web client simply never listened. So the data was arriving and being thrown
 * away, which is the worst version of the bug: it looks like the server is slow.
 *
 * DEBOUNCED, and that is not an optimisation. One user action can produce several
 * frames — completing a subtask updates the parent, a bulk reschedule fires per
 * item, and the day rollover re-dates every overdue task at once. Reloading per
 * frame would mean a dozen identical requests and a list that visibly reshuffles a
 * dozen times.
 *
 * A RELOAD rather than a patch from the payload, deliberately. The frame carries a
 * flattened item, not the shape `_format_task` returns: no `is_mine`, no
 * `assignees[]`, no `due_label`, and no per-viewer rewrite of `assigned_to_*`.
 * Patching from it would quietly produce rows that disagree with a fetched one —
 * and `is_mine` is exactly the field a home screen filters on.
 */
export function useItemEvents(onChange: () => void, debounceMs = 300) {
  // Held in a ref so a caller passing an inline arrow does not re-subscribe on
  // every render, which would drop frames in the gap between unsubscribe and
  // resubscribe.
  //
  // Synced in an effect rather than assigned during render: a render can be
  // discarded (StrictMode, Suspense, a re-render React throws away), and writing
  // to a ref during one leaves the ref holding a callback from a render that never
  // committed.
  const cb = useRef(onChange)
  useEffect(() => { cb.current = onChange }, [onChange])

  // Declared AFTER the sync above, so on every render the ref is already current
  // before this effect can fire — effects run in declaration order.
  useEffect(() => {
    let timer: number | undefined

    const unsub = subscribe(f => {
      if (!isItemFrame(f.type)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        // Drop the shared caches BEFORE reloading, or the screens that are not
        // mounted would serve a stale list the moment you navigate to them.
        invalidate('tasks:')
        invalidate('meetings:')
        cb.current()
      }, debounceMs) as unknown as number
    })

    return () => {
      if (timer) clearTimeout(timer)
      unsub()
    }
  }, [debounceMs])
}

const ITEM_OPS = ['created', 'updated', 'completed', 'deleted']

function isItemFrame(type: string): boolean {
  const [entity, op] = type.split('.')
  return (entity === 'task' || entity === 'meeting') && ITEM_OPS.includes(op)
}
