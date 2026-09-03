import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Bell, CalendarClock, CheckCircle2, CheckSquare, MessageSquare, UserPlus,
} from 'lucide-react'
import { notifications as notifApi, team as teamApi } from '../../lib/api'
import { useApi } from '../../lib/useApi'
import { subscribe } from '../../lib/appSocket'
import { getUser } from '../../lib/session'
import { messageTime, parseUtcNaive } from '../../lib/format'
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
  /* 🔴 'messages', NOT 'chat'. This said 'chat' — which in this app is OscarAI, the
     assistant — so tapping "💬 Sriram: hi" opened a conversation with the AI instead
     of with Sriram. The two most confusable section names in the product point at
     opposite things (see shell/nav.ts), and this was the bug that mistake produces. */
  direct_message: 'messages',
  /* An update request and its answer are both team work, and the only screen that
     shows them is My Team. Previously absent from this table entirely, so those rows
     were dead to the touch. */
  update_request: 'team', update_response: 'team',
  /* kiosk_lead is deliberately NOT here. The lead exists only in the notification's
     own text — there is no lead row, no list endpoint and no screen — so any
     destination would be a dead end. It stays readable in place, which is honest.
     (This is the same gap that makes the mobile push land on "Page Not Found".) */
}

/** The sender's name out of "💬 Sriram: hi".
 *
 *  The DB row for a DM carries NO peer id — `notification_service.send` is called
 *  without one, and only the FCM payload gets `peer_id`. So the name in the message
 *  is the sole way back to the conversation from the Activity list, and it is a
 *  fixed server-side format (`f"💬 {sender_name}: {message}"`), not a guess.
 *
 *  🔴 LONGEST NAME FIRST, and the match must be anchored at the start. With members
 *  "Sri" and "Sriram", a short-first scan resolves Sriram's message to Sri and opens
 *  the wrong person's thread — the same wrong-recipient class this project already
 *  has a live incident from. Returns null rather than a best guess when nothing
 *  matches exactly. */
function dmPeerFrom(message: string, roster: { user_id: number; name: string }[]): number | null {
  const body = message.replace(/^💬\s*/, '')
  let best: { id: number; len: number } | null = null
  for (const m of roster) {
    if (!m.name) continue
    if (!body.toLowerCase().startsWith(`${m.name.toLowerCase()}:`)) continue
    if (!best || m.name.length > best.len) best = { id: m.user_id, len: m.name.length }
  }
  return best?.id ?? null
}

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
    if (!dest) return
    /**
     * Same two signals the Flutter app sends (fcm_service._routeWithTarget):
     *   · the item id, so the screen can scroll to and glow the exact row
     *   · thread=1 for any type containing "comment", so the task's detail — where
     *     the comment thread lives — opens on top rather than the row merely glowing
     *
     * 🔴 item_id IS NOT A FOREIGN KEY. Four rows in this database already point at
     * deleted items, so a target can legitimately resolve to nothing; the screen has
     * to treat a miss as "that item is gone", not as a blank sheet. And
     * `meeting_update` rows carry item_id = NULL, so those still land on the section
     * only — which is why the id is passed conditionally rather than assumed.
     */
    if (row.type === 'direct_message') {
      // Resolved from the message text because the row has no peer id. A miss lands
      // on the Chats list, which is still the right screen — never a wrong thread.
      const peer = dmPeerFrom(row.message, roster.data ?? [])
      onNavigate(dest, peer ? { id: peer, peer: true } : undefined)
      return
    }
    onNavigate(dest, row.item_id
      ? { id: row.item_id, thread: row.type.includes('comment') }
      : undefined)
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
