import { useEffect, useRef } from 'react'
import { onRecovered, subscribe } from './appSocket'
import { invalidate } from './cache'

/**
 * "Keep this screen honest."
 *
 * Two things every list-bearing screen needs, and they are easy to get half-right:
 *
 *  1. **Live frames** — react to what the server pushes while you are looking.
 *  2. **Recovery** — refetch after a dropped connection, because the frames sent
 *     during the drop are GONE. The backend replays only unread direct messages;
 *     everything else is lost. A screen with (1) and not (2) is stale exactly when
 *     the network was worst, and shows no sign of it.
 *
 * Debounced, because one user action produces several frames: completing a subtask
 * updates its parent, a bulk reschedule fires per item, and the overnight rollover
 * re-dates every overdue task at once. Reloading per frame means a dozen identical
 * requests and a list that visibly reshuffles a dozen times.
 */
export function useLiveData(
  types: readonly string[],
  reload: () => void,
  { debounceMs = 300, invalidatePrefixes = [] as readonly string[] } = {},
) {
  // Synced in an effect rather than assigned during render: a discarded render
  // would otherwise leave the ref holding a callback that never committed.
  const cb = useRef(reload)
  useEffect(() => { cb.current = reload }, [reload])

  const key = types.join(',')
  const prefixes = invalidatePrefixes.join(',')

  useEffect(() => {
    let timer: number | undefined

    const fire = () => {
      // Shared caches are dropped BEFORE reloading, or a screen that is not mounted
      // serves a stale value the moment you navigate to it.
      for (const p of prefixes ? prefixes.split(',') : []) invalidate(p)
      cb.current()
    }
    const schedule = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(fire, debounceMs) as unknown as number
    }

    const wanted = new Set(key.split(','))
    const unsubFrames = subscribe(f => {
      if (wanted.has(f.type) || wanted.has(prefixOf(f.type))) schedule()
    })
    // Recovery is NOT debounced through the same path — it fires immediately,
    // because by then the user has already been looking at stale data.
    const unsubRecovery = onRecovered(fire)

    return () => {
      if (timer) clearTimeout(timer)
      unsubFrames()
      unsubRecovery()
    }
  }, [key, prefixes, debounceMs])
}

/** `task.completed` → `task.*`, so a caller can subscribe to a whole family
 *  instead of listing every operation and forgetting one. */
function prefixOf(type: string): string {
  const i = type.indexOf('.')
  return i === -1 ? type : `${type.slice(0, i)}.*`
}

/** Everything that changes a task or a meeting. */
export const ITEM_FRAMES = ['task.*', 'meeting.*'] as const
export const ITEM_CACHES = ['tasks:', 'meetings:'] as const
