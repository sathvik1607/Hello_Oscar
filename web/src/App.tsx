import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { applyTheme, isSignedIn, onSessionChange } from './lib/session'
import { reset as resetSocket, subscribe } from './lib/appSocket'
import { AppShell } from './shell/AppShell'
import type { SectionId } from './shell/nav'
import { NAV } from './shell/nav'
import { AuthScreen } from './features/auth/AuthScreen'
import { TodayScreen } from './features/today/TodayScreen'
import { VoiceProvider } from './features/voice/VoiceProvider'
import { Spinner } from './ui'

/**
 * Root. Two states — signed out and signed in — and a hash router.
 *
 * A hash router rather than react-router: this app has nine flat sections and no
 * nested routes, so a router dependency would be ~15 kB to replace one
 * `location.hash` read. The hash also means the app can be served from any path on
 * any static host with no rewrite rule, which is the thing that actually breaks
 * SPA deploys.
 *
 * Today is imported eagerly because it is the landing screen and lazy-loading it
 * would add a network round trip to the very first paint. Everything else is split:
 * Chat and the voice engine are the two largest chunks and most sessions open
 * neither.
 */

const TasksScreen = lazy(() => import('./features/tasks/TasksScreen')
  .then(m => ({ default: m.TasksScreen })))
const CalendarScreen = lazy(() => import('./features/calendar/CalendarScreen')
  .then(m => ({ default: m.CalendarScreen })))
const ChatScreen = lazy(() => import('./features/chat/ChatScreen')
  .then(m => ({ default: m.ChatScreen })))
const NotesScreen = lazy(() => import('./features/notes/NotesScreen')
  .then(m => ({ default: m.NotesScreen })))
const PersonalizeScreen = lazy(() => import('./features/personalize/PersonalizeScreen')
  .then(m => ({ default: m.PersonalizeScreen })))
const TeamScreen = lazy(() => import('./features/team/TeamScreen')
  .then(m => ({ default: m.TeamScreen })))
const MessagesScreen = lazy(() => import('./features/messages/MessagesScreen')
  .then(m => ({ default: m.MessagesScreen })))
const NotificationsScreen = lazy(() => import('./features/notifications/NotificationsScreen')
  .then(m => ({ default: m.NotificationsScreen })))
const SettingsScreen = lazy(() => import('./features/settings/SettingsScreen')
  .then(m => ({ default: m.SettingsScreen })))

const VALID = new Set<string>(NAV.map(n => n.id))

function sectionFromHash(): SectionId {
  const h = location.hash.replace(/^#\/?/, '')
  return (VALID.has(h) ? h : 'today') as SectionId
}

export default function App() {
  const [signedIn, setSignedIn] = useState(isSignedIn())
  const [section, setSection] = useState<SectionId>(sectionFromHash)

  // Theme before anything paints, so there is no flash of the wrong one.
  useEffect(() => {
    applyTheme()
    // Follow the OS while the setting is "system". Without this a laptop switching
    // to dark at sunset leaves the app light until a reload.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Sign-in / sign-out from anywhere — including a 401 inside the api client — has
  // to move the WHOLE app, not just the screen that noticed.
  useEffect(() => onSessionChange(() => {
    const now = isSignedIn()
    setSignedIn(now)
    // Tear the old user's socket down before the new one's is created, or the
    // previous subscription outlives the session that authorised it.
    resetSocket()
    if (!now) { location.hash = ''; setSection('today') }
  }), [])

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const navigate = useCallback((s: SectionId) => {
    location.hash = `#/${s}`
    setSection(s)
    // Sections are separate pages conceptually; landing halfway down the previous
    // one's scroll position reads as a rendering bug.
    window.scrollTo({ top: 0 })
  }, [])

  if (!signedIn) return <AuthScreen />

  return (
    <VoiceProvider>
      <LiveTitle />
      <AppShell section={section} onNavigate={navigate}>
        <Suspense fallback={<Spinner />}>
          {section === 'today' && <TodayScreen />}
          {section === 'tasks' && <TasksScreen />}
          {section === 'calendar' && <CalendarScreen />}
          {section === 'chat' && <ChatScreen />}
          {section === 'notes' && <NotesScreen />}
          {section === 'personalize' && <PersonalizeScreen />}
          {section === 'team' && <TeamScreen />}
          {section === 'messages' && <MessagesScreen />}
          {section === 'notifications' && <NotificationsScreen onNavigate={navigate} />}
          {section === 'settings' && <SettingsScreen />}
        </Suspense>
      </AppShell>
    </VoiceProvider>
  )
}

/**
 * Unread count in the tab title.
 *
 * Mounted at the root so ONE subscription serves the whole app. Counting inside the
 * Notifications screen instead would mean the badge only worked while you were
 * looking at the badge.
 */
function LiveTitle() {
  const [unread, setUnread] = useState(0)

  useEffect(() => subscribe(f => {
    if (f.type === 'notification.created') setUnread(n => n + 1)
  }), [])

  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, '')
    document.title = unread > 0 ? `(${unread}) ${base}` : base
  }, [unread])

  // Opening Activity is the natural "I have seen these" signal.
  useEffect(() => {
    const onHash = () => {
      if (location.hash.includes('notifications')) setUnread(0)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return null
}
