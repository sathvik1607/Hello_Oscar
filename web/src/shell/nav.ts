import {
  Bell, CalendarDays, CheckSquare, Home, MessageSquare, MessagesSquare, Users,
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
 * 🔴 MY TEAM IS IN THE BAR, TASKS IS NOT — and this is the SECOND way the web bar
 * follows Flutter rather than diverging from it: Flutter has no separate Tasks tab
 * for a team user either, because that slot IS "My Team". Tasks keeps its sidebar
 * entry and its route; on a phone it lives behind More.
 *
 * The reasoning is what each screen answers. Today is your own work, and Tasks is
 * the same work again with a filter and a search over it — a second copy of a
 * screen already in the bar. My Team answers a question nothing else does (who is
 * on what) and is now scoped to today, so it is a glance rather than a backlog.
 * Searching for an old task is a deliberate trip; seeing the team is a check you
 * make repeatedly.
 *
 * ⚠️ A PERSONAL ACCOUNT GETS THREE TABS, not four — My Team is `needsTeam`, and
 * AppShell filters by team BEFORE picking the primaries. That is correct rather
 * than something to pad: Tasks is one tap away in More for exactly those users,
 * who have no team screen to want.
 */
export const NAV: NavItem[] = [
  { id: 'today',         label: 'Today',    icon: Home,           primary: true },
  { id: 'team',          label: 'My Team',  icon: Users, needsTeam: true, primary: true },
  { id: 'chat',          label: 'OscarAI',  icon: MessagesSquare, primary: true },
  { id: 'calendar',      label: 'Calendar', icon: CalendarDays,   primary: true },
  { id: 'messages',      label: 'Chats',    icon: MessageSquare, needsTeam: true },
  { id: 'tasks',         label: 'Tasks',    icon: CheckSquare },
  /* Notes is HIDDEN from NAV, like Personalize. Route, screen and TITLES all stay —
     `/notes` still works and the backend endpoints are untouched — so bringing it
     back is uncommenting one line, not rebuilding a feature. */
  // { id: 'notes',         label: 'Notes',    icon: NotebookPen },
  { id: 'notifications', label: 'Activity', icon: Bell },
  /* 🔴 SETTINGS IS NOT IN THIS LIST. It is reached by tapping the account block at
     the bottom of the sidebar (AppShell) — where you already look to see which
     account is signed in. Kept out of NAV so it stops taking a row from the nine
     destinations people actually move between; the route and the screen are
     unchanged, only the way in. */
]

/**
 * Every routable section — including the three that are deliberately absent from
 * NAV (`notes`, `personalize`, `settings`).
 *
 * 🔴 THE ROUTER MUST VALIDATE AGAINST THIS, NOT AGAINST `NAV`. NAV is the SIDEBAR;
 * a section being hidden from it says nothing about whether its URL is real. Built
 * from TITLES because that record is typed `Record<SectionId, …>`, so the compiler
 * refuses to let a new section be added without appearing here — a hand-written
 * second list would silently fall out of date, which is exactly how `/settings`
 * came to resolve to Today.
 */
export const SECTION_IDS = (): SectionId[] => Object.keys(TITLES) as SectionId[]

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
