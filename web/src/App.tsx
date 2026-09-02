import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { applyTheme, isSignedIn, onSessionChange } from './lib/session'
import { reset as resetSocket } from './lib/appSocket'
import { notifyActivityOpened, useUnreadCount } from './lib/unread'
import { AppShell } from './shell/AppShell'
import type { SectionId } from './shell/nav'
import { SECTION_IDS } from './shell/nav'
import { AuthScreen } from './features/auth/AuthScreen'
import { TodayScreen } from './features/today/TodayScreen'
import { VoiceProvider } from './features/voice/VoiceProvider'
import { Spinner } from './ui'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { checkFreshness, watchBuildMismatch } from './lib/freshness'

/**
 * Root. Two states — signed out and signed in — and a path router.
 *
 * Hand-rolled rather than react-router: ten flat sections, no nested routes and no
 * route params, so a router dependency would be ~15 kB to replace one
 * `location.pathname` read.
 *
 * 🔴 CLEAN PATHS MAKE THE HOST'S SPA REWRITE LOAD-BEARING. `/tasks` is a request
 * for a file that does not exist, so without `vercel.json`'s
 * `"/(.*)" → "/index.html"` a refresh or a shared link 404s. Nothing in `tsc` or
 * `vite build` can catch that — it is a hosting concern — so removing that rewrite
 * breaks production silently. It was previously described as belt-and-braces
 * because the hash never reached the server at all; that is no longer true.
 * Serving the app from a SUBPATH would additionally need Vite's `base`.
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

/**
 * 🔴 FROM `SECTION_IDS`, NOT FROM `NAV`.
 *
 * This was `new Set(NAV.map(n => n.id))` — and NAV is the sidebar, which
 * deliberately omits `settings`, `personalize` and `notes`. So those three paths
 * failed validation and fell back to Today: opening `/settings` directly, or
 * refreshing while on it, silently dropped you on the home screen. Invisible while
 * the URL was a fragment nobody read; obvious the moment paths became shareable.
 */
const VALID = new Set<string>(SECTION_IDS())

function sectionFromPath(): SectionId {
  const p = location.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  return (VALID.has(p) ? p : 'today') as SectionId
}

/**
 * `#/tasks` → `/tasks`, once, at boot.
 *
 * 🔴 REQUIRED, NOT COSMETIC. A fragment is never sent to the server, so no rewrite
 * and no redirect rule on any host can act on an old link — the only place that can
 * possibly translate one is here, after the page has loaded. Three
 * `hellooscarweb.vercel.app/#/messages` links were already sent to testers and live
 * in `pa_direct_messages`; without this they land on Today.
 *
 * `replaceState`, so Back does not bounce between the old and new form of the same
 * address. Returns the section it resolved, so the initial render is correct rather
 * than a flash of Today.
 */
function adoptLegacyHash(): SectionId | null {
  const m = /^#\/?([a-z-]+)\/?$/.exec(location.hash)
  const hit = m && VALID.has(m[1]) ? (m[1] as SectionId) : null
  if (hit) history.replaceState(null, '', `/${hit}`)
  // A hash that resolves to nothing is still stripped — leaving `#/garbage` in the
  // bar next to a clean path reads as two routers disagreeing.
  else if (location.hash) history.replaceState(null, '', location.pathname)
  return hit
}

export default function App() {
  const [signedIn, setSignedIn] = useState(isSignedIn())
  // Is this tab running code from an earlier deploy? Two independent detectors,
  // either sufficient: X-App-Version on any response (immediate, free), and an
  // asset-hash comparison against a re-fetched index.html (works with a backend
  // that sends no header). Latched true — a version cannot un-stale itself, and
  // flickering the gate off would drop the user back into the broken app.
  const [staleVersion, setStaleVersion] = useState(false)
  // Runs the legacy-hash rewrite BEFORE the first read, so an old link renders its
  // real section immediately instead of showing Today and then correcting itself.
  const [section, setSection] = useState<SectionId>(
    () => adoptLegacyHash() ?? sectionFromPath())

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

  /**
   * Stale-code detection. Sends the tab to the login screen with a one-line
   * notice — see the `staleVersion` branch below.
   *
   * Two independent detectors, either sufficient:
   *  · X-App-Version on any API response — immediate and free, since it rides
   *    requests the app was making anyway.
   *  · an asset-hash comparison against a re-fetched index.html — covers a backend
   *    that sends no such header, and catches a tab whose first action is a reload.
   *
   * Re-probed when the tab regains focus, which is when a long-lived tab is most
   * likely to have gone stale. Latched: a build cannot un-stale itself, and letting
   * the gate flicker off would drop someone back into the broken app.
   */
  useEffect(() => {
    let alive = true
    const mark = () => { if (alive) setStaleVersion(true) }
    const unwatch = watchBuildMismatch(m => { if (m) mark() })
    const probe = () => { void checkFreshness().then(f => { if (f === 'stale') mark() }) }
    probe()
    const onVis = () => { if (document.visibilityState === 'visible') probe() }
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      unwatch()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  // Sign-in / sign-out from anywhere — including a 401 inside the api client — has
  // to move the WHOLE app, not just the screen that noticed.
  useEffect(() => onSessionChange(() => {
    const now = isSignedIn()
    setSignedIn(now)
    // Tear the old user's socket down before the new one's is created, or the
    // previous subscription outlives the session that authorised it.
    resetSocket()
    // replaceState, NOT pushState: a pushed entry means Back re-enters the app you
    // just signed out of, which reads as the sign-out having failed.
    if (!now) { history.replaceState(null, '', '/'); setSection('today') }
  }), [])

  /**
   * Deep-link target for the section being opened, mirroring the Flutter app.
   *
   * Mobile builds `route?highlight=<item_id>` and appends `&thread=1` when the
   * notification type contains "comment" (fcm_service._routeWithTarget). The web
   * had neither: NotificationsScreen threw item_id away and navigated to the bare
   * section, so tapping "Sriram: yoyooo" dropped you into a list of 100 tasks with
   * no clue which one he had commented on.
   *
   * Held in state rather than parsed back out of the hash on every render — the hash
   * is the shareable address, this is a one-shot instruction to the screen that is
   * about to mount, and it must not survive a manual refresh.
   */
  const [target, setTarget] = useState<
    { id: number; thread?: boolean; peer?: boolean } | null>(null)

  /* A path that resolves to nothing, or a trailing slash, leaves an address in the
     bar that does not match what was rendered. Normalised once on mount — after the
     first paint, so it cannot affect which section was chosen. */
  useEffect(() => {
    const raw = location.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!raw) return
    const canonical = VALID.has(raw) ? `/${raw}` : '/'
    if (location.pathname !== canonical) history.replaceState(null, '', canonical)
  }, [])

  // Back and Forward. `popstate` fires in exactly the situations `hashchange` did,
  // so this is a substitution rather than a new mechanism — and, as before, the
  // deep-link `target` is NOT restored: going back to /tasks should show the list,
  // not silently re-open a sheet you already closed.
  useEffect(() => {
    const onPop = () => { setSection(sectionFromPath()); setTarget(null) }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((s: SectionId,
                               t?: { id: number; thread?: boolean; peer?: boolean }) => {
    // pushState so Back returns to where you were. The path is absolute from the
    // root — the app is served at `/`, and a relative push would nest (`/tasks` then
    // `/tasks/chat`) on the second navigation.
    history.pushState(null, '', `/${s}`)
    setSection(s)
    setTarget(t ?? null)
    // Opening Activity is the "I have seen these" signal for the badge. Fired from
    // the navigation itself rather than from a URL listener: `hashchange` never
    // fired when the hash was set to the value it already held, so re-opening
    // Activity left the badge up. See lib/unread.ts.
    if (s === 'notifications') notifyActivityOpened()
    // Sections are separate pages conceptually; landing halfway down the previous
    // one's scroll position reads as a rendering bug. Skipped when deep-linking:
    // the destination is about to scroll to the item itself.
    if (!t) window.scrollTo({ top: 0 })
  }, [])

  /**
   * A stale tab goes to the LOGIN screen with a note on it — not to a full-screen
   * card of its own.
   *
   * 🔴 A blocking interstitial was the first design and it was too heavy. It
   * interrupts with something the user did not ask about and cannot act on except
   * by obeying it, and for a routine deploy that reads as "the app is broken". The
   * login screen is somewhere people already understand, so putting the notice
   * there costs no extra step: they were going to sign in anyway.
   *
   * `updated` is passed so AuthScreen can show one line instead of the app
   * inventing a new surface for it.
   */
  if (staleVersion) return <AuthScreen updated />

  if (!signedIn) return <AuthScreen />

  return (
    <VoiceProvider>
      <LiveTitle />
      <AppShell section={section} onNavigate={navigate}>
        {/* 🔴 Inside Suspense AND keyed on the section, so a crash on one screen
            does not permanently poison the others: navigating away remounts the
            boundary with fresh state instead of leaving the user stuck on an error
            card for the rest of the session. */}
        <ErrorBoundary key={section}>
        <Suspense fallback={<Spinner />}>
          {section === 'today' && <TodayScreen />}
          {section === 'tasks' && <TasksScreen target={target} />}
          {section === 'calendar' && <CalendarScreen target={target} />}
          {section === 'chat' && <ChatScreen />}
          {section === 'notes' && <NotesScreen />}
          {section === 'personalize' && <PersonalizeScreen />}
          {section === 'team' && <TeamScreen />}
          {section === 'messages' && <MessagesScreen target={target} />}
          {section === 'notifications' && <NotificationsScreen onNavigate={navigate} />}
          {section === 'settings' && <SettingsScreen />}
        </Suspense>
        </ErrorBoundary>
      </AppShell>
    </VoiceProvider>
  )
}

/**
 * Unread count in the tab title.
 *
 * Reads the SAME hook the nav badge uses, so the two can never disagree. It kept
 * its own counter before, which meant a reload reset the title to zero while the
 * badge showed the real number.
 */
function LiveTitle() {
  const unread = useUnreadCount()

  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, '')
    document.title = unread > 0 ? `(${unread}) ${base}` : base
  }, [unread])

  return null
}
