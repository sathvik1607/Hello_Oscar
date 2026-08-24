import {
  Bell, CalendarDays, CheckSquare, Cog, Home, MessageSquare, MessagesSquare,
  NotebookPen, Sparkles, Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type SectionId =
  | 'today' | 'tasks' | 'calendar' | 'chat' | 'notes'
  | 'personalize' | 'team' | 'messages' | 'notifications' | 'settings'

export type NavItem = {
  id: SectionId
  label: string
  icon: LucideIcon
  /** Sections that make no sense without a team are hidden rather than shown
   *  broken. A personal account that taps "Team" and gets an error learns that
   *  the app is unreliable; one that never sees the tab learns nothing wrong. */
  needsTeam?: boolean
  /** Shown in the mobile bottom bar. Five is the most that fits without the
   *  labels truncating; the rest live behind "More". */
  primary?: boolean
}

/**
 * Ordered by how often it is reached for, not by feature grouping. Three bands,
 * and the bands are the point:
 *
 *   daily        Today, Chat, Tasks, Calendar
 *   collaborate  Messages, My Team
 *   occasional   Notes, Activity, then configuration last
 *
 * CHAT SITS SECOND because it is the product — "ask, and it acts" — and it was
 * buried below two screens that mostly READ the data Chat can change.
 *
 * PERSONALIZE MOVED DOWN next to Settings. It teaches Oscar how you work: heavily
 * used for a day, then almost never, so it was occupying a slot near the top for
 * the rest of the account's life.
 *
 * ACTIVITY SITS LOW ON PURPOSE — the header already carries a bell with an unread
 * dot, so the nav entry is the second way to reach it, not the first.
 *
 * ⚠️ `primary` is the MOBILE BOTTOM BAR, so this list controls two navigations at
 * once. The same four items stay primary; only their order changes, which is why
 * Chat moving up is a deliberate call and not a side effect.
 */
export const NAV: NavItem[] = [
  { id: 'today',         label: 'Today',    icon: Home,           primary: true },
  { id: 'chat',          label: 'Chat',     icon: MessagesSquare, primary: true },
  { id: 'tasks',         label: 'Tasks',    icon: CheckSquare,    primary: true },
  { id: 'calendar',      label: 'Calendar', icon: CalendarDays,   primary: true },
  { id: 'messages',      label: 'Messages', icon: MessageSquare, needsTeam: true },
  { id: 'team',          label: 'My Team',  icon: Users, needsTeam: true },
  { id: 'notes',         label: 'Notes',    icon: NotebookPen },
  { id: 'notifications', label: 'Activity', icon: Bell },
  { id: 'personalize',   label: 'Personalize', icon: Sparkles },
  { id: 'settings',      label: 'Settings', icon: Cog },
]

export const TITLES: Record<SectionId, { title: string; subtitle: string }> = {
  today:         { title: 'Today',    subtitle: 'What needs you right now' },
  tasks:         { title: 'Tasks',    subtitle: 'Everything on your plate' },
  calendar:      { title: 'Calendar', subtitle: 'Meetings and scheduled time' },
  chat:          { title: 'Oscar',    subtitle: 'Ask, and it acts' },
  notes:         { title: 'Notes',    subtitle: 'Context Oscar remembers' },
  personalize:   { title: 'Personalize', subtitle: 'Teach Oscar how you work' },
  team:          { title: 'My Team',  subtitle: 'Who is on what' },
  messages:      { title: 'Messages', subtitle: 'Team chat and direct messages' },
  notifications: { title: 'Activity', subtitle: 'Everything Oscar has told you' },
  settings:      { title: 'Settings', subtitle: 'Account, voice and connection' },
}
