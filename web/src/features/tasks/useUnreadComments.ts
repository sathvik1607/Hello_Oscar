import { useCallback, useMemo } from 'react'
import { notifications as notifApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { subscribe } from '../../lib/appSocket'
import { useEffect } from 'react'

/**
 * How many UNREAD comments sit on each task, keyed by item id.
 *
 * 🔴 DERIVED FROM NOTIFICATIONS, because that is the only per-user read state that
 * exists. `_format_task` exposes `subtask_count` but no comment count, and
 * `pa_task_comments` has no per-viewer read column — so "has this person seen this
 * comment" is answerable in exactly one place: the `is_read` flag on the
 * `task_comment` / `meeting_comment` bell row the backend already writes for every
 * comment (DB-only; the WS frame and FCM go out by hand).
 *
 * That makes the count honest rather than approximate: it is the same fact the
 * Activity list shows, counted per item instead of listed.
 *
 * Costs no extra request. It shares the `notifications` cache key with
 * NotificationsScreen, so whichever mounts first pays for the fetch.
 */
export function useUnreadComments() {
  const n = useApi(s => notifApi.list(false, s), [], 'notifications')

  // A new comment arrives as a notification.created frame, so the badge appears
  // without a poll or a manual refresh.
  const reload = n.reload
  useEffect(() => subscribe(f => {
    if (f.type !== 'notification.created') return
    const t = (f.payload as { notif_type?: string } | undefined)?.notif_type
    if (t && t.includes('comment')) reload()
  }), [reload])

  const byItem = useMemo(() => {
    const map = new Map<number, number>()
    for (const row of n.data ?? []) {
      // `item_id` is a plain int and NOT a foreign key, so a row can point at a
      // deleted task. Counting it is harmless — no card carries that id, so the
      // count simply never renders.
      if (!row.item_id || row.is_read) continue
      if (!row.type.includes('comment')) continue
      map.set(row.item_id, (map.get(row.item_id) ?? 0) + 1)
    }
    return map
  }, [n.data])

  /**
   * Called when a task is opened. Marks its comment rows read so the badge clears —
   * the same thing tapping the row in Activity does, because it is the same rows.
   *
   * Optimistic, then fire-and-forget: the badge must vanish on the tap, and a failed
   * mark-read is recoverable on the next fetch. Silent on failure for the same
   * reason — an error toast about a badge is worse than a badge that lingers.
   */
  const markSeen = useCallback((itemId: number) => {
    const rows = (n.data ?? []).filter(
      r => r.item_id === itemId && !r.is_read && r.type.includes('comment'))
    if (rows.length === 0) return
    n.patch(prev => prev.map(r =>
      rows.some(x => x.id === r.id) ? { ...r, is_read: 1 } : r))
    for (const r of rows) void notifApi.markRead(r.id).catch(() => {})
  }, [n])

  return { byItem, markSeen }
}
