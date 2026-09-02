import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'
import { invalidate, read, write } from './cache'

/**
 * One fetch per view, with the abort wired up and a stale-while-revalidate cache.
 *
 * The AbortController is not decoration: without it a fast navigation lands the
 * previous screen's response in the new screen's state, so Tasks briefly renders
 * Notes' data. It also stops a slow request resurrecting a screen the user left.
 *
 * `cacheKey` is what makes a revisit instant. With one, the last value is rendered
 * immediately and `loading` is false — the screen is populated on arrival and
 * refreshes underneath. Without one, behaviour is exactly as before: skeleton,
 * then data. Screens that must never show a stale row simply omit the key.
 */
export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
  cacheKey?: string,
) {
  const cached = cacheKey ? read<T>(cacheKey) : null

  const [data, setData] = useState<T | null>(cached?.value ?? null)
  const [error, setError] = useState<string | null>(null)
  // Only a cold start is "loading". With a cached value the screen has something
  // to draw, and a skeleton over real content is a flicker, not information.
  const [loading, setLoading] = useState(!cached)
  const [nonce, setNonce] = useState(0)

  // The fetcher is a fresh closure every render, so it cannot be a dependency
  // without looping. Kept in a ref and read at call time; synced in an effect
  // rather than during render, because a discarded render would otherwise leave
  // the ref holding a callback that never committed.
  const fn = useRef(fetcher)
  useEffect(() => { fn.current = fetcher }, [fetcher])

  /**
   * Refetch, and DROP the cached value first.
   *
   * 🔴 Without the invalidate this was a stale-while-revalidate refresh, which is
   * wrong after a MUTATION. The effect re-reads the cache and paints it before the
   * request goes out, so cancelling a task made the row reappear for the length of
   * the round trip: the sheet closed, the task came back, then vanished again ~300ms
   * later. It read as "cancel didn't work", and clicking again did nothing visible
   * because the second cancel was already a no-op.
   *
   * It only ever looked correct because the WS `task.deleted` frame invalidates via
   * useLiveData and usually won the race. So the bug was invisible with a healthy
   * socket and fully present without one — exactly the conditions nobody tests.
   *
   * Stale-while-revalidate is still the behaviour on MOUNT (see the effect below),
   * which is what makes a revisit instant. That is a read; this is a write.
   */
  const reload = useCallback(() => {
    if (cacheKey) invalidate(cacheKey)
    setNonce(n => n + 1)
  }, [cacheKey])

  useEffect(() => {
    const ac = new AbortController()
    let alive = true

    const hit = cacheKey ? read<T>(cacheKey) : null
    if (hit) {
      // Paint what we have before the request goes out.
      setData(hit.value)
      setLoading(false)
    } else {
      setLoading(true)
    }
    setError(null)

    fn.current(ac.signal)
      .then(d => {
        if (!alive) return
        if (cacheKey) write(cacheKey, d)
        setData(d)
        setLoading(false)
      })
      .catch((e: unknown) => {
        if ((e as Error)?.name === 'AbortError' || !alive) return
        // A failed refresh must NOT wipe a good cached value — showing an error
        // where content already was is worse than showing slightly old content.
        // The error surfaces only when there is nothing else to display.
        if (!hit) setError(e instanceof ApiError ? e.message : String(e))
        setLoading(false)
      })

    return () => { alive = false; ac.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, cacheKey, ...deps])

  /** Optimistic local edit. Returns the previous value so a failed write can put it
   *  back — an optimistic update with no rollback is a lie that persists until the
   *  next refetch. The cache is updated too, or navigating away and back would
   *  resurrect the pre-edit row. */
  const patch = useCallback((fn2: (prev: T) => T) => {
    let prev: T | null = null
    setData(d => {
      prev = d
      if (d === null) return d
      const next = fn2(d)
      if (cacheKey) write(cacheKey, next)
      return next
    })
    return prev
  }, [cacheKey])

  return { data, error, loading, reload, patch, setData }
}
