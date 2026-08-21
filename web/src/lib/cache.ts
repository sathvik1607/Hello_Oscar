/**
 * A tiny stale-while-revalidate cache.
 *
 * WHY: navigating between sections unmounts the previous screen, so every
 * navigation re-fetched from scratch and showed a skeleton — against a backend
 * whose free-tier instances cold-start for ~50 seconds. Going Tasks → Chat → Tasks
 * meant waiting twice for data that had not changed. The Flutter app does not feel
 * like that because Riverpod keeps provider state alive across tabs.
 *
 * So: render the last value INSTANTLY, then refresh in the background and swap when
 * it lands. The screen is never blank on a revisit, and never stale for long.
 *
 * Deliberately not a library. React Query would do this and more, but it is ~13 kB
 * for a cache with nine keys and no mutations to reconcile — and the interesting
 * behaviour here is invalidation on WebSocket frames, which no library knows about.
 *
 * IN MEMORY ONLY, and that is a decision rather than a shortcut. Task and chat data
 * is another person's data on a shared machine; persisting it to localStorage would
 * leave it readable after sign-out. A reload starting cold is the correct trade.
 */

type Entry = { value: unknown; at: number }

const store = new Map<string, Entry>()

/** How long a cached value may be served before it is considered stale. It is still
 *  SHOWN when stale — that is the point — but a revalidation is guaranteed. */
const FRESH_MS = 30_000

export function read<T>(key: string): { value: T; fresh: boolean } | null {
  const e = store.get(key)
  if (!e) return null
  return { value: e.value as T, fresh: Date.now() - e.at < FRESH_MS }
}

export function write(key: string, value: unknown) {
  store.set(key, { value, at: Date.now() })
}

/**
 * Drop cached values. A bare prefix drops everything under it.
 *
 * Called on sign-out (so the next user cannot see the previous one's rows) and
 * whenever a task/meeting frame arrives — a completed task changes the answer to
 * "my tasks", "today", and the calendar at once, and marking only the screen you
 * are looking at would leave the other two showing a stale list the moment you
 * navigate to them.
 */
export function invalidate(prefix?: string) {
  if (!prefix) { store.clear(); return }
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k)
}
