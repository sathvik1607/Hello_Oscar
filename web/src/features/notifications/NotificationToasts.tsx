/**
 * Live in-app toast for every `notification.created` frame — so a new task/
 * meeting/comment/DM/update-request is VISIBLE the instant it lands, not silent
 * until someone happens to open Activity or notices the bell badge. Additive:
 * the bell and Activity list are unchanged, this is a second, louder surface for
 * the same events (and pairs with the audible beep in lib/push.ts — that plays,
 * this shows what it was about).
 *
 * A lightweight portal, not ui/Portal — that one locks body scroll for a
 * blocking modal, which a toast must never be.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Bell, CalendarClock, CheckCircle2, CheckSquare, MessageSquare, UserPlus, X,
} from 'lucide-react'
import { subscribe } from '../../lib/appSocket'
import { notifications as notifApi, team as teamApi } from '../../lib/api'
import { getUser } from '../../lib/session'
import { stripDedupMarker } from '../../lib/format'
import { notifyOneRead } from '../../lib/unread'
import { NOTIF_ROUTE, openNotification } from '../../lib/notifRouting'
import type { AppNotification, NotificationType } from '../../lib/types'
import type { NavigateFn } from '../../lib/notifRouting'

const ICONS: Partial<Record<NotificationType, typeof Bell>> = {
  task_assigned: CheckSquare, task_reminder: Bell, task_updated: CheckSquare,
  task_completed: CheckCircle2, task_deleted: CheckSquare,
  meeting_update: CalendarClock,
  task_comment: MessageSquare, meeting_comment: MessageSquare,
  direct_message: MessageSquare,
  update_request: UserPlus, update_response: UserPlus,
}

const _AUTO_DISMISS_MS = 6000

type Toast = { key: number; row: AppNotification }

export function NotificationToasts({ onNavigate }: { onNavigate: NavigateFn }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const [host] = useState(() =>
    typeof document === 'undefined' ? null : document.createElement('div'))
  // Roster for DM-peer resolution — read once per mount via a plain call rather
  // than useApi, since this component's whole lifetime is the app shell and a
  // stale roster costs nothing worse than a DM toast falling back to the Chats
  // list (openNotification's own documented miss behavior).
  const rosterRef = useRef<{ user_id: number; name: string }[]>([])

  useEffect(() => {
    if (!host) return
    document.body.appendChild(host)
    return () => { host.remove() }
  }, [host])

  useEffect(() => {
    const me = getUser()
    if (!me?.team_id) return
    teamApi.members(me.team_id).then(rows => { rosterRef.current = rows })
      .catch(() => { /* DM toasts just fall back to the Chats list */ })
  }, [])

  const dismiss = useCallback((key: number) => {
    setToasts(prev => prev.filter(t => t.key !== key))
  }, [])

  /** A toast's row is synthetic (negative id from the WS frame, which carries no
   *  real notification id — same gap NotificationsScreen's own live rows have).
   *  Resolve the REAL id by message text against the current unread list, same
   *  key NotificationsScreen already dedupes live-vs-server rows on, so a toast
   *  click marks read exactly like clicking the row in Activity would. Silently
   *  gives up if the row can't be found (already read elsewhere, or the fetch
   *  fails) — a toast click always still navigates regardless. */
  const markToastRead = useCallback(async (row: AppNotification) => {
    try {
      const unread = await notifApi.list(true)
      const match = unread.find(r => r.message === row.message)
      if (!match) return
      await notifApi.markRead(match.id)
      notifyOneRead()
    } catch { /* best-effort — navigation already happened */ }
  }, [])

  useEffect(() => subscribe(f => {
    if (f.type !== 'notification.created') return
    const p = (f.payload ?? {}) as Record<string, unknown>
    const type = String(p.notif_type ?? 'task_reminder') as NotificationType
    // Silently-dropped types (no ROUTE entry, e.g. kiosk_lead) still deserve a
    // toast — they are readable in place, same as their Activity-list row; only
    // the click-to-navigate becomes a no-op, matching openNotification's own
    // behavior for a type absent from NOTIF_ROUTE.
    const row: AppNotification = {
      id: -Date.now(),
      user_id: Number(p.user_id ?? 0),
      type,
      message: String(p.message ?? ''),
      is_read: 0,
      item_id: p.item_id != null ? Number(p.item_id) : null,
      update_request_id: null,
      created_at: new Date().toISOString(),
      read_at: null,
    }
    const key = Date.now() + Math.random()
    setToasts(prev => {
      // Same defensive dedup NotificationsScreen applies against ITS OWN live
      // list (matched on message text — a frame carries no notification id) —
      // needed here for a real, observed cause: React StrictMode's dev-only
      // double-invoke of this effect can leave two subscriptions briefly alive
      // across the simulated remount, so the same single backend send is
      // delivered to both before the discarded one's cleanup runs. Confirmed via
      // the backend log sending exactly once; this is a client-side symptom,
      // production (no StrictMode double-mount) is not expected to hit it, but
      // the guard costs nothing and protects against a genuine double-send too.
      if (prev.some(t => t.row.message === row.message)) return prev
      return [{ key, row }, ...prev]
    })
    setTimeout(() => dismiss(key), _AUTO_DISMISS_MS)
  }), [dismiss])

  if (!host || toasts.length === 0) return null

  return createPortal(
    <div className="fixed right-4 top-4 z-[100] flex w-full max-w-sm flex-col gap-2"
         aria-live="polite">
      {toasts.map(({ key, row }) => {
        const Icon = ICONS[row.type] ?? Bell
        const clickable = row.type in NOTIF_ROUTE
        return (
          <div key={key}
               role="status"
               onClick={clickable
                 ? () => {
                     dismiss(key)
                     openNotification(row, rosterRef.current, onNavigate)
                     void markToastRead(row)
                   }
                 : undefined}
               className={clickable ? 'cursor-pointer' : undefined}
               style={{
                 background: 'var(--bg-elevated)', borderColor: 'var(--border)',
                 boxShadow: '0 8px 24px rgba(0,0,0,0.16)',
               }}
          >
            <div className="flex items-start gap-3 rounded-[var(--radius-card)] border p-3"
                 style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}>
              <div className="mt-0.5 shrink-0 rounded-full p-1.5"
                   style={{ background: 'var(--bg-sunken)', color: 'var(--text-muted)' }}>
                <Icon size={15} />
              </div>
              <div className="min-w-0 flex-1 text-[13px] leading-snug"
                   style={{ color: 'var(--text)' }}>
                {stripDedupMarker(row.message)}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); dismiss(key) }}
                aria-label="Dismiss"
                className="shrink-0 rounded-md p-1 opacity-60 transition hover:opacity-100"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )
      })}
    </div>,
    host,
  )
}
