import {
  Bell, CalendarDays, CheckSquare, Cog, Home, MessagesSquare,
  NotebookPen, Sparkles, Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type SectionId =
  | 'today' | 'tasks' | 'calendar' | 'chat' | 'notes'
  | 'personalize' | 'team' | 'notifications' | 'settings'

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

export const NAV: NavItem[] = [
  { id: 'today',         label: 'Today',    icon: Home,           primary: true },
  { id: 'tasks',         label: 'Tasks',    icon: CheckSquare,    primary: true },
  { id: 'calendar',      label: 'Calendar', icon: CalendarDays,   primary: true },
  { id: 'chat',          label: 'Chat',     icon: MessagesSquare, primary: true },
  { id: 'notes',         label: 'Notes',    icon: NotebookPen },
  { id: 'personalize',   label: 'Personalize', icon: Sparkles },
  { id: 'team',          label: 'Team',     icon: Users, needsTeam: true },
  { id: 'notifications', label: 'Activity', icon: Bell },
  { id: 'settings',      label: 'Settings', icon: Cog },
]

export const TITLES: Record<SectionId, { title: string; subtitle: string }> = {
  today:         { title: 'Today',    subtitle: 'What needs you right now' },
  tasks:         { title: 'Tasks',    subtitle: 'Everything on your plate' },
  calendar:      { title: 'Calendar', subtitle: 'Meetings and scheduled time' },
  chat:          { title: 'Oscar',    subtitle: 'Ask, and it acts' },
  notes:         { title: 'Notes',    subtitle: 'Context Oscar remembers' },
  personalize:   { title: 'Personalize', subtitle: 'Teach Oscar how you work' },
  team:          { title: 'Team',     subtitle: 'Who is on what' },
  notifications: { title: 'Activity', subtitle: 'Everything Oscar has told you' },
  settings:      { title: 'Settings', subtitle: 'Account, voice and connection' },
}
