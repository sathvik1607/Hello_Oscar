import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'

/**
 * One fetch per view, with the abort actually wired up.
 *
 * The AbortController is not decoration: without it, a fast navigation lands the
 * previous screen's response in the new screen's state, so Tasks briefly renders
 * Notes' data. It also stops a slow request from resurrecting a screen the user
 * already left.
 */
export function useApi<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: unknown[] = [],
) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // The fetcher is a fresh closure on every render, so it cannot be a dependency
  // without looping. Held in a ref and read at call time instead.
  const fn = useRef(fetcher)
  fn.current = fetcher

  const reload = useCallback(() => setNonce(n => n + 1), [])

  useEffect(() => {
    const ac = new AbortController()
    let alive = true
    setLoading(true)
    setError(null)
    fn.current(ac.signal)
      .then(d => { if (alive) { setData(d); setLoading(false) } })
      .catch((e: unknown) => {
        if ((e as Error)?.name === 'AbortError' || !alive) return
        setError(e instanceof ApiError ? e.message : String(e))
        setLoading(false)
      })
    return () => { alive = false; ac.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps])

  /** Optimistic local edit. Returns the previous value so a failed write can put
   *  it back — an optimistic update with no rollback is just a lie that persists
   *  until the next refetch. */
  const patch = useCallback((fn2: (prev: T) => T) => {
    let prev: T | null = null
    setData(d => { prev = d; return d === null ? d : fn2(d) })
    return prev
  }, [])

  return { data, error, loading, reload, patch, setData }
}
