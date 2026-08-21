import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bell, CalendarClock, CheckCircle2, CheckSquare, MessageSquare, UserPlus,
} from 'lucide-react'
import { notifications as notifApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { subscribe } from '../../lib/appSocket'
import { messageTime, parseIstNaive } from '../../lib/format'
import type { AppNotification, NotificationType } from '../../lib/types'
import type { SectionId } from '../../shell/nav'
import { Button, Card, EmptyState, ErrorState, Skeleton, cx } from '../../ui'

/**
 * Everything Oscar has told you.
 *
 * Live: a new `notification.created` frame prepends without a refetch, so the bell
 * is correct the moment a reminder fires rather than on the next navigation.
 *
 * Tapping deep-links by type. `item_id` is a plain int and NOT a foreign key —
 * rows pointing at deleted items exist in the live database today — so a tap can
 * legitimately resolve to nothing. It navigates to the right SECTION and does not
 * pretend to open a specific item that may be gone.
 */

const ICONS: Partial<Record<NotificationType, typeof Bell>> = {
  task_assigned: CheckSquare, task_reminder: Bell, task_updated: CheckSquare,
  task_completed: CheckCircle2, task_deleted: CheckSquare,
  meeting_update: CalendarClock,
  task_comment: MessageSquare, meeting_comment: MessageSquare,
  direct_message: MessageSquare,
  update_request: UserPlus, update_response: UserPlus,
}

/** Where a notification of each type belongs. Mirrors the backend's own
 *  `_fcm_route` so a tap in the browser lands where a tap on the phone would. */
const ROUTE: Partial<Record<NotificationType, SectionId>> = {
  task_assigned: 'tasks', task_reminder: 'tasks', task_updated: 'tasks',
  task_completed: 'tasks', task_deleted: 'tasks', task_comment: 'tasks',
  meeting_update: 'calendar', meeting_comment: 'calendar',
  direct_message: 'chat',
}

export function NotificationsScreen({ onNavigate }: { onNavigate: (s: SectionId) => void }) {
  const n = useApi(s => notifApi.list(false, s))
  const [live, setLive] = useState<AppNotification[]>([])
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState<'all' | 'unread'>('all')

  useEffect(() => subscribe(f => {
    if (f.type !== 'notification.created') return
    const p = (f.payload ?? {}) as Record<string, unknown>
    setLive(prev => [{
      // The frame carries no notification id, so a synthetic negative one keeps it
      // distinct from every server row and safely un-markable-as-read until the
      // next refetch replaces it with the real thing.
      id: -Date.now(),
      user_id: Number(p.user_id ?? 0),
      type: String(p.notif_type ?? 'task_reminder') as NotificationType,
      message: String(p.message ?? ''),
      is_read: 0,
      item_id: p.item_id != null ? Number(p.item_id) : null,
      created_at: new Date().toISOString(),
      read_at: null,
    }, ...prev])
  }), [])

  const rows = useMemo(() => {
    const server = n.data ?? []
    // Live frames whose real row has since arrived would otherwise show twice.
    // Matched on message text because the frame has no id to match on.
    const seen = new Set(server.map(r => r.message))
    const merged = [...live.filter(l => !seen.has(l.message)), ...server]
    return filter === 'unread' ? merged.filter(r => !r.is_read) : merged
  }, [n.data, live, filter])

  const unread = useMemo(
    () => [...(n.data ?? []), ...live].filter(r => !r.is_read).length, [n.data, live])

  const markAll = useCallback(async () => {
    setBusy(true)
    try {
      await notifApi.markAllRead()
      setLive([])
      n.reload()
    } finally { setBusy(false) }
  }, [n])

  const open = useCallback(async (row: AppNotification) => {
    // Optimistic: the row greys out immediately. A read receipt that waits for a
    // round trip makes every tap feel unregistered.
    if (!row.is_read && row.id > 0) {
      n.patch(prev => prev.map(r => r.id === row.id ? { ...r, is_read: 1 } : r))
      try { await notifApi.markRead(row.id) } catch { n.reload() }
    }
    const dest = ROUTE[row.type]
    if (dest) onNavigate(dest)
  }, [n, onNavigate])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div role="tablist" className="flex gap-1 rounded-xl p-1"
             style={{ background: 'var(--bg-sunken)' }}>
          {(['all', 'unread'] as const).map(f => (
            <button key={f} role="tab" aria-selected={filter === f}
                    onClick={() => setFilter(f)}
                    className="rounded-lg px-3 py-1.5 text-[13px] font-medium capitalize transition"
                    style={filter === f
                      ? { background: 'var(--bg-elevated)', color: 'var(--text)' }
                      : { color: 'var(--text-muted)' }}>
              {f}
              {f === 'unread' && unread > 0 && (
                <span className="ml-1.5 tabular-nums opacity-60">{unread}</span>
              )}
            </button>
          ))}
        </div>
        {unread > 0 && (
          <Button size="sm" loading={busy} onClick={() => void markAll()}>
            Mark all read
          </Button>
        )}
      </div>

      {n.loading && !n.data && <Skeleton rows={5} />}
      {n.error && !n.data && <ErrorState error={n.error} onRetry={n.reload} />}

      {!n.loading && rows.length === 0 && (
        <Card>
          <EmptyState
            icon={<Bell className="size-6" />}
            title={filter === 'unread' ? 'Nothing unread' : 'Nothing yet'}
            body="Reminders, task assignments and comments arrive here."
          />
        </Card>
      )}

      <div className="space-y-2">
        {rows.map(row => {
          const Icon = ICONS[row.type] ?? Bell
          const at = parseIstNaive(row.created_at) ?? (row.created_at ? new Date(row.created_at) : null)
          return (
            <Card key={row.id}
                  className={cx('transition', !!row.is_read && 'opacity-60')}>
              <button onClick={() => void open(row)}
                      className="flex w-full items-start gap-3 p-3.5 text-left">
                <div className="mt-px grid size-8 shrink-0 place-items-center rounded-lg"
                     style={{ background: row.is_read ? 'var(--bg-sunken)' : 'var(--accent-soft)',
                              color: row.is_read ? 'var(--text-subtle)' : 'var(--accent)' }}>
                  <Icon className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={cx('break-words text-[14px] leading-snug',
                                   !row.is_read && 'font-medium')}>
                    {row.message}
                  </p>
                  <div className="mt-1 text-[11px] tabular-nums"
                       style={{ color: 'var(--text-subtle)' }}>
                    {at ? messageTime(at.toISOString()) : ''}
                    {' · '}{row.type.replace(/_/g, ' ')}
                  </div>
                </div>
                {!row.is_read && (
                  <span className="mt-1.5 size-2 shrink-0 rounded-full"
                        style={{ background: 'var(--accent)' }} />
                )}
              </button>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
