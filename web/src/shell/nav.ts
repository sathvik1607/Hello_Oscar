import {
  Bell, CalendarDays, CheckSquare, Cog, Home, MessageSquare, MessagesSquare,
  NotebookPen, Users,
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
 * ORDER AND LABELS MIRROR THE FLUTTER APP, so the two clients do not teach two
 * different vocabularies for the same screens. From
 * `lib/design_system/components/bottom_navigation.dart`:
 *
 *   Today · My Team · OscarAI · Calendar · Chats
 *
 * The renames matter more than the order. Flutter calls the assistant **OscarAI**
 * and the messaging screen **Chats**; the web app called them "Chat" and
 * "Messages", so "Chat" here meant the assistant while "Chats" there meant talking
 * to people — the two most confusable names pointing at opposite things.
 *
 * ⚠️ ONE DELIBERATE DEVIATION. `primary` drives the mobile bottom bar, and the web
 * bar is four tabs plus a "More" button where Flutter has five tabs and no More.
 * So Chats stays out of the bar rather than crowding it to six slots. Sidebar order
 * still matches.
 *
 * Flutter also has no separate Tasks tab for a team user — that slot IS "My Team".
 * The web sidebar has room for both, so Tasks keeps its own entry, placed after the
 * five shared ones.
 */
export const NAV: NavItem[] = [
  { id: 'today',         label: 'Today',    icon: Home,           primary: true },
  { id: 'team',          label: 'My Team',  icon: Users, needsTeam: true },
  { id: 'chat',          label: 'OscarAI',  icon: MessagesSquare, primary: true },
  { id: 'calendar',      label: 'Calendar', icon: CalendarDays,   primary: true },
  { id: 'messages',      label: 'Chats',    icon: MessageSquare, needsTeam: true },
  { id: 'tasks',         label: 'Tasks',    icon: CheckSquare,    primary: true },
  { id: 'notes',         label: 'Notes',    icon: NotebookPen },
  { id: 'notifications', label: 'Activity', icon: Bell },
  { id: 'settings',      label: 'Settings', icon: Cog },
]

export const TITLES: Record<SectionId, { title: string; subtitle: string }> = {
  today:         { title: 'Today',    subtitle: 'What needs you right now' },
  tasks:         { title: 'Tasks',    subtitle: 'Everything on your plate' },
  calendar:      { title: 'Calendar', subtitle: 'Meetings and scheduled time' },
  chat:          { title: 'OscarAI',  subtitle: 'Ask, and it acts' },
  notes:         { title: 'Notes',    subtitle: 'Context Oscar remembers' },
  personalize:   { title: 'Personalize', subtitle: 'Teach Oscar how you work' },
  team:          { title: 'My Team',  subtitle: 'Who is on what' },
  messages:      { title: 'Chats',    subtitle: 'Team chat and direct messages' },
  notifications: { title: 'Activity', subtitle: 'Everything Oscar has told you' },
  settings:      { title: 'Settings', subtitle: 'Account, voice and connection' },
}
