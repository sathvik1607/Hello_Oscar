/**
 * Where a notification of each type belongs, and how to resolve a deep-link
 * target for it — the ONE place this logic lives. Previously only inside
 * NotificationsScreen.open(); pulled out so the live in-app toast (NotificationToasts)
 * can route identically instead of carrying its own, second copy that could drift.
 */
import type { AppNotification, NotificationType } from './types'
import type { SectionId } from '../shell/nav'

/** Mirrors the backend's own `_fcm_route` so an in-app tap lands where a tap on
 *  the phone would. */
export const NOTIF_ROUTE: Partial<Record<NotificationType, SectionId>> = {
  task_assigned: 'tasks', task_reminder: 'tasks', task_updated: 'tasks',
  task_completed: 'tasks', task_deleted: 'tasks', task_comment: 'tasks',
  meeting_update: 'calendar', meeting_comment: 'calendar',
  direct_message: 'messages',
  update_request: 'team', update_response: 'team',
  // kiosk_lead deliberately absent — see NotificationsScreen's own note: the lead
  // exists only in the notification's text, no row/list/screen to land on.
}

/** The sender's name out of "💬 Sriram: hi" — the DM row carries no peer id, so
 *  the message's own fixed server-side prefix is the only way back to the thread.
 *  Longest-name-first, anchored at the start: see NotificationsScreen's dmPeerFrom
 *  comment for the "Sri" vs "Sriram" collision this guards against. */
export function dmPeerFrom(message: string, roster: { user_id: number; name: string }[]): number | null {
  const body = message.replace(/^💬\s*/, '')
  let best: { id: number; len: number } | null = null
  for (const m of roster) {
    if (!m.name) continue
    if (!body.toLowerCase().startsWith(`${m.name.toLowerCase()}:`)) continue
    if (!best || m.name.length > best.len) best = { id: m.user_id, len: m.name.length }
  }
  return best?.id ?? null
}

export type NavigateFn = (s: SectionId,
  target?: { id: number; thread?: boolean; peer?: boolean }) => void

/** Resolve + perform the navigation for one notification row, exactly as a bell
 *  tap does. Shared by NotificationsScreen (server rows) and NotificationToasts
 *  (live WS frames) — same row shape, same destination either way. */
export function openNotification(
  row: AppNotification,
  roster: { user_id: number; name: string }[],
  onNavigate: NavigateFn,
): void {
  const dest = NOTIF_ROUTE[row.type]
  if (!dest) return
  if (row.type === 'direct_message') {
    const peer = dmPeerFrom(row.message, roster)
    onNavigate(dest, peer ? { id: peer, peer: true } : undefined)
    return
  }
  onNavigate(dest, row.item_id
    ? { id: row.item_id, thread: row.type.includes('comment') }
    : undefined)
}
