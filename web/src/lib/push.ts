/**
 * Web push: ask the browser for permission, get an FCM token, hand it to the
 * backend. Mirrors what the Flutter app already does on native — same
 * /devices/register endpoint, same DB table, just platform: "web".
 *
 * Best-effort everywhere: a user who never grants permission, or a browser that
 * doesn't support the Push API (older Safari), must never block sign-in or throw
 * where a caller isn't expecting it. The bell/WS/in-app toast paths work
 * regardless — push is additive.
 */
import { useEffect } from 'react'
import { getMessaging, getToken, onMessage, isSupported } from 'firebase/messaging'
import { firebaseApp } from './firebase'
import { devices } from './api'
import { subscribe } from './appSocket'

const K_LAST_TOKEN = 'oscar.web.pushToken'

/** Call after sign-in, once the session has a bearer token. Silently no-ops on an
 *  unsupported browser or a denied/dismissed permission prompt. */
export async function registerPushToken(): Promise<void> {
  try {
    if (!(await isSupported())) return
    if (!('Notification' in window)) return

    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return

    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined
    if (!vapidKey) {
      console.warn('[push] VITE_FIREBASE_VAPID_KEY is not set — cannot register for push')
      return
    }

    const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js')
    const messaging = getMessaging(firebaseApp)
    const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration })
    if (!token) return

    await devices.register(token)
    localStorage.setItem(K_LAST_TOKEN, token)

    // Foreground pushes (tab open and focused) do not go through the service
    // worker's background handler at all — this is the only place they arrive.
    // The app's existing WS/bell path already renders these live; this listener
    // just has to exist so Firebase doesn't warn about an unhandled foreground
    // message, and is a hook point if an in-tab toast is wanted later.
    onMessage(messaging, () => {})
  } catch (e) {
    // Never let a push-setup failure surface as an app error — see module doc.
    console.warn('[push] registration failed', e)
  }
}

/** Call before signOut() clears the bearer token — deactivate() needs it.
 *  Best-effort: a failed deactivate leaves one inert row server-side, not a
 *  broken sign-out. */
export async function deactivatePushToken(): Promise<void> {
  try {
    const token = localStorage.getItem(K_LAST_TOKEN)
    if (!token) return
    await devices.deactivate(token)
    localStorage.removeItem(K_LAST_TOKEN)
  } catch (e) {
    console.warn('[push] deactivate failed', e)
  }
}

/**
 * Foreground beep — the one place this app can guarantee a sound at all.
 *
 * Confirmed live (2026-09-29): a backgrounded tab's OS notification banner plays
 * NO sound on macOS in either Chrome or Safari, with every relevant OS setting
 * (alert sound, alert volume, output volume, permissions) verified correct. The
 * Web Push spec has no `sound` option (Firebase's own WebpushNotification has only
 * setSilent(), never setSound()) — this is a platform limitation, not a config gap,
 * so there is nothing to fix for the backgrounded/closed-tab case. This function
 * covers the one case actually within reach: a tab that is OPEN, where a
 * notification arrives over the already-live WebSocket rather than through the
 * service worker at all — nothing stops us playing our own sound there.
 *
 * Uses the SAME sound the mobile app's native push already plays
 * (assets/sounds/notification.wav in the Flutter app — "mixkit-happy-bells-
 * notification", also bundled at ios/Runner/notification.wav and android's
 * res/raw/notification.wav) — copied into public/notification.wav so web push
 * sounds like the same product instead of an arbitrary generated tone.
 */
const _beep = new Audio('/notification.wav')

export function playForegroundBeep(): void {
  try {
    // Reset so rapid consecutive notifications each get a full beep instead of
    // the second one silently no-op'ing on an already-playing element.
    _beep.currentTime = 0
    void _beep.play().catch(() => { /* autoplay can be blocked before any user
      gesture on this tab — nothing to do, the banner still shows */ })
  } catch { /* never let a sound failure surface as an app error */ }
}

/** Mount once at the app root (alongside useUnreadCount, same lifetime) to beep
 *  on every live `notification.created` frame while this tab is open. */
export function usePushSound(): void {
  useEffect(() => subscribe(f => {
    if (f.type === 'notification.created') playForegroundBeep()
  }), [])
}
