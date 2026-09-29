import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bell, CalendarClock, CheckCircle2, CheckSquare, MessageSquare, UserPlus,
} from 'lucide-react'
import { notifications as notifApi, team as teamApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { subscribe } from '../../lib/appSocket'
import { getUser } from '../../lib/session'
import { messageTime, parseUtcNaive, stripDedupMarker } from '../../lib/format'
import { notifyAllRead, notifyOneRead } from '../../lib/unread'
import { openNotification } from '../../lib/notifRouting'
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

// Routing (destination-by-type, DM peer resolution) moved to lib/notifRouting.ts
// so NotificationToasts can route identically instead of a second copy.

export function NotificationsScreen({ onNavigate }: {
  onNavigate: (s: SectionId,
               target?: { id: number; thread?: boolean; peer?: boolean }) => void
}) {
  const n = useApi(s => notifApi.list(false, s), [], 'notifications')
  const me = getUser()
  // Shares the 'members' cache key with every other screen, so it costs no request.
  const roster = useApi(s => (me?.team_id ? teamApi.members(me.team_id, s)
                                         : Promise.resolve([])),
                        [me?.team_id], 'members')
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
      // The frame does not carry it, and a synthesized row must not pretend
      // otherwise — the refetch that follows replaces this with the real row.
      update_request_id: null,
      created_at: new Date().toISOString(),
      read_at: null,
    }, ...prev])
  }), [])

  const rows = useMemo(() => {
    const server = n.data ?? []
    // Live frames whose real row has since arrived would otherwise show twice.
    // Matched on message text because the frame has no id to match on.
    const seen = new Set(server.map(r => r.message))
    // 🔴 Sorted by created_at, NEVER by id. A live frame carries no notification
    // id, so the synthetic one here is a negative epoch value — ordering by id
    // would interleave live rows with real ones arbitrarily. The Flutter client
    // hits the same trap from the other direction, with ~1.7e12 placeholders.
    const merged = [...live.filter(l => !seen.has(l.message)), ...server]
      .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
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
      notifyAllRead()
    } finally { setBusy(false) }
  }, [n])

  const open = useCallback(async (row: AppNotification) => {
    // Optimistic: the row greys out immediately. A read receipt that waits for a
    // round trip makes every tap feel unregistered.
    if (!row.is_read && row.id > 0) {
      n.patch(prev => prev.map(r => r.id === row.id ? { ...r, is_read: 1 } : r))
      try { await notifApi.markRead(row.id); notifyOneRead() } catch { n.reload() }
    }
    // Routing itself (dest resolution, item_id vs. DM-peer resolution) lives in
    // lib/notifRouting.ts — shared with NotificationToasts, see that module's
    // comments for the item_id-is-not-a-foreign-key and DM-peer caveats.
    openNotification(row, roster.data ?? [], onNavigate)
  }, [n, onNavigate, roster.data])

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
          /**
           * 🔴 NAIVE UTC, NOT IST — this row was 5h30m wrong on every notification.
           *
           * `pa_notifications.created_at` defaults to `datetime.now` on the SERVER
           * (models/orm_models.py), and the server's clock is UTC, so it arrives as
           * a bare "2026-09-03 05:47:53" with no offset. Reading it as IST moved
           * every timestamp 5h30m into the past: a reminder that had just fired
           * showed as "12:17 am". Verified against oscar_dev — a notification
           * written seconds before the check read 05:47 while UTC was 05:48, and
           * matched pa_task_comments, which is documented naive UTC.
           *
           * `parseUtcNaive` is the right helper for both shapes here: it assumes UTC
           * only for a BARE string, and trusts an explicit offset. That matters
           * because the optimistic row this screen synthesises from a live WS frame
           * uses `new Date().toISOString()`, which carries a Z — so server rows and
           * live rows now agree instead of differing by the offset.
           *
           * ⚠️ Not parseIstNaive with a swap: due_at/scheduled_at ARE IST-naive and
           * still need that helper. The two conventions coexist by design.
           */
          const at = parseUtcNaive(row.created_at)
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
                    {stripDedupMarker(row.message)}
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
