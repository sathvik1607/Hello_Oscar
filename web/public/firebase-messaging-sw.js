// Background handler for web push — runs while no tab has focus (or none is open
// at all). Foreground pushes (a tab open and focused) are handled in-app instead,
// via onMessage in src/lib/push.ts; this file exists only for the backgrounded case.
//
// Must live at the site root (not under /assets or /src) — the Push API scopes a
// service worker to its own path and everything below it, so a subpath here would
// silently stop receiving pushes fired while the tab is closed.
//
// Firebase config is duplicated here (not imported from src/lib/firebase.ts) on
// purpose: a service worker is not part of the Vite bundle and cannot read
// import.meta.env — it is loaded directly by the browser as a plain script, and
// Firebase's own setup docs use the same literal-values pattern for this file.
// These values are the same non-secret web config as firebase.ts (see that file's
// comment on why the apiKey is safe to inline).

importScripts('https://www.gstatic.com/firebasejs/11.0.2/firebase-app-compat.js')
importScripts('https://www.gstatic.com/firebasejs/11.0.2/firebase-messaging-compat.js')

firebase.initializeApp({
  apiKey: 'AIzaSyABUoTvxYeLgRdydyvdFWcWpHwW8BL4u8c',
  authDomain: 'read-write-test.firebaseapp.com',
  projectId: 'gmail-read-write-test',
  storageBucket: 'gmail-read-write-test.firebasestorage.app',
  messagingSenderId: '28097283362',
  appId: '1:28097283362:web:df69b042d20510b9e0917b',
})

const messaging = firebase.messaging()

// The backend always sends a notification+data hybrid (see
// services/firebase_service.py) — the browser's own push handling already shows
// the `notification` block automatically for a backgrounded page, so this handler
// only needs to exist to route a click back into the app. Re-showing it here too
// would double the banner.
messaging.onBackgroundMessage((payload) => {
  const route = payload.data && payload.data.route ? payload.data.route : '/'
  self._oscarLastRoute = route
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const route = self._oscarLastRoute || '/'
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus()
      }
      if (clients.openWindow) return clients.openWindow(route)
    })
  )
})
