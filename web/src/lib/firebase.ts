/**
 * Firebase app instance, initialized once. Only the web-push (Messaging) SDK is
 * loaded — no Analytics — this app has no use for it and it is a separate SDK/
 * tracking surface the console's default snippet pulls in for free.
 *
 * The config values are NOT secret (Firebase's web `apiKey` is meant to ship in a
 * client bundle; access is governed by Firebase security rules, not by hiding this
 * key) — safe to bake in via VITE_* like every other build-time value in this app.
 */
import { initializeApp, type FirebaseOptions } from 'firebase/app'

const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY as string,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET as string,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID as string,
  appId: import.meta.env.VITE_FIREBASE_APP_ID as string,
}

export const firebaseApp = initializeApp(firebaseConfig)
